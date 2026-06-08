/** MAR-history chart for the detail panel, via Observable Plot. Imported
 *  dynamically by the map island (only when a panel opens) so Plot/d3 stay out
 *  of the initial bundle. */
import * as Plot from '@observablehq/plot';
import type {
  MarByTenancyVintage,
  MarHistoryPoint,
  RentByBedroom,
  RentOverTimeSeries,
} from './types';

/**
 * Step lines of each unit's MAR over time. The registry's change log is sparse
 * (one point per change, carry-forward in between), so a step curve is the
 * faithful shape. Exempt ($0) points are dropped from the lines.
 */
export function marHistoryChart(history: MarHistoryPoint[], width: number): HTMLElement | SVGSVGElement {
  const data = history
    .filter((p) => p.mar_cents > 0)
    .map((p) => ({
      date: new Date(p.observed_at),
      mar: p.mar_cents / 100,
      unit: p.unit_label || '—',
    }));

  return Plot.plot({
    width: Math.max(260, width),
    height: 200,
    marginLeft: 52,
    marginBottom: 28,
    style: { background: 'transparent', fontSize: '10px' },
    x: { label: null, grid: false },
    y: { label: 'MAR ($)', grid: true, tickFormat: (d: number) => `$${(d / 1000).toFixed(1)}k` },
    color: { legend: false },
    marks: [
      Plot.lineY(data, {
        x: 'date',
        y: 'mar',
        z: 'unit',
        stroke: 'unit',
        curve: 'step-after',
        strokeWidth: 1.4,
      }),
      Plot.dot(data, { x: 'date', y: 'mar', fill: 'unit', r: 2.5 }),
    ],
  });
}

/**
 * Median Maximum Allowable Rent by bedroom count — a bar per bucket (Studio / 1
 * / 2 / 3+ BR) with a 25th–75th-percentile whisker overlaid to show the spread.
 * Controlled units only (exempt $0 units are excluded upstream in build-data).
 */
export function rentByBedroomChart(
  rows: RentByBedroom[],
  width: number,
): HTMLElement | SVGSVGElement {
  const data = rows.map((r) => ({
    bedroom: r.label,
    median: r.median_cents / 100,
    p25: r.p25_cents / 100,
    p75: r.p75_cents / 100,
    count: r.count,
  }));

  return Plot.plot({
    width: Math.max(280, width),
    height: 380,
    marginLeft: 60,
    marginBottom: 38,
    marginTop: 24,
    style: { background: 'transparent', color: 'currentColor', fontSize: '12px' },
    x: { label: null, domain: data.map((d) => d.bedroom) },
    y: {
      label: 'Median MAR ($)',
      grid: true,
      zero: true,
      tickFormat: (d: number) => `$${(d / 1000).toFixed(1)}k`,
    },
    marks: [
      Plot.barY(data, { x: 'bedroom', y: 'median', fill: '#3576b5', fillOpacity: 0.85 }),
      // 25th–75th percentile spread.
      Plot.ruleX(data, {
        x: 'bedroom',
        y1: 'p25',
        y2: 'p75',
        stroke: 'currentColor',
        strokeOpacity: 0.5,
        strokeWidth: 1.5,
      }),
      // Median value label above each whisker.
      Plot.text(data, {
        x: 'bedroom',
        y: 'p75',
        text: (d: { median: number }) => `$${Math.round(d.median).toLocaleString()}`,
        dy: -8,
        fontSize: 12,
        fontWeight: 600,
        fill: 'currentColor',
      }),
      Plot.ruleY([0]),
    ],
  });
}

/**
 * Median MAR by bedroom count tracked across registry snapshots — one line per
 * bucket, a point at each snapshot date. History starts at the 2023 baseline and
 * gains a point per monthly sweep; with few snapshots the lines are short but
 * faithful. Controlled units only (medians computed as-of each date upstream).
 */
export function rentOverTimeChart(
  series: RentOverTimeSeries[],
  width: number,
): HTMLElement | SVGSVGElement {
  const data = series.flatMap((s) =>
    s.points
      .filter((p) => p.count > 0)
      .map((p) => ({ bedroom: s.label, date: new Date(p.date), mar: p.median_cents / 100 })),
  );

  return Plot.plot({
    width: Math.max(280, width),
    height: 360,
    marginLeft: 60,
    marginBottom: 34,
    marginTop: 20,
    style: { background: 'transparent', color: 'currentColor', fontSize: '12px' },
    x: { label: null, grid: false },
    y: {
      label: 'Median MAR ($)',
      grid: true,
      tickFormat: (d: number) => `$${(d / 1000).toFixed(1)}k`,
    },
    color: {
      legend: true,
      scheme: 'tableau10',
      domain: series.map((s) => s.label),
    },
    marks: [
      Plot.lineY(data, {
        x: 'date',
        y: 'mar',
        z: 'bedroom',
        stroke: 'bedroom',
        strokeWidth: 1.8,
        curve: 'monotone-x',
      }),
      Plot.dot(data, { x: 'date', y: 'mar', fill: 'bedroom', r: 3.5 }),
    ],
  });
}

