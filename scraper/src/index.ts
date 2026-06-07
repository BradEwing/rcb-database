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
  "last_drilled_at",
];
const UNIT_HEADERS = [
  "unit_id",
  "apn",
  "address",
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

// Number of parcels to drill between CSV flushes, so a crashed Phase B run keeps
// its progress (the same-day idempotent skip set resumes from what's on disk).
const FLUSH_EVERY = 250;

// The long sweeps run at a fast-but-serial cadence (default 200ms = 5 req/s,
// single worker). Override with MAR_MIN_DELAY_MS. probe-one keeps the polite 5s.
function sweepClient(): MarClient {
  return new MarClient({ minDelayMs: Number(process.env.MAR_MIN_DELAY_MS ?? 200) });
}

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

  const client = sweepClient();
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
  logger.info(
    {
      discovered: discovered.length,
      posts: client.posts,
      seeds: client.seeds,
      reGets: client.reGets,
    },
    "sweep.done",
  );
}

async function drillProperties(): Promise<void> {
  if (!existsSync(PARCELS_CSV)) {
    throw new Error("data/parcels.csv not found. Run `sweep-streets` first.");
  }
  const parcels = readCsv(PARCELS_CSV);
  logger.info({ count: parcels.length }, "drill.start");

  const today = new Date().toISOString().slice(0, 10);
  const existingObs = readCsv(OBS_CSV);

  // Idempotent + resumable: a parcel is "done today" if parcels.csv records it as
  // drilled today. This is recorded per-parcel (see backfill below) rather than
  // inferred from observations, because units are now keyed by their canonical
  // address — which can differ from the queried street — so an observation no
  // longer maps cleanly back to the parcel that was queried to produce it.
  const toDrill = parcels.filter(
    (p) =>
      p.street_number &&
      p.street_name &&
      p.parcel_id &&
      p.last_drilled_at !== today,
  );
  const skipped = parcels.length - toDrill.length;

  const existingUnits = readCsv(UNITS_CSV);
  const newUnits: UnitRow[] = [];
  const newObs: MarObservationRow[] = [];
  const apnUpdates = new Map<string, string>();
  // Same physical unit is returned by every alias address of its parcel; dedup
  // by unit_id so we record it once even though several addresses drill it.
  const seenUnits = new Set<string>();
  const drilledParcels = new Set<string>();
  let drilled = 0;

  // Write what we have so far. Called periodically so a crash mid-run keeps
  // progress; the same-day skip set then resumes from what's on disk. fs writes
  // here are synchronous, so a flush is an atomic snapshot even though several
  // workers mutate newUnits/newObs concurrently between flushes.
  const flushData = (): void => {
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
  };

  // Bounded concurrency: a few independent sessions (each its own token chain),
  // each draining the shared work-list. robots.txt explicitly allows this path
  // and publishes no crawl-delay; MarClient backs off on any 429/503. Tune with
  // MAR_WORKERS and MAR_MIN_DELAY_MS (per-worker delay → aggregate ≈ workers/delay).
  const workerCount = Math.max(1, Number(process.env.MAR_WORKERS ?? 6));
  const perWorkerDelay = Number(process.env.MAR_MIN_DELAY_MS ?? 150);
  const clients: MarClient[] = [];
  let cursor = 0; // shared work-list cursor; reads are atomic (no await between)

  const runWorker = async (): Promise<void> => {
    const client = new MarClient({ minDelayMs: perWorkerDelay });
    clients.push(client);
    for (;;) {
      const idx = cursor++;
      const parcel = toDrill[idx];
      if (!parcel) return;
      const streetNumber = parcel.street_number ?? "";
      const streetName = parcel.street_name ?? "";
      const parcelId = parcel.parcel_id ?? "";
      logger.info(
        { i: idx + 1, total: toDrill.length, parcel: `${streetNumber} ${streetName}` },
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
        for (let k = 0; k < units.length; k++) {
          const u = units[k]!;
          if (seenUnits.has(u.unit_id)) continue; // already recorded via another alias
          seenUnits.add(u.unit_id);
          newUnits.push(u);
          newObs.push(observations[k]!);
        }
        drilledParcels.add(parcelId);
        drilled++;
        if (drilled % FLUSH_EVERY === 0) flushData();
      } catch (err) {
        logger.error(
          { parcel: parcelId, err: (err as Error).message },
          "drill.fail",
        );
      }
    }
  };

  logger.info(
    { toDrill: toDrill.length, skipped, workers: workerCount, perWorkerDelay },
    "drill.pool",
  );
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  // Final persist of units + observations.
  flushData();

  // Backfill APNs and stamp last_drilled_at on every parcel we drilled this run.
  if (drilledParcels.size > 0) {
    const updated = parcels.map((p) => {
      const id = p.parcel_id ?? "";
      if (!drilledParcels.has(id)) return p;
      const apn = apnUpdates.get(id);
      return { ...p, last_drilled_at: today, ...(apn ? { apn } : {}) };
    });
    writeCsvSorted(PARCELS_CSV, PARCEL_HEADERS, updated, ["parcel_id"]);
  }

  const sum = (pick: (c: MarClient) => number): number =>
    clients.reduce((n, c) => n + pick(c), 0);
  logger.info(
    {
      drilled,
      skipped,
      newUnits: newUnits.length,
      newObs: newObs.length,
      workers: workerCount,
      posts: sum((c) => c.posts),
      seeds: sum((c) => c.seeds),
      reGets: sum((c) => c.reGets),
      throttles: sum((c) => c.throttles),
    },
    "drill.done",
  );
}

function writeRaw(name: string, html: string): void {
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(join(RAW_DIR, name), html);
}

main().catch((err) => {
  logger.error({ err: (err as Error).stack ?? err }, "fatal");
  process.exit(1);
});
