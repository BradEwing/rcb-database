import { join } from "node:path";
import { readCsv, writeCsvSorted, type Row } from "../csv.ts";
import { logger } from "../logger.ts";
import {
  OnBaseClient,
  WafChallengeError,
  rowByHeading,
  type SearchResult,
} from "./onbase-client.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const DATA_DIR = join(REPO_ROOT, "data");
const UNITS_CSV = join(DATA_DIR, "units.csv");
const PARCELS_CSV = join(DATA_DIR, "parcels.csv");
const DOC_INDEX_CSV = join(DATA_DIR, "history", "doc_index.csv");

export const DOC_INDEX_HEADERS = [
  "apn",
  "address",
  "unit_id",
  "doc_type",
  "doc_detail",
  "doc_year",
  "case_number",
  "handle",
  "doc_id",
  "name",
];

// OnBase keyword-type number for "Parcel Number" on custom query 125 (from the
// portal form's OBKey__106_1 field). See docs/design/mar-history-backfill.md.
const PARCEL_QUERY_ID = "125";
const PARCEL_KEYWORD_ID = 106;

/** The complete, reliable APN universe lives in units.csv (every drilled unit
 * carries its row's real LA County APN); parcels.csv only backfills the APN on the
 * one alias address that returned gvMarData, so it is missing ~3,300 of them. Union
 * both to be safe — the union equals the units.csv set today. */
export function distinctApns(): string[] {
  const apns = new Set<string>();
  for (const u of readCsv(UNITS_CSV)) {
    const a = (u.apn ?? "").trim();
    if (a) apns.add(a);
  }
  for (const p of readCsv(PARCELS_CSV)) {
    const a = (p.apn ?? "").trim();
    if (a) apns.add(a);
  }
  return [...apns].sort();
}

/** Map one parcel KeywordSearch response into index rows (pure; testable). */
export function indexRows(apn: string, result: SearchResult): Row[] {
  const cols = result.DisplayColumns;
  return result.Data.map((doc) => {
    const r = rowByHeading(doc, cols);
    const number = r["Address"] ?? "";
    const street = r["Street"] ?? "";
    return {
      apn,
      address: [number, street].filter(Boolean).join(" "),
      unit_id: r["Unit ID"] ?? "",
      doc_type: r["Document Type"] ?? "",
      doc_detail: r["Document Detail"] ?? "",
      doc_year: r["Document Year"] ?? "",
      case_number: r["Case Number"] ?? "",
      handle: r["Document Handle"] ?? "",
      doc_id: doc.ID,
      name: doc.Name,
    };
  });
}

/**
 * Phase 1 of the backfill: for each distinct APN, POST one KeywordSearch (query
 * 125) and persist the full document list to data/history/doc_index.csv. One row
 * per (apn, handle). Idempotent/resumable — APNs already present in the index are
 * skipped, so a crashed run resumes from disk. Stops cleanly if the WAF starts
 * challenging (the partial index is already flushed).
 */
export async function historyIndex(): Promise<void> {
  const existing = readCsv(DOC_INDEX_CSV);
  const indexed = new Set(existing.map((r) => r.apn ?? ""));

  // Args after the subcommand: bare 10-digit tokens are explicit APNs to (re)index
  // (handy for ops / validation); a single number is a limit for a cheap batch.
  const argv = process.argv.slice(3);
  const explicitApns = argv.filter((a) => /^\d{10}$/.test(a));
  const limitArg = Number(argv.find((a) => /^\d{1,9}$/.test(a)));
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : Infinity;

  const allApns = explicitApns.length > 0 ? explicitApns : distinctApns();
  // Explicit APNs are (re)indexed even if already present; batch mode skips done ones.
  const todo = (explicitApns.length > 0 ? allApns : allApns.filter((a) => !indexed.has(a))).slice(0, limit);
  logger.info(
    { total: allApns.length, alreadyIndexed: indexed.size, todo: todo.length },
    "history.index.start",
  );

  const client = new OnBaseClient({
    minDelayMs: Number(process.env.OBPA_MIN_DELAY_MS ?? 400),
  });
  const FLUSH_EVERY = 100;
  // Re-indexing an explicit APN replaces its rows, so drop them from the base set.
  const reindex = new Set(explicitApns);
  const rows: Row[] = existing.filter((r) => !reindex.has(r.apn ?? ""));
  let done = 0;

  const flush = (): void =>
    writeCsvSorted(DOC_INDEX_CSV, DOC_INDEX_HEADERS, rows, ["apn", "handle"]);

  try {
    for (const apn of todo) {
      try {
        const result = await client.keywordSearch(PARCEL_QUERY_ID, [
          { id: PARCEL_KEYWORD_ID, value: apn },
        ]);
        const newRows = indexRows(apn, result);
        rows.push(...newRows);
        done++;
        logger.info(
          { apn, docs: newRows.length, truncated: result.Truncated, i: done, of: todo.length },
          "history.index.apn",
        );
        if (result.Truncated) {
          logger.warn({ apn }, "history.index.truncated"); // >2000 docs — should never happen
        }
        if (done % FLUSH_EVERY === 0) flush();
      } catch (err) {
        if (err instanceof WafChallengeError) {
          logger.error({ apn, err: err.message }, "history.index.waf_stop");
          break; // be a good citizen: stop, flush, let the operator resume later
        }
        logger.error({ apn, err: (err as Error).message }, "history.index.fail");
      }
    }
  } finally {
    flush();
  }

  logger.info(
    {
      indexedApns: done,
      totalRows: rows.length,
      searches: client.searches,
      throttles: client.throttles,
      wafWaits: client.wafWaits,
    },
    "history.index.done",
  );
}
