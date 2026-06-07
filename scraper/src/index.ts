import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MarClient } from "./mar-client.ts";
import { fetchStreetListHtml, parseStreetList } from "./street-list.ts";
import { parseMarPage } from "./parse-mar.ts";
import {
  parsePhaseAddresses,
  parsePhaseUnits,
  type ParcelRow,
  type UnitRow,
  type MarObservationRow,
} from "./normalize.ts";
import {
  mergeRows,
  readCsv,
  writeCsvSorted,
  type Row,
} from "./csv.ts";
import { logger } from "./logger.ts";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const DATA_DIR = join(REPO_ROOT, "data");
const RAW_DIR = join(DATA_DIR, "raw");

const PARCELS_CSV = join(DATA_DIR, "parcels.csv");
const UNITS_CSV = join(DATA_DIR, "units.csv");
const OBS_CSV = join(DATA_DIR, "mar_observations.csv");
const STREETS_CSV = join(DATA_DIR, "streets.csv");

const PARCEL_HEADERS = [
  "parcel_id",
  "street_number",
  "street_name",
  "apn",
  "first_seen_at",
];
const UNIT_HEADERS = [
  "unit_id",
  "parcel_id",
  "unit_label",
  "bedrooms",
  "first_seen_at",
];
const OBS_HEADERS = [
  "unit_id",
  "observed_at",
  "mar_amount_cents",
  "tenancy_date",
];

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  switch (command) {
    case "probe-one":
      await probeOne(args[0] ?? "Colorado Ave", args[1]);
      return;
    case "refresh-streets":
      await refreshStreets();
      return;
    case "sweep-streets":
      await sweepStreets();
      return;
    case "drill-properties":
      await drillProperties();
      return;
    default:
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

function printUsage(): void {
  console.log(`usage: npm run scraper -- <command> [args]

commands:
  probe-one <street> [number]   POST one query to the MAR form, save raw HTML, dump parsed grids.
  refresh-streets               Fetch the official street-name list and rewrite data/streets.csv.
  sweep-streets                 Phase A: for each street in data/streets.csv, POST blank+street,
                                parse gvAddresses, append discovered properties to data/parcels.csv.
  drill-properties              Phase B: for each parcel without an MAR observation today,
                                POST number+street, parse gvMarData, append to units.csv +
                                mar_observations.csv, and backfill parcels.csv with APN.`);
}

async function refreshStreets(): Promise<void> {
  const html = await fetchStreetListHtml();
  writeRaw("street-list.html", html);
  const streets = parseStreetList(html);
  const today = new Date().toISOString().slice(0, 10);

  const existing = readCsv(STREETS_CSV);
  const incoming: Row[] = streets.map((s) => ({
    street_name: s,
    first_swept_at: today,
  }));
  const merged = mergeRows(existing, incoming, ["street_name"]);
  writeCsvSorted(
    STREETS_CSV,
    ["street_name", "first_swept_at"],
    merged,
    ["street_name"],
  );
  logger.info({ streets: streets.length }, "streets.refreshed");
}

async function probeOne(
  streetName: string,
  streetNumber?: string,
): Promise<void> {
  const client = new MarClient();
  const result = await client.query(streetNumber ?? "", streetName);
  const safeName = streetName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const filename = streetNumber
    ? `${streetNumber}-${safeName}.html`
    : `${safeName}.html`;
  writeRaw(filename, result.html);

  const page = parseMarPage(result.html);
  logger.info(
    {
      streetName,
      streetNumber: streetNumber ?? "",
      message: page.message,
      addressRows: page.addresses?.rows.length ?? 0,
      marRows: page.marData?.rows.length ?? 0,
      addressHeaders: page.addresses?.headers ?? [],
      marHeaders: page.marData?.headers ?? [],
    },
    "probe.parsed",
  );
  if (page.addresses) {
    console.log("\n=== gvAddresses (first 5) ===");
    console.log(JSON.stringify(page.addresses.rows.slice(0, 5), null, 2));
  }
  if (page.marData) {
    console.log("\n=== gvMarData (first 5) ===");
    console.log(JSON.stringify(page.marData.rows.slice(0, 5), null, 2));
  }
}

async function sweepStreets(): Promise<void> {
  if (!existsSync(STREETS_CSV)) {
    throw new Error("data/streets.csv not found. Run `refresh-streets` first.");
  }
  const streets = readCsv(STREETS_CSV)
    .map((r) => r.street_name ?? "")
    .filter((s): s is string => Boolean(s));
  logger.info({ count: streets.length }, "sweep.start");

  const client = new MarClient();
  const discovered: ParcelRow[] = [];

  for (const [i, street] of streets.entries()) {
    logger.info({ i: i + 1, total: streets.length, street }, "sweep.street");
    try {
      const result = await client.query("", street);
      const safe = street.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      writeRaw(`sweep-${safe}.html`, result.html);
      const page = parseMarPage(result.html);
      const rows = parsePhaseAddresses(page, street, result.fetchedAt);
      discovered.push(...rows);
      logger.info({ street, found: rows.length }, "sweep.parsed");
    } catch (err) {
      logger.error({ street, err: (err as Error).message }, "sweep.fail");
    }
  }

  const existing = readCsv(PARCELS_CSV);
  const merged = mergeRows(existing, discovered, ["parcel_id"]);
  writeCsvSorted(PARCELS_CSV, PARCEL_HEADERS, merged, ["parcel_id"]);
  logger.info({ discovered: discovered.length }, "sweep.done");
}

async function drillProperties(): Promise<void> {
  if (!existsSync(PARCELS_CSV)) {
    throw new Error("data/parcels.csv not found. Run `sweep-streets` first.");
  }
  const parcels = readCsv(PARCELS_CSV);
  logger.info({ count: parcels.length }, "drill.start");

  const today = new Date().toISOString().slice(0, 10);
  const existingObs = readCsv(OBS_CSV);
  const observedToday = new Set(
    existingObs
      .filter((r) => r.observed_at === today)
      .map((r) => r.unit_id ?? "")
      .filter(Boolean),
  );

  // We treat an observation as "stale" if the parcel has no row in mar_observations
  // for today. This makes the command idempotent and resumable: re-running on the
  // same day skips parcels we've already drilled.
  const obsByParcel = indexParcelsObserved(existingObs, parcels, today);

  const client = new MarClient();
  const newUnits: UnitRow[] = [];
  const newObs: MarObservationRow[] = [];
  const apnUpdates = new Map<string, string>();
  let drilled = 0;
  let skipped = 0;

  for (const [i, parcel] of parcels.entries()) {
    const streetNumber = parcel.street_number ?? "";
    const streetName = parcel.street_name ?? "";
    const parcelId = parcel.parcel_id ?? "";
    if (!streetNumber || !streetName || !parcelId) continue;
    if (obsByParcel.has(parcelId)) {
      skipped++;
      continue;
    }
    logger.info(
      { i: i + 1, total: parcels.length, parcel: `${streetNumber} ${streetName}` },
      "drill.parcel",
    );
    try {
      const result = await client.query(streetNumber, streetName);
      const safe = `${streetNumber}-${streetName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")}.html`;
      writeRaw(safe, result.html);
      const page = parseMarPage(result.html);
      const { apn, units, observations } = parsePhaseUnits(
        page,
        streetNumber,
        streetName,
        result.fetchedAt,
      );
      if (apn) apnUpdates.set(parcelId, apn);
      for (const u of units) newUnits.push(u);
      for (const o of observations) {
        if (!observedToday.has(o.unit_id)) newObs.push(o);
      }
      drilled++;
    } catch (err) {
      logger.error(
        { parcel: parcelId, err: (err as Error).message },
        "drill.fail",
      );
    }
  }

  // Persist updates.
  const existingUnits = readCsv(UNITS_CSV);
  writeCsvSorted(
    UNITS_CSV,
    UNIT_HEADERS,
    mergeRows(existingUnits, newUnits as unknown as Row[], ["unit_id"]),
    ["unit_id"],
  );
  writeCsvSorted(
    OBS_CSV,
    OBS_HEADERS,
    mergeRows(existingObs, newObs as unknown as Row[], [
      "unit_id",
      "observed_at",
    ]),
    ["unit_id", "observed_at"],
  );

  // Backfill APNs into parcels.csv.
  if (apnUpdates.size > 0) {
    const updated = parcels.map((p) => {
      const apn = apnUpdates.get(p.parcel_id ?? "");
      return apn ? { ...p, apn } : p;
    });
    writeCsvSorted(PARCELS_CSV, PARCEL_HEADERS, updated, ["parcel_id"]);
  }

  logger.info({ drilled, skipped, newUnits: newUnits.length, newObs: newObs.length }, "drill.done");
}

function indexParcelsObserved(
  obs: Row[],
  parcels: Row[],
  today: string,
): Set<string> {
  const unitToParcel = new Map<string, string>();
  // Cheap lookup: derive parcel_id from unit_id slug prefix is fragile; instead
  // we cross-walk via the units.csv if present.
  const units = existsSync(UNITS_CSV) ? readCsv(UNITS_CSV) : [];
  for (const u of units) {
    if (u.unit_id && u.parcel_id) unitToParcel.set(u.unit_id, u.parcel_id);
  }
  const parcelsObservedToday = new Set<string>();
  for (const o of obs) {
    if (o.observed_at !== today) continue;
    const parcelId = unitToParcel.get(o.unit_id ?? "");
    if (parcelId) parcelsObservedToday.add(parcelId);
  }
  return parcelsObservedToday;
}

function writeRaw(name: string, html: string): void {
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(join(RAW_DIR, name), html);
}

main().catch((err) => {
  logger.error({ err: (err as Error).stack ?? err }, "fatal");
  process.exit(1);
});
