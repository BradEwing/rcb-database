/** MAR-history chart for the detail panel, via Observable Plot. Imported
 *  dynamically by the map island (only when a panel opens) so Plot/d3 stay out
 *  of the initial bundle. */
import * as Plot from '@observablehq/plot';
import type { MarByTenancyVintage, MarHistoryPoint, RentOverTimeSeries } from './types';

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
 * Median MAR by bedroom bucket over time — one line per bucket, reconstructed
 * as-of each month from the change log (portal filings back-fill to 2012; the
 * 2023-07 snapshot is from an RCB archive; live monthly scrapes begin 2026-06).
 * Line-only: at ~178 monthly points per series, per-point
 * dots are clutter. 3+ BR is omitted upstream pending issue #11. Controlled
 * units only (medians computed as-of each date upstream).
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
      zero: true,
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
      Plot.ruleY([0]),
    ],
  });
}

/**
 * Allowed rent by tenancy vintage — for every controlled unit, its current MAR
 * (y) against the month-year its tenancy began (x), the Costa-Hawkins "rent by
 * vintage" story: recent tenancies sit near market, long ones far below. A
 * single chart overlaying Studio / 1 BR / 2 BR (3+ BR is excluded — small,
 * spiky bins, and we already omit it from the over-time chart pending issue
 * #11), each bucket a 25th–75th-percentile band plus median line over quarterly
 * tenancy-vintage bins, one colour per bucket, togglable from the legend chips.
 * Deliberately no raw-unit scatter: a few very high-MAR units stretched the
 * y-range and washed out the distributional story.
 *
 * Honest-data caveat (see charts-and-density.md #1): the y-value is the CURRENT
 * MAR — the rent set at tenancy start PLUS every General Adjustment since — not
 * the literal move-in rent (direct MAR observations only begin with the 2023
 * RCB-archive snapshot; live scrapes begin 2026-06). The
 * tenancy date is the faithful reset date, hence "by vintage." Units with no
 * tenancy_date (long-term, no reset) have no x and are excluded upstream.
 */
/** Colour per bedroom bucket — the first three of tableau10, matching the
 *  over-time chart's scheme so a bucket keeps its colour across the page. */
const VINTAGE_COLORS: Record<string, string> = {
  Studio: '#4e79a7',
  '1 BR': '#f28e2c',
  '2 BR': '#e15759',
};

/** Centered 5-quarter (~15-month) rolling mean over the quarterly medians/IQR.
 *  Sparse quarters (often n=10–30 units) make the raw quarterly stats jumpy —
 *  sampling noise, not signal. A ~1-year window kills that while keeping real
 *  multi-quarter features (e.g. the 2020–21 dip); `strict: false` averages what
 *  exists at the series edges instead of truncating them. */
const VINTAGE_SMOOTHING = { k: 5, anchor: 'middle', strict: false } as const;

export function marByTenancyVintageChart(
  vintage: MarByTenancyVintage,
  width: number,
): HTMLElement | SVGSVGElement {
  const shown = vintage.buckets.filter((b) => b.bucket !== '3+');
  const labels = shown.map((b) => b.label);
  const active = new Set(labels);

  // x domain fixed across toggles so the time axis never jumps.
  const allTimes = shown.flatMap((b) => b.bins.map((bin) => new Date(bin.period).getTime()));
  const xDomain: [Date, Date] = [new Date(Math.min(...allTimes)), new Date(Math.max(...allTimes))];

  const wrap = document.createElement('div');
  const toggles = document.createElement('div');
  toggles.className = 'plot-legend';
  const chartHost = document.createElement('div');

  const render = (): void => {
    const bins = shown
      .filter((b) => active.has(b.label))
      .flatMap((b) =>
        b.bins.map((bin) => ({
          bedroom: b.label,
          date: new Date(bin.period),
          median: bin.median_cents / 100,
          p25: bin.p25_cents / 100,
          p75: bin.p75_cents / 100,
        })),
      );
    // Zero-based y, compressed to the visible bands (hide 2 BR and the rest
    // stretch to fill).
    const maxDollars = Math.max(...bins.map((d) => d.p75));

    chartHost.replaceChildren(
      Plot.plot({
        width: Math.max(280, width),
        height: 420,
        marginLeft: 56,
        marginRight: 14,
        marginBottom: 34,
        marginTop: 20,
        style: { background: 'transparent', color: 'currentColor', fontSize: '11px' },
        x: { label: null, grid: false, domain: xDomain },
        y: {
          label: 'Allowed rent — current MAR ($)',
          grid: true,
          domain: [0, maxDollars],
          nice: true,
          tickFormat: (d: number) => `$${(d / 1000).toFixed(d < 1000 ? 1 : 0)}k`,
        },
        color: { domain: labels, range: labels.map((l) => VINTAGE_COLORS[l]!) },
        marks: [
          // 25th–75th percentile band, smoothed like the line so they agree.
          Plot.areaY(
            bins,
            Plot.windowY(VINTAGE_SMOOTHING, {
              x: 'date',
              y1: 'p25',
              y2: 'p75',
              fill: 'bedroom',
              fillOpacity: 0.16,
              curve: 'monotone-x',
            }),
          ),
          // Median line: rolling mean of the quarterly medians.
          Plot.lineY(
            bins,
            Plot.windowY(VINTAGE_SMOOTHING, {
              x: 'date',
              y: 'median',
              stroke: 'bedroom',
              strokeWidth: 1.8,
              curve: 'monotone-x',
            }),
          ),
          Plot.ruleY([0]),
        ],
      }),
    );
  };

  // Legend chips double as show/hide toggles, one per bucket.
  for (const b of shown) {
    const color = VINTAGE_COLORS[b.label]!;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lk plot-toggle';
    btn.setAttribute('aria-pressed', 'true');
    btn.innerHTML =
      `<span class="sw" style="background:${color};width:12px;height:12px;border-radius:3px"></span>` +
      `${b.label} · ${b.count.toLocaleString()}`;
    btn.addEventListener('click', () => {
      if (active.has(b.label)) {
        if (active.size === 1) return; // keep at least one bucket visible
        active.delete(b.label);
      } else {
        active.add(b.label);
      }
      const on = active.has(b.label);
      btn.setAttribute('aria-pressed', String(on));
      btn.style.opacity = on ? '' : '0.4';
      render();
    });
    toggles.append(btn);
  }
  // Static key for the two mark types (shared across buckets).
  const key = document.createElement('span');
  key.className = 'lk';
  key.innerHTML =
    `<span class="sw" style="background:currentColor;opacity:.18;width:15px;height:10px"></span>25th–75th pct` +
    `<span class="sw" style="background:currentColor;width:15px;height:3px;margin-left:.6rem"></span>median`;
  toggles.append(key);

  wrap.append(toggles, chartHost);
  render();
  return wrap;
}
