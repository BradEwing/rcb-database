/**
 * One-time migration from the snapshot model to the event-sourced (sparse) one.
 *
 * Before: `drill-properties` wrote a full snapshot per run — one observation row
 * per (unit, date) for every unit, changed or not. After backfilling the
 * 2023-07-19 City dump alongside the 2026-06-07 sweep, every unit that existed
 * in both carries two rows even when its MAR never moved.
 *
 * This migration converts the existing data to the change-log model
 * (`docs/design/sparse-observations.md`):
 *
 *  1. Prune `mar_observations.csv`: keep every 2023-07-19 baseline row; drop each
 *     2026-06-07 row whose (mar, tenancy) equals the same unit's 2023-07-19 row
 *     (carry-forward makes it redundant). Rows that changed, or that have no 2023
 *     counterpart, are kept.
 *  2. Add `last_seen_at = 2026-06-07` to every `units.csv` row.
 *
 * Carry-forward is value-preserving, so `npm run reconcile` must produce a
 * byte-identical `reconciliation_summary.csv` before and after — verify that.
 *
 * Idempotent: re-running finds the redundant 2026 rows already gone and
 * `last_seen_at` already set, so it is a no-op.
 *
 * Run: `npm run migrate:sparse`
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, writeCsvSorted, type Row } from "../csv.ts";
import { pruneUnchangedSnapshot } from "../sparse.ts";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const DATA_DIR = join(REPO_ROOT, "data");
const UNITS_CSV = join(DATA_DIR, "units.csv");
const OBS_CSV = join(DATA_DIR, "mar_observations.csv");

const BASELINE_DATE = "2023-07-19";
const SNAPSHOT_DATE = "2026-06-07";

const OBS_HEADERS = ["unit_id", "observed_at", "mar_amount_cents", "tenancy_date"];
const UNIT_HEADERS = [
  "unit_id",
  "apn",
  "address",
  "unit_label",
  "bedrooms",
  "first_seen_at",
  "last_seen_at",
];

function main(): void {
  const obs = readCsv(OBS_CSV);
  if (obs.length === 0) {
    throw new Error(`No observations at ${OBS_CSV} — nothing to migrate.`);
  }
  const before = obs.length;
  const { kept, pruned } = pruneUnchangedSnapshot(obs, BASELINE_DATE, SNAPSHOT_DATE);
  writeCsvSorted(OBS_CSV, OBS_HEADERS, kept, ["unit_id", "observed_at"]);

  const units = readCsv(UNITS_CSV);
  if (units.length === 0) {
    throw new Error(`No units at ${UNITS_CSV} — run the scraper first.`);
  }
  let stamped = 0;
  const withSeen: Row[] = units.map((u) => {
    if ((u.last_seen_at ?? "") !== "") return u;
    stamped++;
    return { ...u, last_seen_at: SNAPSHOT_DATE };
  });
  writeCsvSorted(UNITS_CSV, UNIT_HEADERS, withSeen, ["unit_id"]);

  console.log("migrate-sparse: snapshot -> event-sourced change log");
  console.log(`  observations before ....... ${before}`);
  console.log(`  redundant 2026 rows pruned  ${pruned}`);
  console.log(`  observations after ........ ${kept.length}`);
  console.log(`  units stamped last_seen_at . ${stamped} (of ${units.length})`);
  console.log("");
  console.log("  Now run `npm run reconcile` and confirm");
  console.log("  data/derived/reconciliation_summary.csv is byte-identical.");
}

main();
