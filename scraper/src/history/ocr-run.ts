import { join } from "node:path";
import { existsSync } from "node:fs";
import { readCsv, writeCsvSorted, type Row } from "../csv.ts";
import { logger } from "../logger.ts";
import { createOcrScheduler, ocrReport, type UnitRecord } from "./ocr-report.ts";
import { pdfPath } from "./fetch-docs.ts";
import { buildUnitResolver } from "./resolve-unit.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const DATA_DIR = join(REPO_ROOT, "data");
const DOC_INDEX_CSV = join(DATA_DIR, "history", "doc_index.csv");
const MAR_HISTORY_CSV = join(DATA_DIR, "history", "mar_history.csv");
const OBS_CSV = join(DATA_DIR, "mar_observations.csv");
const UNITS_CSV = join(DATA_DIR, "units.csv");

export const MAR_HISTORY_HEADERS = [
  "parcel",
  "infor_id",
  "unit_id",
  "unit_label_raw",
  "report_year",
  "market_rate_established",
  "mar_cents",
  "ga_cents",
  "new_mar_cents",
  "source_handle",
];

// Only the annual MAR report carries the per-unit grid this parser understands.
// Tenancy registrations / final rent printouts have different layouts (future work).
const OCR_TYPE = "MAR REPORT";
const OCR_DETAIL = "ANNUAL MAR REPORT";

// QA gate: the fraction of reconcilable units whose report MAR must match the
// registry anchor for the run to be trusted. The spike validated 10/10.
const QA_MIN_MATCH_RATE = 0.85;

type IndexedDoc = { handle: string; year: string };

/** Distinct annual-report handles that have a fetched PDF on disk. */
export function reportsToOcr(index: Row[]): IndexedDoc[] {
  const byHandle = new Map<string, IndexedDoc>();
  for (const r of index) {
    if (r.doc_type !== OCR_TYPE || r.doc_detail !== OCR_DETAIL) continue;
    const handle = r.handle ?? "";
    if (!handle || byHandle.has(handle)) continue;
    if (!existsSync(pdfPath(handle))) continue;
    byHandle.set(handle, { handle, year: r.doc_year ?? "" });
  }
  return [...byHandle.values()];
}

