/** Map + choropleth configuration, shared by the map island and its legend. */
import type { ExpressionSpecification } from 'maplibre-gl';

/** CARTO Positron — key-free vector basemap (attribution required, no secret to
 *  manage on a static site). See docs/design/static-site.md (Basemap). */
export const BASEMAP_STYLE =
  'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

/** Fallback view (Santa Monica) before the data bounds are fitted. */
export const INITIAL_CENTER: [number, number] = [-118.475, 34.019];
export const INITIAL_ZOOM = 12.5;

/** Attribution for the parcel geometry layer (basemap attribution ships with
 *  the CARTO style). */
export const PARCEL_ATTRIBUTION =
  'Parcels: City of Santa Monica / LA County · Data: <a href="https://github.com/BradEwing/rcb-database">rcb-database</a> (CC0)';

/** City-limits overlay — outline + a soft dim of everything outside the city,
 *  to orient the ~45°-rotated grid and distinguish "inside SM, no controlled
 *  units" from "outside SM". Geometry: data/external/city-boundary.geojson. */
export const BOUNDARY_LINE_COLOR = '#0f2f4c';
export const BOUNDARY_LINE_WIDTH = 1.6;
/** Neutral wash over the world minus the city ring (subtle, basemap stays legible). */
export const BOUNDARY_MASK_COLOR = '#1d2b3a';
export const BOUNDARY_MASK_OPACITY = 0.16;

/** 3D unit-density extrusion (charts-and-density.md #3) — a VoteHub-style read of
 *  the controlled stock as an extruded skyline: each parcel polygon is raised to
 *  a height proportional to its CONTROLLED-unit count, coloured by the active
 *  choropleth metric. A toggleable mode (OFF by default) that pitches the camera;
 *  big complexes become towers, single-family lots stay flat. Tunables here. */
/** Camera pitch (deg) when 3D is on; 0 restores the flat top-down view. */
export const EXTRUSION_PITCH = 52;
/** Metres of height per controlled unit, before the user's multiplier. Tuned so
 *  the 1× default already reads as a skyline at the city framing zoom (≈16 m/px
 *  there). Linear in unit count — honest, VoteHub-style; the lone ~530-unit
 *  complex genuinely spikes. */
export const EXTRUSION_METERS_PER_UNIT = 7;
/** Height-multiplier presets (the 1×–5× control). */
export const EXTRUSION_MULTIPLIERS = [1, 2, 3, 4, 5] as const;
/** Multiplier selected when 3D is first switched on. */
export const EXTRUSION_DEFAULT_MULTIPLIER = 1;
/** Extrusion fill opacity (slightly < 1 so overlapping towers read as solids). */
export const EXTRUSION_OPACITY = 0.92;

export interface ChoroplethMetric {
  /** Feature property to colour by. */
  property: keyof import('./lib/types').ParcelProperties;
  label: string;
  /** Step upper-thresholds; colours has one more entry than stops. */
  stops: number[];
  colors: string[];
  /** Human labels for each colour bin (legend), length = colors.length. */
  legend: string[];
}

/** Choropleth metrics, selectable via the switcher. `recent_change` is a
 *  diverging scale (the seed reflects the 2023→2026 MAR move). */
export const METRICS = {
  unit_count: {
    property: 'unit_count',
    label: 'Units per parcel',
    stops: [2, 4, 10, 25, 50],
    colors: ['#dbe9f6', '#9ecae1', '#5fa8d3', '#3576b5', '#1d4e89', '#08233f'],
    legend: ['1', '2–3', '4–9', '10–24', '25–49', '50+'],
  },
  median_mar: {
    property: 'median_mar_cents',
    label: 'Median MAR',
    stops: [150000, 220000, 300000, 400000],
    colors: ['#f2e6f7', '#d8b3e0', '#b87fc9', '#8f4baa', '#5d2a78'],
    legend: ['< $1.5k', '$1.5–2.2k', '$2.2–3k', '$3–4k', '$4k+'],
  },
  recent_change: {
    property: 'recent_change_pct',
    label: 'Recent MAR change',
    stops: [-10, -2, 2, 10],
    colors: ['#1a7d3c', '#9bd4a8', '#ededed', '#f0a78f', '#c0322b'],
    legend: ['↓ >10%', '↓ 2–10%', '± <2%', '↑ 2–10%', '↑ >10%'],
  },
} satisfies Record<string, ChoroplethMetric>;

export type MetricKey = keyof typeof METRICS;

/** Build a MapLibre `step` colour expression for a choropleth metric. */
export function stepColorExpression(metric: ChoroplethMetric): ExpressionSpecification {
  const expr: unknown[] = ['step', ['get', metric.property as string], metric.colors[0]];
  for (let i = 0; i < metric.stops.length; i++) {
    expr.push(metric.stops[i], metric.colors[i + 1]);
  }
  return expr as ExpressionSpecification;
}

/** `fill-extrusion-height` expression for the 3D mode: controlled-unit count ×
 *  metres-per-unit × the chosen multiplier. coalesce guards parcels missing the
 *  property (renders flat). */
export function extrusionHeightExpression(multiplier: number): ExpressionSpecification {
  return [
    '*',
    ['coalesce', ['get', 'controlled_count'], 0],
    EXTRUSION_METERS_PER_UNIT * multiplier,
  ] as unknown as ExpressionSpecification;
}

/** Base-relative URL for a build-time data artifact (Project Pages base path). */
export function dataUrl(file: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${base}/data/${file}`;
}
