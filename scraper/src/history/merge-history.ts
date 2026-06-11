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
  if (!unit || !/^\d{4}$/.test(year) || (r.mar_cents ?? "") === "") return [];
  const y = Number(year);
  const gaDate = `${y - 1}-09-01`;
  // A report can't establish a MAR after its own Sep-1, and rent-control tenancies
  // don't predate the late-1970s. Reject OCR-garbled dates outside that window
  // (e.g. a misread 2-digit year "…/29" → 2029) so they neither pollute the
  // tenancy_date field nor push observed_at into the future.
  let tenancy = r.market_rate_established ?? "";
  if (tenancy && (tenancy > `${y}-09-01` || tenancy < "1971-01-01")) tenancy = "";
  // The current-MAR ceiling takes effect Sep 1 of Y-1 unless the tenancy reset
  // more recently (mid-year re-rental); take the later so observed_at is never
  // earlier than the tenancy it reflects, and never beyond the report's period.
  const observed_at = tenancy && tenancy > gaDate ? tenancy : gaDate;
  return [{ unit_id: unit, observed_at, mar: r.mar_cents!, tenancy, source: SOURCE_PORTAL }];
}

/**
 * Build the prepend rows for one unit: backfilled observations strictly before
 * the unit's earliest existing observation, collapsed to change-log semantics
 * (keep a row only when (mar, tenancy) differs from the previously-kept value),
 * with the final row dropped if it merely restates the existing baseline.
 */
/**
 * Merge one unit's authoritative observations (the MAR-tool sweeps / open-data
 * anchors) with its portal-derived candidates into a single change-log. Walks
 * both sets in date order and keeps a row only when (mar, tenancy) differs from
 * the previously-kept value — so unchanged years collapse. Authoritative rows are
 * NEVER dropped and win ties: when a portal row carries a value already in effect
 * at an authoritative row's date, the authoritative row supersedes it (we keep
 * the real observation date + provenance). Portal rows survive wherever they
 * introduce a value the sweeps didn't capture — both before the first sweep
 * (deep 2013→2023 history) AND in the gaps between sweeps (e.g. the Sep-2023 /
 * Sep-2024 GA ceilings that fall between the 2023-07-19 and 2026-06-07 anchors).
 */
export function mergeUnitTimeline(existing: Obs[], portal: Obs[]): Obs[] {
  const isAuth = (o: Obs): boolean => o.source !== SOURCE_PORTAL;
  const combined = [...existing, ...portal].sort((a, b) => {
    if (a.observed_at !== b.observed_at) return a.observed_at.localeCompare(b.observed_at);
    return Number(isAuth(b)) - Number(isAuth(a)); // authoritative first on a tie
  });
  const kept: Obs[] = [];
  for (const o of combined) {
    const last = kept[kept.length - 1];
    if (!last || last.mar !== o.mar || last.tenancy !== o.tenancy) {
      kept.push(o);
    } else if (isAuth(o) && !isAuth(last)) {
      kept[kept.length - 1] = o; // same value — prefer the authoritative observation
    }
    // else: redundant carry-forward — drop
  }
  return kept;
}

export type MergePlan = {
  obsRows: Row[];
  added: number; // portal rows kept (the deepening)
  unitsDeepened: number;
  inEraRefined: number; // portal rows kept at/after a unit's first sweep (gap refinement)
  orphanUnits: number;
};

export function buildMergePlan(existingObs: Row[], history: Row[], registryUnitIds: Set<string>): MergePlan {
  const toObs = (o: Row): Obs => ({
    unit_id: o.unit_id ?? "",
    observed_at: o.observed_at ?? "",
    mar: o.mar_amount_cents ?? "",
    tenancy: o.tenancy_date ?? "",
    source: o.source && o.source !== "" ? o.source : SOURCE_MAR_TOOL,
  });

  // Existing (authoritative) observations grouped by unit, + each unit's earliest date.
  const existingByUnit = new Map<string, Obs[]>();
  const earliestAt = new Map<string, string>();
  for (const r of existingObs) {
    const o = toObs(r);
    (existingByUnit.get(o.unit_id) ?? existingByUnit.set(o.unit_id, []).get(o.unit_id)!).push(o);
    const cur = earliestAt.get(o.unit_id);
    if (cur === undefined || o.observed_at < cur) earliestAt.set(o.unit_id, o.observed_at);
  }

  // Portal candidates grouped by registry unit; non-registry units are orphans.
  const portalByUnit = new Map<string, Obs[]>();
  const orphan = new Set<string>();
  for (const r of history) {
    for (const o of historyToObs(r)) {
      if (!registryUnitIds.has(o.unit_id)) {
        orphan.add(o.unit_id);
        continue;
      }
      (portalByUnit.get(o.unit_id) ?? portalByUnit.set(o.unit_id, []).get(o.unit_id)!).push(o);
    }
  }

  const obsRows: Row[] = [];
  let added = 0;
  let unitsDeepened = 0;
  let inEraRefined = 0;
  const allUnits = new Set([...existingByUnit.keys(), ...portalByUnit.keys()]);
  for (const unit of allUnits) {
    const ex = existingByUnit.get(unit) ?? [];
    const po = portalByUnit.get(unit);
    const merged = po ? mergeUnitTimeline(ex, po) : ex;
    let unitPortalKept = 0;
    const cutoff = earliestAt.get(unit) ?? "9999-12-31";
    for (const o of merged) {
      obsRows.push({
        unit_id: o.unit_id,
        observed_at: o.observed_at,
        mar_amount_cents: o.mar,
        tenancy_date: o.tenancy,
        source: o.source,
      });
      if (o.source === SOURCE_PORTAL) {
        unitPortalKept++;
        if (o.observed_at >= cutoff) inEraRefined++;
      }
    }
    added += unitPortalKept;
    if (unitPortalKept > 0) unitsDeepened++;
  }

  return { obsRows, added, unitsDeepened, inEraRefined, orphanUnits: orphan.size };
}

/**
 * Phase 4 of the backfill: fold OCR'd history into mar_observations.csv as
 * additional change rows via a full per-unit timeline merge (deep pre-2023
 * history + gap refinement between sweeps; authoritative sweeps preserved),
 * adding a `source` provenance column. Dry-run by default — prints the plan and
 * writes a preview to data/history/mar_observations.preview.csv; `--write` applies.
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
      inEraRefined: plan.inEraRefined,
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
