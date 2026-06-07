/**
 * Derive a month-over-month rent-change report from the event-sourced
 * `mar_observations.csv` change log.
 *
 * The observation table records one row per *change* (see
 * `docs/design/sparse-observations.md`). This module turns each adjacent pair of
 * a unit's observations into a human-readable change event: what the rent moved
 * from, to, by how much, and *why* — split exactly the way rent moves in this
 * system: a **new tenancy** (the `tenancy_date` reset) or an **MAR adjustment**
 * (the ceiling changed under a sitting tenant — General Adjustment or a Board
 * order). No formula or GA table is involved: attribution is read straight off
 * whether the tenancy date moved, so it can't drift with CPI or ballot changes.
 *
 * Exempt transitions ($0 ⇄ positive MAR) are flagged separately in
 * `mar_status_change` so the reason stays the clean new_tenancy/mar_adjustment
 * binary while the exemption signal isn't lost.
 *
 * This is a *derived* artifact — regenerate after each sweep; never a source of
 * truth. A unit's first observation is a baseline, not a change, so it emits no
 * row. Disappearances (units gone from a sweep) are a separate signal derived
 * from `units.last_seen_at`, not from this log.
 *
 * Run: `npm run changes`
 */
import { join } from "node:path";
import { readCsv, writeCsvSorted, type Row } from "../csv.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const DATA_DIR = join(REPO_ROOT, "data");
const OBS_CSV = join(DATA_DIR, "mar_observations.csv");
const UNITS_CSV = join(DATA_DIR, "units.csv");
const CHANGES_CSV = join(DATA_DIR, "derived", "mar_changes.csv");

const CHANGE_HEADERS = [
  "unit_id",
  "apn",
  "address",
  "unit_label",
  "prev_observed_at",
  "observed_at",
  "old_mar_cents",
  "new_mar_cents",
  "delta_cents",
  "delta_pct",
  "old_tenancy",
  "new_tenancy",
  "reason",
  "mar_status_change",
];

const g = (r: Row, k: string): string => (r[k] ?? "").trim();

/** The two ways rent moves in this system. */
export type ChangeReason = "new_tenancy" | "mar_adjustment";
/** Exempt-status transitions, tracked alongside the reason. */
export type MarStatusChange = "" | "became_exempt" | "reinstated";

export type Change = {
  unit_id: string;
  prev_observed_at: string;
  observed_at: string;
  old_mar_cents: number;
  new_mar_cents: number;
  old_tenancy: string;
  new_tenancy: string;
  reason: ChangeReason;
  mar_status_change: MarStatusChange;
};

/**
 * Attribute a single change. A moved `tenancy_date` means a fresh tenancy reset
 * the rent; otherwise the ceiling moved under a sitting tenant (GA or Board
 * order). Exempt transitions are reported in `mar_status_change`, not folded
 * into the reason.
 */
export function classifyChange(prev: Row, cur: Row): {
  reason: ChangeReason;
  mar_status_change: MarStatusChange;
} {
  const oldMar = parseInt(g(prev, "mar_amount_cents") || "0", 10);
  const newMar = parseInt(g(cur, "mar_amount_cents") || "0", 10);
  const reason: ChangeReason =
    g(prev, "tenancy_date") !== g(cur, "tenancy_date")
      ? "new_tenancy"
      : "mar_adjustment";
  let mar_status_change: MarStatusChange = "";
  if (oldMar > 0 && newMar === 0) mar_status_change = "became_exempt";
  else if (oldMar === 0 && newMar > 0) mar_status_change = "reinstated";
  return { reason, mar_status_change };
}

/**
 * Turn the observation log into a flat list of change events. Observations are
 * grouped by unit and ordered by date; each adjacent pair yields one change
 * (the first observation per unit is a baseline and yields none).
 */
export function deriveChanges(obs: Row[]): Change[] {
  const byUnit = new Map<string, Row[]>();
  for (const o of obs) {
    const id = g(o, "unit_id");
    if (!id) continue;
    (byUnit.get(id) ?? byUnit.set(id, []).get(id)!).push(o);
  }
  const changes: Change[] = [];
  for (const [unit_id, rows] of byUnit) {
    rows.sort((a, b) => g(a, "observed_at").localeCompare(g(b, "observed_at")));
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]!;
      const cur = rows[i]!;
      const { reason, mar_status_change } = classifyChange(prev, cur);
      changes.push({
        unit_id,
        prev_observed_at: g(prev, "observed_at"),
        observed_at: g(cur, "observed_at"),
        old_mar_cents: parseInt(g(prev, "mar_amount_cents") || "0", 10),
        new_mar_cents: parseInt(g(cur, "mar_amount_cents") || "0", 10),
        old_tenancy: g(prev, "tenancy_date"),
        new_tenancy: g(cur, "tenancy_date"),
        reason,
        mar_status_change,
      });
    }
  }
  return changes;
}

function pct(from: number, to: number): string {
  if (from === 0) return ""; // undefined growth from an exempt/zero base
  return (((to - from) / from) * 100).toFixed(1);
}

function main(): void {
  const obs = readCsv(OBS_CSV);
  if (obs.length === 0) {
    throw new Error(`No observations at ${OBS_CSV} — run the scraper first.`);
  }
  const units = readCsv(UNITS_CSV);
  const unitById = new Map<string, Row>();
  for (const u of units) unitById.set(g(u, "unit_id"), u);

  const changes = deriveChanges(obs);
  const rows: Row[] = changes.map((c) => {
    const u = unitById.get(c.unit_id);
    return {
      unit_id: c.unit_id,
      apn: u ? g(u, "apn") : "",
      address: u ? g(u, "address") : "",
      unit_label: u ? g(u, "unit_label") : "",
      prev_observed_at: c.prev_observed_at,
      observed_at: c.observed_at,
      old_mar_cents: String(c.old_mar_cents),
      new_mar_cents: String(c.new_mar_cents),
      delta_cents: String(c.new_mar_cents - c.old_mar_cents),
      delta_pct: pct(c.old_mar_cents, c.new_mar_cents),
      old_tenancy: c.old_tenancy,
      new_tenancy: c.new_tenancy,
      reason: c.reason,
      mar_status_change: c.mar_status_change,
    };
  });
  writeCsvSorted(CHANGES_CSV, CHANGE_HEADERS, rows, ["unit_id", "observed_at"]);

  // Summary.
  const tally = (pred: (c: Change) => boolean) => changes.filter(pred).length;
  const newTenancy = tally((c) => c.reason === "new_tenancy");
  const marAdj = tally((c) => c.reason === "mar_adjustment");
  const exempt = tally((c) => c.mar_status_change === "became_exempt");
  const reinstated = tally((c) => c.mar_status_change === "reinstated");
  const increases = changes.filter((c) => c.new_mar_cents > c.old_mar_cents);
  const decreases = changes.filter((c) => c.new_mar_cents < c.old_mar_cents);

  console.log("mar change report — derived from the observation change log");
  console.log(`  change events ............. ${changes.length}`);
  console.log(`    new tenancy ............. ${newTenancy}`);
  console.log(`    MAR adjustment .......... ${marAdj}`);
  console.log(`  became exempt ($0) ........ ${exempt}`);
  console.log(`  reinstated (back to >$0) .. ${reinstated}`);
  console.log(`  MAR increases ............. ${increases.length}`);
  console.log(`  MAR decreases ............. ${decreases.length}`);
  console.log(`  wrote ${CHANGES_CSV}`);
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
