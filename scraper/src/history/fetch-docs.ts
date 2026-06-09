import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readCsv, type Row } from "../csv.ts";
import { logger } from "../logger.ts";
import { OnBaseClient, WafChallengeError } from "./onbase-client.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const DATA_DIR = join(REPO_ROOT, "data");
const DOC_INDEX_CSV = join(DATA_DIR, "history", "doc_index.csv");
const RAW_HISTORY_DIR = join(DATA_DIR, "raw", "history");

/**
 * Document types worth OCR'ing. A row matches when doc_type === type and (detail
 * is undefined or doc_detail === detail). ANNUAL MAR REPORT is the golden per-unit
 * series; TENANCY REGISTRATION carries literal move-in rents (pre-2013 resets);
 * FINAL RENT PRINTOUT is a cross-validation snapshot.
 */
export const WANTED_TYPES: Array<{ type: string; detail?: string }> = [
  { type: "MAR REPORT", detail: "ANNUAL MAR REPORT" },
  { type: "TENANCY REGISTRATION" },
  { type: "FINAL RENT PRINTOUT" },
];

export function isWanted(row: Row): boolean {
  const type = row.doc_type ?? "";
  const detail = row.doc_detail ?? "";
  return WANTED_TYPES.some(
    (w) => w.type === type && (w.detail === undefined || w.detail === detail),
  );
}

/**
 * One row per distinct document handle to fetch, with any one stable doc_id for
 * it. The index lists a handle once per (apn, unit) it touches; we download each
 * physical document exactly once.
 */
export function fetchTargets(index: Row[]): Map<string, Row> {
  const byHandle = new Map<string, Row>();
  for (const row of index) {
    if (!isWanted(row)) continue;
    const handle = row.handle ?? "";
    if (!handle) continue;
    if (!byHandle.has(handle)) byHandle.set(handle, row);
  }
  return byHandle;
}

export function pdfPath(handle: string): string {
  return join(RAW_HISTORY_DIR, `${handle}.pdf`);
}

/**
 * Phase 2 of the backfill: download the wanted document types (PDF) to
 * data/raw/history/<handle>.pdf, deduped by handle and skipping already-fetched
 * files. Resumable; stops cleanly on a WAF challenge.
 */
export async function historyFetch(): Promise<void> {
  const index = readCsv(DOC_INDEX_CSV);
  if (index.length === 0) {
    throw new Error("data/history/doc_index.csv is empty. Run `history-index` first.");
  }
  mkdirSync(RAW_HISTORY_DIR, { recursive: true });

  const targets = [...fetchTargets(index).values()];
  const limitArg = Number(process.argv[3]);
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : Infinity;

  const pending = targets
    .filter((t) => !existsSync(pdfPath(t.handle ?? "")))
    .slice(0, limit);
  logger.info(
    { wantedDocs: targets.length, alreadyFetched: targets.length - pending.length, pending: pending.length },
    "history.fetch.start",
  );

  const client = new OnBaseClient({
    minDelayMs: Number(process.env.OBPA_MIN_DELAY_MS ?? 400),
  });
  let fetched = 0;
  let bytes = 0;

  for (const t of pending) {
    const handle = t.handle ?? "";
    try {
      const pdf = await client.fetchDocument(t.doc_id ?? "");
      writeFileSync(pdfPath(handle), pdf);
      fetched++;
      bytes += pdf.length;
      logger.info(
        { handle, type: t.doc_type, year: t.doc_year, bytes: pdf.length, i: fetched, of: pending.length },
        "history.fetch.doc",
      );
    } catch (err) {
      if (err instanceof WafChallengeError) {
        logger.error({ handle, err: err.message }, "history.fetch.waf_stop");
        break;
      }
      logger.error({ handle, err: (err as Error).message }, "history.fetch.fail");
    }
  }

  logger.info(
    {
      fetched,
      mb: +(bytes / 1e6).toFixed(1),
      fetches: client.fetches,
      throttles: client.throttles,
      wafWaits: client.wafWaits,
    },
    "history.fetch.done",
  );
}
