/**
 * Derive a disappearance ("exit") report from `units.last_seen_at`.
 *
 * Every Phase B sweep bumps `last_seen_at` to the run date for every unit it
 * observes (see `docs/design/sparse-observations.md`). A unit still in
 * `units.csv` whose `last_seen_at` lags the latest sweep date was therefore
 * *not* returned by the MAR tool in the latest run — it has disappeared from
 * `gvMarData`. That signals a possible demolition, a full exemption, an
 * address/label change, or (more mundanely) a scrape gap — cross-check
 * rentcontroldocs.santamonica.gov before drawing conclusions.
 *
 * Per the design, exits are surfaced as a *derived report*, never written back
 * into the observation log as tombstone rows (the log stays MAR-changes-only).
 * Each exit carries the unit's last known MAR/tenancy (carry-forward) so the
 * report is self-contained.
 *
 * This is the third leg of attribution alongside `npm run changes` (rent moves)
 * and `npm run reconcile` (registry vs RCB headline). Regenerate after each
 * sweep; never a source of truth.
 *
 * Run: `npm run exits`
 */
import { join } from "node:path";
import { readCsv, writeCsvSorted, type Row } from "../csv.ts";
import { latestObservations } from "../sparse.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const DATA_DIR = join(REPO_ROOT, "data");
const UNITS_CSV = join(DATA_DIR, "units.csv");
const OBS_CSV = join(DATA_DIR, "mar_observations.csv");
const SWEEPS_CSV = join(DATA_DIR, "sweeps.csv");
const EXITS_CSV = join(DATA_DIR, "derived", "unit_exits.csv");

const EXIT_HEADERS = [
  "unit_id",
  "apn",
  "address",
  "unit_label",
  "bedrooms",
  "first_seen_at",
  "last_seen_at",
  "latest_sweep",
  "sweeps_missed",
  "last_mar_cents",
  "last_tenancy",
];

const g = (r: Row, k: string): string => (r[k] ?? "").trim();

export type Exit = {
  unit_id: string;
  apn: string;
  address: string;
  unit_label: string;
  bedrooms: string;
  first_seen_at: string;
  last_seen_at: string;
  latest_sweep: string;
  /** How many recorded sweeps occurred after this unit was last seen ("" if no sweeps log). */
  sweeps_missed: number | "";
  last_mar_cents: number;
  last_tenancy: string;
};

/**
 * The most-recent sweep date — the high-water mark a unit's `last_seen_at` is
 * judged against. Taken as the max over both observed units and the sweeps log
 * so it is correct whether or not `sweeps.csv` exists yet.
 */
export function latestSweepDate(units: Row[], sweeps: Row[]): string {
  let max = "";
  for (const u of units) {
    const d = g(u, "last_seen_at");
    if (d > max) max = d;
  }
  for (const s of sweeps) {
    const d = g(s, "sweep_date");
    if (d > max) max = d;
  }
  return max;
}

/**
 * Units present in `units.csv` whose `last_seen_at` predates the latest sweep —
 * i.e. they were not observed in the most recent run. Each is annotated with its
 * last known MAR/tenancy (carry-forward) and how many sweeps it has missed.
 */
export function deriveExits(units: Row[], obs: Row[], sweeps: Row[]): Exit[] {
  const latest = latestSweepDate(units, sweeps);
  if (latest === "") return [];
  // Latest observation per unit (asOf far in the future → includes every row).
  const lastObs = latestObservations(obs, "9999-12-31");
  const sweepDates = sweeps
    .map((s) => g(s, "sweep_date"))
    .filter((d) => d !== "");

  const exits: Exit[] = [];
  for (const u of units) {
    const lastSeen = g(u, "last_seen_at");
    // Skip units seen in the latest sweep, and rows with no last_seen_at (legacy
    // / pre-migration) which we can't judge.
    if (lastSeen === "" || lastSeen >= latest) continue;
    const o = lastObs.get(g(u, "unit_id"));
    exits.push({
      unit_id: g(u, "unit_id"),
      apn: g(u, "apn"),
      address: g(u, "address"),
      unit_label: g(u, "unit_label"),
      bedrooms: g(u, "bedrooms"),
      first_seen_at: g(u, "first_seen_at"),
      last_seen_at: lastSeen,
      latest_sweep: latest,
      sweeps_missed:
        sweepDates.length > 0
          ? sweepDates.filter((d) => d > lastSeen).length
          : "",
      last_mar_cents: o ? parseInt(o.mar_amount_cents || "0", 10) : 0,
      last_tenancy: o ? o.tenancy_date : "",
    });
  }
  return exits;
}

function main(): void {
  const units = readCsv(UNITS_CSV);
  if (units.length === 0) {
    throw new Error(`No units at ${UNITS_CSV} — run the scraper first.`);
  }
  const obs = readCsv(OBS_CSV);
  const sweeps = readCsv(SWEEPS_CSV);
  const latest = latestSweepDate(units, sweeps);
  const exits = deriveExits(units, obs, sweeps);

  const rows: Row[] = exits.map((e) => ({
    unit_id: e.unit_id,
    apn: e.apn,
    address: e.address,
    unit_label: e.unit_label,
    bedrooms: e.bedrooms,
    first_seen_at: e.first_seen_at,
    last_seen_at: e.last_seen_at,
    latest_sweep: e.latest_sweep,
    sweeps_missed: String(e.sweeps_missed),
    last_mar_cents: String(e.last_mar_cents),
    last_tenancy: e.last_tenancy,
  }));
  writeCsvSorted(EXITS_CSV, EXIT_HEADERS, rows, ["unit_id"]);

  console.log("unit exit report — disappeared from the latest sweep");
  console.log(`  latest sweep date ......... ${latest || "(none)"}`);
  console.log(`  units in registry ......... ${units.length}`);
  console.log(`  exited (last_seen lag) .... ${exits.length}`);
  if (exits.length === 0) {
    console.log("  (none — every unit was seen in the latest sweep)");
  }
  console.log(`  wrote ${EXITS_CSV}`);
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
