/**
 * fetch-geometry — cache the City's parcel polygons for the map's parcel layer.
 *
 * Occasional, NOT a per-build fetch: the output is committed to
 * data/external/parcels-geometry.geojson because it's a stable external input
 * that changes rarely. Re-run when the coverage QA in build-data flags a drop in
 * matched APNs (i.e. the registry has grown into parcels the cache doesn't hold).
 *
 * Source: City of Santa Monica "Parcels Public" ArcGIS FeatureServer. The join
 * field is `ain` (LA County Assessor Identification Number) — identical to the
 * registry's `apn`. The City layer covers all ~23.5k SM parcels; we clip the
 * committed cache to the ~8.5k AINs the registry references (per the design's
 * "optionally clip to keep it small"), so build-data can still report the truly
 * unmatched APNs by comparing units.csv against this cache.
 *
 * Run: `npm run fetch-geometry`  (from the site/ directory)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  GEOMETRY_CACHE,
  UNITS_CSV,
  readCsv,
  g,
  normApn,
} from "./lib/registry.ts";

const SERVICE_URL =
  "https://services3.arcgis.com/GVgbJbqm8hXASVYi/arcgis/rest/services/Santa_Monica_public_parcels/FeatureServer/0";
const PAGE_SIZE = 2000; // the layer's maxRecordCount
const GEOM_PRECISION = 6; // ~0.1 m — plenty for a city map, trims file size
const POLITE_DELAY_MS = 250; // be gentle to the City's GIS server between pages
const USER_AGENT =
  "rcb-database geometry cache (https://github.com/BradEwing/rcb-database)";

type GeoFeature = {
  type: "Feature";
  geometry: unknown;
  properties: Record<string, unknown>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(offset: number): Promise<GeoFeature[]> {
  const url =
    `${SERVICE_URL}/query?where=1%3D1` +
    `&outFields=ain&returnGeometry=true&outSR=4326` +
    `&geometryPrecision=${GEOM_PRECISION}` +
    `&resultOffset=${offset}&resultRecordCount=${PAGE_SIZE}&f=geojson`;

  // Modest retry with backoff — the City GIS is a public service, not an API.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (res.status === 429 || res.status === 503) {
        const wait = (attempt + 1) * 2000;
        process.stderr.write(`  ${res.status} at offset ${offset}; backing off ${wait}ms\n`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} at offset ${offset}`);
      const body = (await res.json()) as { features?: GeoFeature[]; error?: unknown };
      if (body.error) throw new Error(`ArcGIS error: ${JSON.stringify(body.error)}`);
      return body.features ?? [];
    } catch (err) {
      lastErr = err;
      await sleep((attempt + 1) * 1000);
    }
  }
  throw new Error(`Failed to fetch offset ${offset}: ${String(lastErr)}`);
}

async function main(): Promise<void> {
  // The registry's referenced APN universe — we clip the cache to these.
  const referenced = new Set(
    readCsv(UNITS_CSV).map((u) => normApn(g(u, "apn"))).filter(Boolean),
  );
  process.stdout.write(`Registry references ${referenced.size} distinct APNs.\n`);

  // Page through the entire City layer, keeping one feature per referenced AIN.
  const byAin = new Map<string, GeoFeature>();
  let offset = 0;
  let total = 0;
  for (;;) {
    const feats = await fetchPage(offset);
    total += feats.length;
    for (const f of feats) {
      const ain = normApn(String((f.properties as { ain?: unknown }).ain ?? ""));
      if (!ain || !referenced.has(ain) || byAin.has(ain)) continue;
      byAin.set(ain, { type: "Feature", geometry: f.geometry, properties: { ain } });
    }
    process.stdout.write(
      `  fetched ${total} city parcels (offset ${offset}); ${byAin.size} matched\n`,
    );
    if (feats.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await sleep(POLITE_DELAY_MS);
  }

  const matched = byAin.size;
  const unmatched = referenced.size - matched;
  const rate = referenced.size ? matched / referenced.size : 0;
  process.stdout.write(
    `\nCity parcels scanned: ${total}\n` +
      `Referenced APNs matched: ${matched}/${referenced.size} (${(rate * 100).toFixed(2)}%)\n` +
      `Unmatched (no City polygon): ${unmatched}\n`,
  );

  // Deterministic order (sorted by ain) so re-fetches diff cleanly in git.
  const features = [...byAin.values()].sort((a, b) =>
    String(a.properties.ain).localeCompare(String(b.properties.ain)),
  );

  const out = {
    type: "FeatureCollection",
    metadata: {
      source: SERVICE_URL,
      join_field: "ain",
      out_sr: 4326,
      geometry_precision: GEOM_PRECISION,
      city_parcels_scanned: total,
      referenced_apns: referenced.size,
      matched_apns: matched,
      unmatched_apns: unmatched,
    },
    features,
  };

  mkdirSync(dirname(GEOMETRY_CACHE), { recursive: true });
  writeFileSync(GEOMETRY_CACHE, JSON.stringify(out) + "\n");
  process.stdout.write(`\nWrote ${features.length} features to ${GEOMETRY_CACHE}\n`);
}

main().catch((err) => {
  process.stderr.write(`fetch-geometry failed: ${String(err)}\n`);
  process.exit(1);
});
