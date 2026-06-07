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

/** PR3 ships the unit-count choropleth; the metric switcher (PR7) adds more. */
export const METRICS = {
  unit_count: {
    property: 'unit_count',
    label: 'Units per parcel',
    stops: [2, 4, 10, 25, 50],
    colors: ['#dbe9f6', '#9ecae1', '#5fa8d3', '#3576b5', '#1d4e89', '#08233f'],
    legend: ['1', '2–3', '4–9', '10–24', '25–49', '50+'],
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

/** Base-relative URL for a build-time data artifact (Project Pages base path). */
export function dataUrl(file: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${base}/data/${file}`;
}
