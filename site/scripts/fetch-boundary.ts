/**
 * fetch-boundary — cache the City's municipal boundary polygon for the map's
 * city-limits overlay.
 *
 * Occasional, NOT a per-build fetch (mirrors fetch-geometry): the output is
 * committed to data/external/city-boundary.geojson because it's a stable
 * external input that effectively never changes. Re-run only if the City
 * re-publishes the layer.
 *
 * Source: City of Santa Monica "Santa_Monica_city_boundary" ArcGIS
 * FeatureServer — a single polygon feature for the City of Santa Monica. We
 * request it in WGS84 (outSR=4326) so it drops straight onto the MapLibre map,
 * at the same coordinate precision as the parcel cache.
 *
 * Run: `npm run fetch-boundary`  (from the site/ directory)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BOUNDARY_CACHE } from "./lib/registry.ts";

const SERVICE_URL =
  "https://services3.arcgis.com/GVgbJbqm8hXASVYi/arcgis/rest/services/Santa_Monica_city_boundary/FeatureServer/0";
const GEOM_PRECISION = 6; // ~0.1 m — matches the parcel cache, trims file size
const USER_AGENT =
  "rcb-database boundary cache (https://github.com/BradEwing/rcb-database)";

type GeoFeature = {
  type: "Feature";
  geometry: unknown;
  properties: Record<string, unknown>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchBoundary(): Promise<GeoFeature[]> {
  const url =
    `${SERVICE_URL}/query?where=1%3D1` +
    `&outFields=*&returnGeometry=true&outSR=4326` +
    `&geometryPrecision=${GEOM_PRECISION}&f=geojson`;

  // Modest retry with backoff — the City GIS is a public service, not an API.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (res.status === 429 || res.status === 503) {
        const wait = (attempt + 1) * 2000;
        process.stderr.write(`  ${res.status}; backing off ${wait}ms\n`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { features?: GeoFeature[]; error?: unknown };
      if (body.error) throw new Error(`ArcGIS error: ${JSON.stringify(body.error)}`);
      return body.features ?? [];
    } catch (err) {
      lastErr = err;
      await sleep((attempt + 1) * 1000);
    }
  }
  throw new Error(`Failed to fetch boundary: ${String(lastErr)}`);
}

async function main(): Promise<void> {
  const feats = await fetchBoundary();
  if (feats.length === 0) {
    throw new Error("City boundary layer returned no features — endpoint changed?");
  }
  // Keep only geometry (drop the City's bookkeeping attributes); the overlay
  // needs the outline alone. Usually one polygon; tolerate a multi-feature layer.
  const features: GeoFeature[] = feats.map((f) => ({
    type: "Feature",
    geometry: f.geometry,
    properties: {},
  }));

  const out = {
    type: "FeatureCollection",
    metadata: {
      source: SERVICE_URL,
      out_sr: 4326,
      geometry_precision: GEOM_PRECISION,
      feature_count: features.length,
    },
    features,
  };

  mkdirSync(dirname(BOUNDARY_CACHE), { recursive: true });
  writeFileSync(BOUNDARY_CACHE, JSON.stringify(out) + "\n");
  process.stdout.write(
    `Wrote ${features.length} boundary feature(s) to ${BOUNDARY_CACHE}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`fetch-boundary failed: ${String(err)}\n`);
  process.exit(1);
});
