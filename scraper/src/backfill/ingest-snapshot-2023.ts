/**
 * One-time historical backfill from the City's 2023-07-19 bulk MAR snapshot.
 *
 * The live `mar.aspx` tool only ever shows the *current* MAR, so this project's
 * own history starts at its first sweep (2026-06-07). The City, however,
 * published a single bulk dump of the whole registry on its CKAN open-data
 * portal, frozen at 2023-07-19 (see `data/external/mar-2023-07-19/README.md`).
 * Ingesting it gives the registry a genuine second time-point ~3 years earlier.
 *
 * What this does (idempotent — safe to re-run; merges are keyed):
 *  1. Reconstructs each 2023 unit's `unit_id` with the SAME `slug()` the scraper
 *     uses, so the keys line up with `data/units.csv`.
 *  2. Appends a `2023-07-19` row to `data/mar_observations.csv` for every unit
 *     that still exists in the current registry (referential integrity: we do
 *     NOT invent units.csv rows for units that have since disappeared — that
 *     would corrupt the current-state reconciliation tuned to the RCB headline).
 *  3. Writes a derived diff `data/derived/mar_change_2023_2026.csv` with the
 *     per-unit 2023→2026 MAR delta plus the appeared/disappeared sets — the
 *     units gone by 2026 are preserved here (and in the raw external file), not
 *     lost, even though they're kept out of the canonical observations table.
 *
 * Run: `npm run backfill:snapshot-2023`
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, writeCsvSorted, mergeRows, type Row } from "../csv.ts";
import { slug } from "../normalize.ts";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const DATA_DIR = join(REPO_ROOT, "data");
const SNAPSHOT_UNITS = join(DATA_DIR, "external", "mar-2023-07-19", "units.csv");
const UNITS_CSV = join(DATA_DIR, "units.csv");
const OBS_CSV = join(DATA_DIR, "mar_observations.csv");
const DIFF_CSV = join(DATA_DIR, "derived", "mar_change_2023_2026.csv");

/** The snapshot's frozen date — used as `observed_at` for the backfilled rows. */
const SNAPSHOT_DATE = "2023-07-19";

const OBS_HEADERS = ["unit_id", "observed_at", "mar_amount_cents", "tenancy_date"];
const DIFF_HEADERS = [
  "unit_id",
  "apn",
  "address",
  "unit_label",
  "bedrooms",
  "status", // present_both | gone_by_2026 | new_since_2023
  "mar_2023_cents",
  "mar_2026_cents",
  "mar_delta_cents",
  "mar_pct",
  "tenancy_2023",
  "tenancy_2026",
  "tenancy_changed",
];

function g(r: Row, k: string): string {
  return (r[k] ?? "").trim();
}

