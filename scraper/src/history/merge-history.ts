import { join } from "node:path";
import { readCsv, writeCsvSorted, type Row } from "../csv.ts";
import { logger } from "../logger.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const DATA_DIR = join(REPO_ROOT, "data");
const MAR_HISTORY_CSV = join(DATA_DIR, "history", "mar_history.csv");
const OBS_CSV = join(DATA_DIR, "mar_observations.csv");
const UNITS_CSV = join(DATA_DIR, "units.csv");

// mar_observations.csv gains a provenance column so portal-derived rows are
// distinguishable from MAR-tool sweeps. Readers key by column name and ignore
// unknown columns, so this is a non-breaking addition (writers updated in lockstep).
export const OBS_HEADERS = [
  "unit_id",
  "observed_at",
  "mar_amount_cents",
  "tenancy_date",
  "source",
];
export const SOURCE_MAR_TOOL = "mar_tool";
export const SOURCE_PORTAL = "portal_mar_report";

type Obs = { unit_id: string; observed_at: string; mar: string; tenancy: string; source: string };

/**
 * Synthetic observation from one mar_history row. An annual report for year Y
 * lists the unit's *current* MAR (`mar_cents`) — the post-GA ceiling that took
 * effect on September 1 of Y-1 and is in force when the report is mailed (~June
 * Y). We derive the observation from this column only: it is the reliable,
 * monotonic field (the report's separate "new MAR as of Sep 1, Y" column OCRs
 * less cleanly and would double-count the same ceiling a year early). The change
 * is dated to its true effective date, `${Y-1}-09-01`; the precise tenancy reset
 * date is carried separately in `tenancy`. The downstream change-log collapse
 * keeps a row only when (mar, tenancy) actually moved.
 */
export function historyToObs(r: Row): Obs[] {
  const unit = r.unit_id ?? "";
  const year = r.report_year ?? "";
  const tenancy = r.market_rate_established ?? "";
  if (!unit || !/^\d{4}$/.test(year) || (r.mar_cents ?? "") === "") return [];
  // The current-MAR ceiling takes effect on Sep 1 of Y-1 *unless* the unit's
  // tenancy reset more recently (a mid-year re-rental), in which case that reset
  // is when this MAR was established. Take the later of the two so observed_at is
  // never earlier than the tenancy it reflects.
  const gaDate = `${Number(year) - 1}-09-01`;
  const observed_at = tenancy && tenancy > gaDate ? tenancy : gaDate;
  return [{ unit_id: unit, observed_at, mar: r.mar_cents!, tenancy, source: SOURCE_PORTAL }];
}

/**
 * Build the prepend rows for one unit: backfilled observations strictly before
 * the unit's earliest existing observation, collapsed to change-log semantics
 * (keep a row only when (mar, tenancy) differs from the previously-kept value),
 * with the final row dropped if it merely restates the existing baseline.
 */
export function prependChain(
  candidates: Obs[],
  earliestExisting: string,
  baselineValue: { mar: string; tenancy: string } | null,
): Obs[] {
  const before = candidates
    .filter((c) => c.observed_at < earliestExisting)
    .sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  const kept: Obs[] = [];
  let last: { mar: string; tenancy: string } | null = null;
  for (const c of before) {
    if (last && last.mar === c.mar && last.tenancy === c.tenancy) continue;
    kept.push(c);
    last = { mar: c.mar, tenancy: c.tenancy };
  }
  // Drop a trailing backfill row that merely restates the existing baseline.
  while (
    kept.length > 0 &&
    baselineValue &&
    kept[kept.length - 1]!.mar === baselineValue.mar &&
    kept[kept.length - 1]!.tenancy === baselineValue.tenancy
  ) {
    kept.pop();
  }
  return kept;
}

export type MergePlan = {
  obsRows: Row[];
  added: number;
  unitsDeepened: number;
  skippedInObservedEra: number;
  orphanUnits: number;
};

