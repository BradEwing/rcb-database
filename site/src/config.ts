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

/** Default baseline year for the MAR-change choropleth (the end year defaults to
 *  the latest year with data). Data reliably reaches back to ~2012; 2020 gives a
 *  meaningful multi-year window out of the box. Clamped to the available range. */
export const RECENT_CHANGE_DEFAULT_BASELINE = 2020;
/** Fill for parcels with no controlled MAR established in the baseline year (the
 *  % change is undefined). A cool grey, deliberately distinct in HUE from the
 *  warm change ramp so "no baseline" never reads as "barely changed". */
export const NO_DATA_COLOR = '#aab3bd';

/** MAR-change ramp: one green bin for a decrease, then a warm sequential ramp for
 *  increases. The lowest increase bin is a faint warm tint (not near-white) so it
 *  stays distinct from the cool no-data grey. Six colours → five `changeStops`. */
export const RECENT_CHANGE_COLORS = [
  '#2c7d3f',
  '#ffedd6',
  '#ffd29e',
  '#f7a45c',
  '#e26d31',
  '#b03a1a',
];

/** Per-year %-change thresholds, scaled by the selected window length. A single
 *  General Adjustment is ~6–9%/yr, so over a 1-year window a typical GA lands in
 *  an upper bin (a clear "increase"), not the palest one — while a 14-year window
 *  stretches the same bins to cumulative-scale breaks. Without this, fixed breaks
 *  tuned for a multi-year window collapse every parcel in a single-GA year into
 *  one near-white bin (the Shores-Tower "looks unchanged" bug). */
const CHANGE_STOP_PER_YEAR = [1.8, 4, 8, 16];

/** "Nice" mantissas — breaks are rounded to one of these × a power of ten so the
 *  legend always reads in round numbers (10/20/50/100…) instead of the raw scaled
 *  value (11/24/48/96…). */
const NICE_MANTISSAS = [1, 2, 5];

/** Round to the nearest 1·2·5 × 10ⁿ. Keeps the geometric spacing of the per-year
 *  breaks while guaranteeing clean legend numbers. */
function roundNice(v: number): number {
  if (v <= 0) return 0;
  const base = 10 ** Math.floor(Math.log10(v));
  const f = v / base; // [1, 10)
  const m = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return m * base;
}

/** Smallest nice number strictly greater than `v` — used to break ties when two
 *  scaled breaks round to the same value (which would collapse a colour bin). */
function ceilNiceAbove(v: number): number {
  const exp = Math.floor(Math.log10(Math.max(v, 1)));
  for (let k = exp; k <= exp + 2; k++) {
    const base = 10 ** k;
    for (const m of NICE_MANTISSAS) {
      if (m * base > v) return m * base;
    }
  }
  return v * 2;
}

/** Step thresholds (length 5: a leading 0 then four scaled breaks) for a window of
 *  `windowYears` years. The leading 0 splits decreases (green) from increases. The
 *  per-year breaks are scaled by the window then snapped to nice numbers, kept
 *  strictly increasing so no bin collapses at short windows. */
export function changeStops(windowYears: number): number[] {
  const n = Math.max(1, windowYears);
  const breaks: number[] = [];
  for (const c of CHANGE_STOP_PER_YEAR) {
    let b = roundNice(c * n);
    const prev = breaks[breaks.length - 1];
    if (prev !== undefined && b <= prev) b = ceilNiceAbove(prev);
    breaks.push(b);
  }
  return [0, ...breaks];
}

/** Legend labels for a given `changeStops` array (length 6, matching the colours). */
export function changeLegend(stops: number[]): string[] {
  return [
    '↓ decrease',
    `0–${stops[1]}%`,
    `${stops[1]}–${stops[2]}%`,
    `${stops[2]}–${stops[3]}%`,
    `${stops[3]}–${stops[4]}%`,
    `${stops[4]}%+`,
  ];
}

/** Choropleth metrics, selectable via the switcher. `recent_change` colours by
 *  `range_change_pct` — a client-computed % move in the parcel's median MAR
 *  between a user-chosen baseline and end year (see MapView). Mostly-increasing,
 *  so a single decrease bin then a sequential ramp; no-data parcels render grey. */
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
    property: 'range_change_pct',
    label: 'MAR change',
    // stops/legend are recomputed per selected window at runtime (changeStops);
    // these defaults (a ~6-year window) only seed the type.
    stops: changeStops(6),
    colors: RECENT_CHANGE_COLORS,
    legend: changeLegend(changeStops(6)),
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

/** Colour expression for the MAR-change metric at a given set of window-scaled
 *  `stops`: parcels carrying a defined % change (`range_has_data` === 1) use the
 *  warm step ramp; the rest (no controlled MAR in the baseline year) render as the
 *  flat no-data grey. */
export function recentChangeColorExpression(stops: number[]): ExpressionSpecification {
  const step: unknown[] = ['step', ['get', 'range_change_pct'], RECENT_CHANGE_COLORS[0]];
  for (let i = 0; i < stops.length; i++) {
    step.push(stops[i], RECENT_CHANGE_COLORS[i + 1]);
  }
  return [
    'case',
    ['==', ['get', 'range_has_data'], 1],
    step,
    NO_DATA_COLOR,
  ] as unknown as ExpressionSpecification;
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