/**
 * Allowed rent by tenancy vintage — for every controlled unit, its current MAR
 * (y) against the month-year its tenancy began (x), the Costa-Hawkins "rent by
 * vintage" story: recent tenancies sit near market, long ones far below. One
 * small-multiple facet per bedroom bucket (Studio / 1 / 2 / 3+ BR), each showing
 * a downsampled scatter underlay, a 25th–75th-percentile band, and the median
 * line over quarterly tenancy-vintage bins.
 *
 * Honest-data caveat (see charts-and-density.md #1): the y-value is the CURRENT
 * MAR — the rent set at tenancy start PLUS every General Adjustment since — not
 * the literal move-in rent (our observations only begin at the 2023 seed). The
 * tenancy date is the faithful reset date, hence "by vintage." Units with no
 * tenancy_date (long-term, no reset) have no x and are excluded upstream.
 */
/** Shared blues for the vintage chart — the legend swatches reuse these so the
 *  key always matches the marks. */
const VINTAGE_FILL = '#3576b5'; // scatter dots + IQR band
const VINTAGE_LINE = '#1f4e79'; // median line

export function marByTenancyVintageChart(
  vintage: MarByTenancyVintage,
  width: number,
): HTMLElement | SVGSVGElement {
  const order = vintage.buckets.map((b) => b.label);
  const capDollars = vintage.axis_cap_cents / 100;

  const scatter = vintage.buckets.flatMap((b) =>
    b.scatter.map((p) => ({
      bedroom: b.label,
      date: new Date(p.t),
      mar: p.mar_cents / 100,
    })),
  );
  const bins = vintage.buckets.flatMap((b) =>
    b.bins.map((bin) => ({
      bedroom: b.label,
      date: new Date(bin.period),
      median: bin.median_cents / 100,
      p25: bin.p25_cents / 100,
      p75: bin.p75_cents / 100,
    })),
  );

  const chart = Plot.plot({
    width: Math.max(280, width),
    height: 720,
    marginLeft: 56,
    marginRight: 14,
    marginBottom: 34,
    marginTop: 20,
    style: { background: 'transparent', color: 'currentColor', fontSize: '11px' },
    x: { label: null, grid: false },
    y: {
      label: 'Allowed rent — current MAR ($)',
      grid: true,
      domain: [0, capDollars],
      tickFormat: (d: number) => `$${(d / 1000).toFixed(0)}k`,
    },
    fy: { label: null, domain: order },
    marks: [
      // Downsampled raw cloud (clamped to the axis cap so a few high-MAR large
      // units don't compress the view).
      Plot.dot(scatter, {
        x: 'date',
        y: 'mar',
        fy: 'bedroom',
        r: 1.3,
        fill: VINTAGE_FILL,
        fillOpacity: 0.18,
        clip: true,
      }),
      // 25th–75th percentile band per quarter.
      Plot.areaY(bins, {
        x: 'date',
        y1: 'p25',
        y2: 'p75',
        fy: 'bedroom',
        fill: VINTAGE_FILL,
        fillOpacity: 0.22,
        curve: 'monotone-x',
      }),
      // Median line per quarter.
      Plot.lineY(bins, {
        x: 'date',
        y: 'median',
        fy: 'bedroom',
        stroke: VINTAGE_LINE,
        strokeWidth: 1.6,
        curve: 'monotone-x',
      }),
      // Facet label (bedroom bucket) inside each panel.
      Plot.text(
        vintage.buckets.map((b) => ({ bedroom: b.label, count: b.count })),
        {
          fy: 'bedroom',
          frameAnchor: 'top-left',
          dx: 6,
          dy: 6,
          text: (d: { bedroom: string; count: number }) =>
            `${d.bedroom} · ${d.count.toLocaleString()} units`,
          fontWeight: 600,
          fill: 'currentColor',
        },
      ),
      Plot.ruleY([0]),
    ],
  });

  // Custom key — Plot has no single legend across three different mark types.
  // Swatches reuse the mark colors above so the key can't drift.
  const legend = document.createElement('div');
  legend.className = 'plot-legend';
  legend.innerHTML = [
    `<span class="lk"><span class="sw" style="background:${VINTAGE_FILL};opacity:.55;border-radius:50%;width:9px;height:9px"></span>individual units</span>`,
    `<span class="lk"><span class="sw" style="background:${VINTAGE_FILL};opacity:.30;width:15px;height:10px"></span>25th–75th percentile</span>`,
    `<span class="lk"><span class="sw" style="background:${VINTAGE_LINE};width:15px;height:3px"></span>median</span>`,
  ].join('');

  const wrap = document.createElement('div');
  wrap.append(legend, chart);
  return wrap;
}