/** Dedup records by (parcel, unit_id, report_year); first non-empty wins, warn on conflict. */
export function dedupRecords(records: Array<UnitRecord & { source_handle: string }>): {
  rows: Row[];
  conflicts: number;
} {
  const byKey = new Map<string, UnitRecord & { source_handle: string }>();
  let conflicts = 0;
  for (const rec of records) {
    if (!rec.parcel || !rec.unit_id || !rec.report_year) continue;
    const key = `${rec.parcel}|${rec.unit_id}|${rec.report_year}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, rec);
    } else if (prev.mar_cents !== rec.mar_cents || prev.new_mar_cents !== rec.new_mar_cents) {
      conflicts++;
    }
  }
  const rows = [...byKey.values()].map((r) => ({
    parcel: r.parcel,
    infor_id: r.infor_id,
    unit_id: r.unit_id,
    unit_label_raw: r.unit_label_raw,
    report_year: r.report_year,
    market_rate_established: r.market_rate_established,
    mar_cents: r.mar_cents,
    ga_cents: r.ga_cents,
    new_mar_cents: r.new_mar_cents,
    source_handle: r.source_handle,
  }));
  return { rows, conflicts };
}

/** Registry MAR per unit carried forward to `cutoff` (latest observation <= cutoff). */
function registryAsOfDate(obs: Row[], cutoff: string): Map<string, string> {
  const latestDate = new Map<string, string>();
  const mar = new Map<string, string>();
  for (const o of obs) {
    const at = o.observed_at ?? "";
    if (at > cutoff) continue;
    const id = o.unit_id ?? "";
    const prev = latestDate.get(id);
    if (prev !== undefined && at <= prev) continue;
    latestDate.set(id, at);
    mar.set(id, o.mar_amount_cents ?? "");
  }
  return mar;
}

/**
 * QA gate — period-aligned reconciliation. The registry holds only a few true
 * instants (e.g. the 2023-07-19 baseline and the 2026-06-07 sweep), so we can
 * only validate the report columns that align to those instants:
 *
 *  - A snapshot taken BEFORE Sep 1 of year Y reflects the post-(Y-1)-GA ceiling,
 *    which is report Y's "current MAR" column (== report Y-1's "new MAR"). So we
 *    compare it to report[Y].mar_cents, falling back to report[Y-1].new_mar_cents
 *    when there is no report for Y itself (e.g. the 2026 sweep → the 2025 report's
 *    new MAR).
 *  - A snapshot taken ON/AFTER Sep 1 reflects report Y's post-GA "new MAR".
 *
 * Anchors are derived from the registry's own min/max observation dates so the
 * gate adapts automatically as future sweeps are added. Reports for years with no
 * registry instant (2013–2022, 2024) are simply not checkable here — that's the
 * gap the backfill exists to fill, not an error.
 */
export function qaReconcile(
  rows: Row[],
  obs: Row[],
): { compared: number; matched: number; rate: number; mismatches: string[] } {
  // Per-unit report lookup: "<unit>|<year>" → {mar, new}.
  const report = new Map<string, { mar: string; new: string }>();
  for (const r of rows) {
    report.set(`${r.unit_id}|${r.report_year}`, {
      mar: r.mar_cents ?? "",
      new: r.new_mar_cents ?? "",
    });
  }

  const dates = [...new Set(obs.map((o) => o.observed_at ?? "").filter(Boolean))].sort();
  if (dates.length === 0) return { compared: 0, matched: 0, rate: 1, mismatches: [] };
  const anchors = [...new Set([dates[0]!, dates[dates.length - 1]!])];

  let compared = 0;
  let matched = 0;
  const mismatches: string[] = [];
  for (const d of anchors) {
    const y = Number(d.slice(0, 4));
    const beforeSep = Number(d.slice(5, 7)) < 9;
    const asOf = registryAsOfDate(obs, d);
    for (const [unit, reg] of asOf) {
      if (reg === "" || reg === "0") continue; // exempt/blank → not comparable
      const exp = beforeSep
        ? (report.get(`${unit}|${y}`)?.mar ?? report.get(`${unit}|${y - 1}`)?.new)
        : report.get(`${unit}|${y}`)?.new;
      if (exp === undefined || exp === "") continue; // no period-aligned report column
      compared++;
      if (exp === reg) matched++;
      else if (mismatches.length < 40) {
        mismatches.push(`${unit} @${d}: report=${exp} registry=${reg}`);
      }
    }
  }
  return { compared, matched, rate: compared ? matched / compared : 1, mismatches };
}

/**
 * Phase 3 of the backfill: OCR each fetched annual MAR report's grid into
 * data/history/mar_history.csv (one row per parcel-unit-year), keying rows off
 * the in-table Parcel # and deduping by (parcel, unit, year). Fails loud if the
 * QA reconciliation against registry anchors drops below the threshold.
 */
export async function historyOcr(): Promise<void> {
  const index = readCsv(DOC_INDEX_CSV);
  if (index.length === 0) {
    throw new Error("data/history/doc_index.csv is empty. Run `history-index` first.");
  }
  const targets = reportsToOcr(index);
  const limitArg = Number(process.argv[3]);
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : Infinity;
  const todo = targets.slice(0, limit);

  logger.info({ annualReports: targets.length, todo: todo.length }, "history.ocr.start");

  const allRecords: Array<UnitRecord & { source_handle: string }> = [];
  const allWarnings: string[] = [];
  let ocrd = 0;

  // OCR is local CPU work, so we parallelize across a worker pool. OCR_WORKERS
  // sets both the scheduler size and how many reports render/OCR concurrently.
  const workers = Math.max(1, Number(process.env.OCR_WORKERS ?? 10));
  const scheduler = await createOcrScheduler(workers);
  let cursor = 0;
  const runLane = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      const t = todo[i];
      if (!t) return;
      try {
        const { records, warnings } = await ocrReport(scheduler, pdfPath(t.handle), t.year);
        for (const r of records) allRecords.push({ ...r, source_handle: t.handle });
        for (const w of warnings) allWarnings.push(`[${t.handle}] ${w}`);
        ocrd++;
        if (ocrd % 250 === 0) {
          logger.info({ done: ocrd, of: todo.length, units: allRecords.length }, "history.ocr.progress");
        }
      } catch (err) {
        logger.error({ handle: t.handle, err: (err as Error).message }, "history.ocr.fail");
        allWarnings.push(`[${t.handle}] OCR threw: ${(err as Error).message}`);
      }
    }
  };
  logger.info({ workers, reports: todo.length }, "history.ocr.pool");
  try {
    await Promise.all(Array.from({ length: workers }, () => runLane()));
  } finally {
    await scheduler.terminate();
  }

  // Resolve each OCR'd unit to its canonical registry unit_id via (APN, raw label)
  // — the OCR'd id is only a provisional slug. Unresolved rows keep their
  // provisional id (so nothing is dropped) but are counted; they surface as
  // orphans at merge time (units no longer in the registry, or a bad APN read).
  const resolve = buildUnitResolver(UNITS_CSV);
  let resolved = 0;
  let unresolved = 0;
  for (const r of allRecords) {
    const id = resolve(r.parcel, r.unit_label_raw);
    if (id) {
      r.unit_id = id;
      resolved++;
    } else {
      unresolved++;
    }
  }

  const { rows, conflicts } = dedupRecords(allRecords);
  // Merge with any prior mar_history rows so re-running a subset is additive.
  const existing = readCsv(MAR_HISTORY_CSV);
  const byKey = new Map<string, Row>();
  for (const r of existing) byKey.set(`${r.parcel}|${r.unit_id}|${r.report_year}`, r);
  for (const r of rows) byKey.set(`${r.parcel}|${r.unit_id}|${r.report_year}`, r);
  const merged = [...byKey.values()];
  writeCsvSorted(MAR_HISTORY_CSV, MAR_HISTORY_HEADERS, merged, [
    "parcel",
    "unit_id",
    "report_year",
  ]);

  const qa = qaReconcile(merged, readCsv(OBS_CSV));
  logger.info(
    {
      ocrd,
      unitRows: rows.length,
      totalRows: merged.length,
      resolved,
      unresolved,
      conflicts,
      warnings: allWarnings.length,
      qaCompared: qa.compared,
      qaMatched: qa.matched,
      qaRate: +qa.rate.toFixed(4),
    },
    "history.ocr.done",
  );
  if (allWarnings.length > 0) {
    logger.warn({ sample: allWarnings.slice(0, 20) }, "history.ocr.warnings");
  }
  if (qa.compared > 0 && qa.rate < QA_MIN_MATCH_RATE) {
    logger.error(
      { rate: +qa.rate.toFixed(4), threshold: QA_MIN_MATCH_RATE, sample: qa.mismatches.slice(0, 20) },
      "history.ocr.qa_fail",
    );
    throw new Error(
      `OCR QA gate failed: ${qa.matched}/${qa.compared} units matched registry (${(qa.rate * 100).toFixed(1)}% < ${QA_MIN_MATCH_RATE * 100}%)`,
    );
  }
  logger.info(
    { qaRate: +qa.rate.toFixed(4), sampleMismatches: qa.mismatches.slice(0, 10) },
    "history.ocr.qa_ok",
  );
}
