/**
 * build-data — transform the committed registry into the site's data artifacts.
 *
 * Runs on EVERY site build (wired as `prebuild`). Pure transform over the
 * source-of-truth CSVs + the cached parcel geometry; emits into
 * site/public/data/ (gitignored — these are build outputs, deployed to Pages,
 * never committed). See docs/design/static-site.md.
 *
 * PR2 scope: the parcel layer (`parcels.geojson`) + provenance (`meta.json`),
 * with build-time coverage QA that fails loudly (repo convention) if the
 * geometry join rate drops below MIN_MATCH_RATE. Later PRs extend this with
 * per-APN detail JSON and the citywide summary.
 *
 * The geographic key is the APN (one physical parcel). The parcel universe and
 * unit grouping come from units.csv.apn — never parcels.csv (see design).
 *
 * Run: `npm run build-data`  (from the site/ directory)
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  SITE_DATA_DIR,
  GEOMETRY_CACHE,
  UNITS_CSV,
  OBS_CSV,
  SWEEPS_CSV,
  CHANGES_CSV,
  readCsv,
  g,
  normApn,
  latestMarByUnit,
  latestSweepDate,
  median,
  sizeClassOf,
  type Row,
  type LatestMar,
} from "./lib/registry.ts";

/** Fail the build if fewer than this fraction of referenced APNs have geometry.
 *  Observed coverage at seed is 98.86%; 0.95 leaves margin for month-to-month
 *  drift while still catching a real join regression (wrong field, stale cache). */
const MIN_MATCH_RATE = 0.95;

type ParcelAgg = {
  apn: string;
  addresses: Set<string>;
  unitCount: number;
  controlledCount: number;
  exemptCount: number;
  controlledMarCents: number[];
};

type GeoFeature = {
  type: "Feature";
  geometry: unknown;
  properties: Record<string, unknown>;
};

function gitSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Aggregate every unit into its APN. Source of truth for the parcel universe. */
function aggregateParcels(
  units: Row[],
  latestMar: Map<string, LatestMar>,
): Map<string, ParcelAgg> {
  const byApn = new Map<string, ParcelAgg>();
  for (const u of units) {
    const apn = normApn(g(u, "apn"));
    if (!apn) continue;
    let p = byApn.get(apn);
    if (!p) {
      p = {
        apn,
        addresses: new Set(),
        unitCount: 0,
        controlledCount: 0,
        exemptCount: 0,
        controlledMarCents: [],
      };
      byApn.set(apn, p);
    }
    p.unitCount++;
    const addr = g(u, "address");
    if (addr) p.addresses.add(addr);
    const mar = latestMar.get(g(u, "unit_id"));
    const cents = mar?.mar_amount_cents ?? 0;
    if (cents > 0) {
      p.controlledCount++;
      p.controlledMarCents.push(cents);
    } else {
      p.exemptCount++;
    }
  }
  return byApn;
}

/** Representative address for an APN label: the lexicographically first one. */
function labelAddress(addresses: Set<string>): string {
  return [...addresses].sort()[0] ?? "";
}

function main(): void {
  const units = readCsv(UNITS_CSV);
  if (units.length === 0) {
    throw new Error(`No units found at ${UNITS_CSV} — run the scraper first.`);
  }
  if (!existsSync(GEOMETRY_CACHE)) {
    throw new Error(
      `Geometry cache missing at ${GEOMETRY_CACHE} — run \`npm run fetch-geometry\` first.`,
    );
  }

  const obs = readCsv(OBS_CSV);
  const sweeps = readCsv(SWEEPS_CSV);
  const changes = readCsv(CHANGES_CSV);
  const latestMar = latestMarByUnit(obs);
  const sweepDate = latestSweepDate(sweeps);

  const parcels = aggregateParcels(units, latestMar);

  // APNs that saw a MAR change at the latest sweep → choropleth "recent change".
  const recentlyChanged = new Set<string>();
  for (const c of changes) {
    if (g(c, "observed_at") === sweepDate) recentlyChanged.add(normApn(g(c, "apn")));
  }

  // Load the cached geometry and join by APN.
  const cache = JSON.parse(readFileSync(GEOMETRY_CACHE, "utf8")) as {
    metadata?: Record<string, unknown>;
    features: GeoFeature[];
  };
  const geomByApn = new Map<string, unknown>();
  for (const f of cache.features) {
    const ain = normApn(String((f.properties as { ain?: unknown }).ain ?? ""));
    if (ain && !geomByApn.has(ain)) geomByApn.set(ain, f.geometry);
  }

  const features: GeoFeature[] = [];
  const unmatchedApns: string[] = [];
  for (const p of parcels.values()) {
    const geometry = geomByApn.get(p.apn);
    if (!geometry) {
      unmatchedApns.push(p.apn);
      continue;
    }
    features.push({
      type: "Feature",
      geometry,
      properties: {
        apn: p.apn,
        label_address: labelAddress(p.addresses),
        unit_count: p.unitCount,
        controlled_count: p.controlledCount,
        exempt_count: p.exemptCount,
        median_mar_cents: median(p.controlledMarCents),
        size_class: sizeClassOf(p.unitCount),
        has_recent_change: recentlyChanged.has(p.apn),
      },
    });
  }

  const referenced = parcels.size;
  const matched = features.length;
  const rate = referenced ? matched / referenced : 0;

  process.stdout.write(
    `Parcels (distinct APNs): ${referenced}\n` +
      `Geometry matched: ${matched} (${(rate * 100).toFixed(2)}%)\n` +
      `Unmatched (no City polygon): ${unmatchedApns.length}\n`,
  );
  if (unmatchedApns.length) {
    const sample = unmatchedApns.slice(0, 20).join(", ");
    process.stdout.write(`  unmatched sample: ${sample}\n`);
  }

  // Loud fail (repo convention): a coverage cliff means a broken join, not data.
  if (rate < MIN_MATCH_RATE) {
    throw new Error(
      `Geometry coverage ${(rate * 100).toFixed(2)}% < ${(MIN_MATCH_RATE * 100).toFixed(0)}% ` +
        `(${matched}/${referenced}). The geometry cache is likely stale or the join ` +
        `field changed — re-run \`npm run fetch-geometry\` or check the City layer.`,
    );
  }

  // Deterministic feature order so the artifact is stable across builds.
  features.sort((a, b) =>
    String(a.properties.apn).localeCompare(String(b.properties.apn)),
  );

  mkdirSync(SITE_DATA_DIR, { recursive: true });
  const parcelsPath = join(SITE_DATA_DIR, "parcels.geojson");
  writeFileSync(
    parcelsPath,
    JSON.stringify({ type: "FeatureCollection", features }),
  );

  const meta = {
    built_at: new Date().toISOString(),
    source_sha: gitSha(),
    latest_sweep: sweepDate,
    geometry_source: cache.metadata?.source ?? null,
    geometry_precision: cache.metadata?.geometry_precision ?? null,
    parcels_total: referenced,
    parcels_mapped: matched,
    parcels_unmatched: unmatchedApns.length,
    match_rate: Number(rate.toFixed(4)),
    units_total: units.length,
  };
  const metaPath = join(SITE_DATA_DIR, "meta.json");
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");

  const bytes = Buffer.byteLength(JSON.stringify({ type: "FeatureCollection", features }));
  process.stdout.write(
    `\nWrote ${parcelsPath} (${features.length} features, ${(bytes / 1e6).toFixed(2)} MB)\n` +
      `Wrote ${metaPath}\n`,
  );
}

main();