export function buildMergePlan(existingObs: Row[], history: Row[], registryUnitIds: Set<string>): MergePlan {
  // Existing timeline per unit + each unit's earliest observation (+ its value).
  const earliest = new Map<string, { at: string; mar: string; tenancy: string }>();
  for (const o of existingObs) {
    const id = o.unit_id ?? "";
    const at = o.observed_at ?? "";
    const cur = earliest.get(id);
    if (!cur || at < cur.at) {
      earliest.set(id, { at, mar: o.mar_amount_cents ?? "", tenancy: o.tenancy_date ?? "" });
    }
  }

  // Group backfill candidates by unit.
  const candByUnit = new Map<string, Obs[]>();
  let orphanUnits = 0;
  const seenOrphan = new Set<string>();
  for (const r of history) {
    const obs = historyToObs(r);
    for (const o of obs) {
      if (!registryUnitIds.has(o.unit_id)) {
        if (!seenOrphan.has(o.unit_id)) { seenOrphan.add(o.unit_id); orphanUnits++; }
        continue;
      }
      const arr = candByUnit.get(o.unit_id) ?? [];
      arr.push(o);
      candByUnit.set(o.unit_id, arr);
    }
  }

  const added: Obs[] = [];
  let unitsDeepened = 0;
  let skippedInObservedEra = 0;
  for (const [unit, cands] of candByUnit) {
    const base = earliest.get(unit);
    // A unit with no existing observation shouldn't happen (registry units all
    // carry a 2023 baseline), but if so, treat all candidates as prependable.
    const cutoff = base?.at ?? "9999-12-31";
    skippedInObservedEra += cands.filter((c) => c.observed_at >= cutoff).length;
    const chain = prependChain(cands, cutoff, base ? { mar: base.mar, tenancy: base.tenancy } : null);
    if (chain.length > 0) {
      added.push(...chain);
      unitsDeepened++;
    }
  }

  // Assemble the full file: existing rows (stamped mar_tool if unsourced) + added.
  const obsRows: Row[] = existingObs.map((o) => ({
    unit_id: o.unit_id ?? "",
    observed_at: o.observed_at ?? "",
    mar_amount_cents: o.mar_amount_cents ?? "",
    tenancy_date: o.tenancy_date ?? "",
    source: o.source && o.source !== "" ? o.source : SOURCE_MAR_TOOL,
  }));
  for (const a of added) {
    obsRows.push({
      unit_id: a.unit_id,
      observed_at: a.observed_at,
      mar_amount_cents: a.mar,
      tenancy_date: a.tenancy,
      source: a.source,
    });
  }
  return { obsRows, added: added.length, unitsDeepened, skippedInObservedEra, orphanUnits };
}

/**
 * Phase 4 of the backfill: fold OCR'd history into mar_observations.csv as earlier
 * change rows (prepended before each unit's first direct observation), adding a
 * `source` provenance column. Dry-run by default — prints the plan and writes a
 * preview to data/history/mar_observations.preview.csv; pass `--write` to apply.
 */
export async function historyMerge(): Promise<void> {
  const write = process.argv.includes("--write");
  const existingObs = readCsv(OBS_CSV);
  const history = readCsv(MAR_HISTORY_CSV);
  if (history.length === 0) {
    throw new Error("data/history/mar_history.csv is empty. Run `history-ocr` first.");
  }
  const registryUnitIds = new Set(readCsv(UNITS_CSV).map((u) => u.unit_id ?? ""));

  const plan = buildMergePlan(existingObs, history, registryUnitIds);
  logger.info(
    {
      existingRows: existingObs.length,
      historyRows: history.length,
      added: plan.added,
      unitsDeepened: plan.unitsDeepened,
      skippedInObservedEra: plan.skippedInObservedEra,
      orphanUnits: plan.orphanUnits,
      newTotal: plan.obsRows.length,
      mode: write ? "WRITE" : "dry-run",
    },
    "history.merge.plan",
  );

  const target = write ? OBS_CSV : join(DATA_DIR, "history", "mar_observations.preview.csv");
  writeCsvSorted(target, OBS_HEADERS, plan.obsRows, ["unit_id", "observed_at"]);
  logger.info({ target, write }, write ? "history.merge.written" : "history.merge.preview");
  if (!write) {
    logger.info({}, "history.merge.dry_run — re-run with --write to apply to mar_observations.csv");
  }
}