/** "5367" / "$1,234.50" -> integer cents. Blank/0 -> 0 (exempt). */
function dollarsToCents(text: string): number {
  const cleaned = (text || "").replace(/[$,\s]/g, "");
  if (cleaned === "" || cleaned === "0") return 0;
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** "6/1/2003 1:00:00 AM" -> "2003-06-01"; blank/unparseable -> "". */
function effectiveDateToIso(text: string): string {
  const m = (text || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return "";
  const [, mo, da, yr] = m;
  return `${yr}-${mo!.padStart(2, "0")}-${da!.padStart(2, "0")}`;
}

/** Rebuild the registry's unit_id from the snapshot's address + label columns. */
function snapshotUnitId(r: Row): string {
  const addr = g(r, "UNITMASTER_ADDRESS");
  const label = g(r, "UNITMASTER_UNIT_ID");
  return slug(`${addr} ${label || "_"}`);
}

function pct(from: number, to: number): string {
  if (from === 0) return ""; // undefined growth from an exempt/zero base
  return (((to - from) / from) * 100).toFixed(1);
}

async function main(): Promise<void> {
  const snapRows = readCsv(SNAPSHOT_UNITS);
  if (snapRows.length === 0) {
    throw new Error(`No snapshot rows at ${SNAPSHOT_UNITS}`);
  }
  const registry = readCsv(UNITS_CSV);
  if (registry.length === 0) {
    throw new Error(`No registry units at ${UNITS_CSV} — run the scraper first.`);
  }
  const existingObs = readCsv(OBS_CSV);

  // Current registry, indexed by unit_id.
  const regById = new Map<string, Row>();
  for (const u of registry) regById.set(g(u, "unit_id"), u);

  // Latest (2026) MAR + tenancy per unit, from existing observations. The obs
  // file is sorted (unit_id, observed_at), so iterating and overwriting leaves
  // the most-recent observation per unit in the map.
  const latestMar = new Map<string, number>();
  const latestTenancy = new Map<string, string>();
  for (const o of existingObs) {
    if (g(o, "observed_at") === SNAPSHOT_DATE) continue; // ignore our own backfill on re-run
    const id = g(o, "unit_id");
    latestMar.set(id, Number.parseInt(g(o, "mar_amount_cents") || "0", 10));
    latestTenancy.set(id, g(o, "tenancy_date"));
  }

  // Build 2023 observations (matched units only) and the full diff.
  const backfillObs: Row[] = [];
  const diff: Row[] = [];
  const seen2023 = new Set<string>();
  let matched = 0;
  let goneBy2026 = 0;

  for (const r of snapRows) {
    const id = snapshotUnitId(r);
    seen2023.add(id);
    const cents2023 = dollarsToCents(g(r, "MAR1"));
    const tenancy2023 = effectiveDateToIso(g(r, "effectivedate"));
    const reg = regById.get(id);

    if (reg) {
      matched++;
      backfillObs.push({
        unit_id: id,
        observed_at: SNAPSHOT_DATE,
        mar_amount_cents: String(cents2023),
        tenancy_date: tenancy2023,
      });
      const cents2026 = latestMar.get(id) ?? 0;
      const ten2026 = latestTenancy.get(id) ?? "";
      diff.push({
        unit_id: id,
        apn: g(reg, "apn"),
        address: g(reg, "address"),
        unit_label: g(reg, "unit_label"),
        bedrooms: g(reg, "bedrooms"),
        status: "present_both",
        mar_2023_cents: String(cents2023),
        mar_2026_cents: String(cents2026),
        mar_delta_cents: String(cents2026 - cents2023),
        mar_pct: pct(cents2023, cents2026),
        tenancy_2023: tenancy2023,
        tenancy_2026: ten2026,
        tenancy_changed: tenancy2023 && ten2026 && tenancy2023 !== ten2026 ? "1" : "",
      });
    } else {
      goneBy2026++;
      diff.push({
        unit_id: id,
        apn: g(r, "parcel_no"),
        address: g(r, "UNITMASTER_ADDRESS"),
        unit_label: g(r, "UNITMASTER_UNIT_ID"),
        bedrooms: g(r, "BEDROOM"),
        status: "gone_by_2026",
        mar_2023_cents: String(cents2023),
        mar_2026_cents: "",
        mar_delta_cents: "",
        mar_pct: "",
        tenancy_2023: tenancy2023,
        tenancy_2026: "",
        tenancy_changed: "",
      });
    }
  }

  // Units new since 2023: in the current registry but absent from the snapshot.
  let newSince2023 = 0;
  for (const u of registry) {
    const id = g(u, "unit_id");
    if (seen2023.has(id)) continue;
    newSince2023++;
    diff.push({
      unit_id: id,
      apn: g(u, "apn"),
      address: g(u, "address"),
      unit_label: g(u, "unit_label"),
      bedrooms: g(u, "bedrooms"),
      status: "new_since_2023",
      mar_2023_cents: "",
      mar_2026_cents: String(latestMar.get(id) ?? 0),
      mar_delta_cents: "",
      mar_pct: "",
      tenancy_2023: "",
      tenancy_2026: latestTenancy.get(id) ?? "",
      tenancy_changed: "",
    });
  }

  // Persist: merge 2023 observations into the canonical time series (keyed, so
  // re-running is idempotent), and write the derived diff.
  const mergedObs = mergeRows(existingObs, backfillObs, ["unit_id", "observed_at"]);
  writeCsvSorted(OBS_CSV, OBS_HEADERS, mergedObs, ["unit_id", "observed_at"]);
  writeCsvSorted(DIFF_CSV, DIFF_HEADERS, diff, ["unit_id"]);

  // Summary.
  const increases = diff.filter((d) => d.status === "present_both" && Number(d.mar_delta_cents) > 0);
  const decreases = diff.filter((d) => d.status === "present_both" && Number(d.mar_delta_cents) < 0);
  const resets = diff.filter((d) => d.tenancy_changed === "1");
  const totalDelta = increases.reduce((s, d) => s + Number(d.mar_delta_cents), 0)
    + decreases.reduce((s, d) => s + Number(d.mar_delta_cents), 0);

  console.log(`backfill 2023-07-19 snapshot → registry`);
  console.log(`  snapshot units ............ ${snapRows.length}`);
  console.log(`  matched (present_both) .... ${matched}  (backfilled observations)`);
  console.log(`  gone_by_2026 .............. ${goneBy2026}`);
  console.log(`  new_since_2023 ............ ${newSince2023}`);
  console.log(`  observations now .......... ${mergedObs.length} (+${backfillObs.length})`);
  console.log(`  --- 2023→2026, matched units ---`);
  console.log(`  MAR increased ............. ${increases.length}`);
  console.log(`  MAR decreased ............. ${decreases.length}`);
  console.log(`  tenancy reset (date Δ) .... ${resets.length}`);
  console.log(`  net MAR change ............ $${(totalDelta / 100).toLocaleString()}`);
  console.log(`  wrote ${DIFF_CSV}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
