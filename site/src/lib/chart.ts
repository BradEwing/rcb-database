/** MAR-history chart for the detail panel, via Observable Plot. Imported
 *  dynamically by the map island (only when a panel opens) so Plot/d3 stay out
 *  of the initial bundle. */
import * as Plot from '@observablehq/plot';
import type {
  Cohorts,
  CpiDeflator,
  MarByTenancyVintage,
  MarHistoryPoint,
  NewTenancyHistogram,
  NewTenancyMonthly,
  NewTenancyRent,
  RentOverTimeSeries,
  VintageBucket,
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
 *  over-time chart's scheme so a bucket keeps its colour across the page.
 *  3+ BR (histogram only today) is a teal chosen over tableau10's #76b7b2 for
 *  chroma + surface contrast, CVD-checked against its neighbours on both the
 *  light and dark surface. */
const VINTAGE_COLORS: Record<string, string> = {
  Studio: '#4e79a7',
  '1 BR': '#f28e2c',
  '2 BR': '#e15759',
  '3+ BR': '#2a9d8f',
};

/* ------------------------------------------------------------------------- *
 *  CPI deflation (constant-dollar chart views)
 * ------------------------------------------------------------------------- */

/** month "YYYY-MM" one step back. */
function prevMonth(m: string): string {
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7)) - 1;
  return mo === 0 ? `${y - 1}-12` : `${y}-${String(mo).padStart(2, '0')}`;
}

/** month "YYYY-MM" → multiplier into constant base-month dollars. Months absent
 *  from the index (unpublished — e.g. the 2025-10 shutdown gap — or newer than
 *  the cache) carry the prior month forward; anything unresolvable after a
 *  3-year walk-back deflates by 1 (i.e. stays nominal) rather than lying. */
function deflatorOf(cpi: CpiDeflator): (month: string) => number {
  const base = cpi.points[cpi.base];
  if (!base) return () => 1;
  return (month) => {
    let m = month;
    for (let i = 0; i < 36; i++) {
      const v = cpi.points[m];
      if (v) return base / v;
      m = prevMonth(m);
    }
    return 1;
  };
}

/** "2026-05" → "May 2026" (the constant-dollar base period, for labels). */
function baseLabelOf(cpi: CpiDeflator): string {
  return new Date(`${cpi.base}-01T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Legend-row chip toggling nominal ⇄ constant-dollar mode. Same chip idiom as
 *  the bucket toggles; a pressed chip means "inflation-adjusted". */
function inflationToggle(
  cpi: CpiDeflator,
  initialReal: boolean,
  onChange: (real: boolean) => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lk plot-toggle';
  let real = initialReal;
  const paint = (): void => {
    btn.setAttribute('aria-pressed', String(real));
    btn.style.opacity = real ? '' : '0.4';
    btn.textContent = `constant ${baseLabelOf(cpi)} $`;
  };
  paint();
  btn.addEventListener('click', () => {
    real = !real;
    paint();
    onChange(real);
  });
  return btn;
}

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
  return quarterlyBandChart(vintage.buckets, width, 'Current MAR ($)');
}

/**
 * New-tenancy rents over time — the vintage chart's companion, with the y-value
 * anchored at the reset instead of today: for tenancies established in each
 * quarter (x), the rent actually set at that time (earliest GA-clean observation
 * of each establishment event — see charts-and-density.md #4). Where the vintage
 * chart answers "what do tenants who moved in then pay NOW," this answers "what
 * was the going rate for a new tenancy THEN." Same bands, smoothing, and legend
 * toggles; 3+ BR excluded to match.
 */
export function newTenancyRentChart(
  data: NewTenancyRent,
  width: number,
  cpi?: CpiDeflator,
): HTMLElement | SVGSVGElement {
  return quarterlyBandChart(data.buckets, width, 'New-tenancy rent ($)', cpi);
}

/**
 * New-tenancy rents each month, as a bubble scatter — the raw-dot companion to
 * the smoothed band chart above. One dot per (bedroom, month): x = the tenancy-
 * start month, y = the median rent set at that month's GA-clean resets, and the
 * dot's AREA is proportional to the number of new tenancies that month (Plot's
 * `r` channel is a sqrt scale by default, so radius ∝ √count → area ∝ count).
 * Deliberately unsmoothed and monthly, so sparse early months read as small,
 * low-confidence dots and well-sampled recent months as large ones (the shape of
 * the reference "initial rents" bubble charts).
 *
 * Bubbles overlap far more than the band chart's translucent regions, so this
 * defaults to a single bucket (1 BR — the most-populated) rather than all three;
 * the legend chips add Studio / 2 BR back. 3+ BR is excluded to match the other
 * charts (issue #11). Honest-data framing is the same as the band chart: the
 * y-value is the rent as-of the reset (earliest GA-clean observation), not a
 * literal lease amount.
 */
export function newTenancyMonthlyChart(
  data: NewTenancyMonthly,
  width: number,
  cpi?: CpiDeflator,
): HTMLElement {
  const shown = data.buckets.filter((b) => b.bucket !== '3+' && b.months.length > 0);
  const labels = shown.map((b) => b.label);
  // Default to 1 BR alone (most-populated, and the reference cut); fall back to
  // the first bucket with data if 1 BR is somehow absent.
  const initial = shown.find((b) => b.bucket === '1') ?? shown[0];
  const active = new Set<string>(initial ? [initial.label] : []);
  const deflate = cpi ? deflatorOf(cpi) : null;
  let real = false;

  // Fix the x domain and the r domain across ALL buckets so toggling a bucket
  // shifts neither the time axis nor the bubble-size scale.
  const allTimes = shown.flatMap((b) => b.months.map((m) => new Date(m.period).getTime()));
  const xDomain: [Date, Date] = [new Date(Math.min(...allTimes)), new Date(Math.max(...allTimes))];
  const maxCount = Math.max(1, ...shown.flatMap((b) => b.months.map((m) => m.count)));

  const wrap = document.createElement('div');
  const toggles = document.createElement('div');
  toggles.className = 'plot-legend';
  const chartHost = document.createElement('div');

  const render = (): void => {
    const bubbles = shown
      .filter((b) => active.has(b.label))
      .flatMap((b) =>
        b.months.map((m) => {
          const k = real && deflate ? deflate(m.period.slice(0, 7)) : 1;
          const rent = (m.median_cents / 100) * k;
          const monthLabel = new Date(m.period).toLocaleDateString('en-US', {
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC', // YYYY-MM-01 parses as UTC midnight; keep the label on that month
          });
          return {
            bedroom: b.label,
            date: new Date(m.period),
            rent,
            count: m.count,
            tip:
              `${monthLabel} · ${b.label}\n` +
              `median $${Math.round(rent).toLocaleString()}` +
              (real && cpi ? ` (${baseLabelOf(cpi)} $)` : '') +
              `\nn = ${m.count.toLocaleString()} new ${m.count === 1 ? 'tenancy' : 'tenancies'}`,
          };
        }),
      )
      // Draw the biggest bubbles first (at the back) so small ones stay visible.
      .sort((a, b) => b.count - a.count);

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
          label:
            real && cpi
              ? `New-tenancy rent (constant ${baseLabelOf(cpi)} $)`
              : 'New-tenancy rent ($)',
          labelArrow: 'none',
          grid: true,
          nice: true,
          tickFormat: (d: number) =>
            `$${Number.isInteger(d / 1000) ? d / 1000 : (d / 1000).toFixed(1)}k`,
        },
        // sqrt scale (Plot default for r) → bubble AREA ∝ count. Fixed domain so
        // a given count is the same size regardless of which buckets are shown.
        r: { domain: [0, maxCount], range: [0, 16] },
        color: { domain: labels, range: labels.map((l) => VINTAGE_COLORS[l] ?? 'currentColor') },
        marks: [
          Plot.dot(bubbles, {
            x: 'date',
            y: 'rent',
            r: 'count',
            fill: 'bedroom',
            fillOpacity: 0.5,
            stroke: 'bedroom',
            strokeWidth: 0.6,
            strokeOpacity: 0.9,
          }),
          // Instant hover tooltip (month · bucket, median, n) — Plot.pointer
          // snaps to the nearest bubble; the theme vars keep the tip box
          // readable in dark mode (Plot's default fill is hard-coded white).
          Plot.tip(
            bubbles,
            Plot.pointer({
              x: 'date',
              y: 'rent',
              title: 'tip',
              fill: 'var(--bg)',
              stroke: 'var(--muted)',
              fontSize: 11,
            }),
          ),
        ],
      }),
    );
  };

  // Legend chips double as show/hide toggles, one per bucket (round swatch to
  // signal "bubbles"). At least one bucket stays visible.
  for (const b of shown) {
    const color = VINTAGE_COLORS[b.label] ?? 'currentColor';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lk plot-toggle';
    const on0 = active.has(b.label);
    btn.setAttribute('aria-pressed', String(on0));
    btn.style.opacity = on0 ? '' : '0.4';
    btn.innerHTML =
      `<span class="sw" style="background:${color};width:12px;height:12px;border-radius:50%"></span>` +
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
  const key = document.createElement('span');
  key.className = 'lk';
  key.textContent = 'bubble area ∝ new tenancies that month';
  toggles.append(key);
  if (cpi) {
    toggles.append(
      inflationToggle(cpi, real, (r) => {
        real = r;
        render();
      }),
    );
  }

  wrap.append(toggles, chartHost);
  render();
  return wrap;
}

/**
 * Distribution of rents at recent tenancy starts, faceted by bedroom count —
 * one row per bucket, bars = share of that bucket's GA-clean reset events per
 * $250 bin, and a hollow dot at the bucket's median (the "going rate right
 * now" view). Shares (not raw counts) per facet so Studio (n≈170) and 1 BR
 * (n≈740) read on the same footing; the note carries the counts. 3+ BR IS
 * shown here — the window holds only recent, directly-observed events, so the
 * issue-#11 portal-boundary anomaly that keeps 3+ BR out of the reconstructed
 * time series doesn't apply.
 */
export function newTenancyHistogramChart(
  data: NewTenancyHistogram,
  width: number,
): HTMLElement {
  const buckets = data.buckets.filter((b) => b.count > 0);
  const labels = buckets.map((b) => b.label);
  const binW = data.bin_width_cents / 100;
  const capDollars = data.cap_cents / 100;

  const bars = buckets.flatMap((b) =>
    b.bins.map((bin) => {
      const lo = bin.lo_cents / 100;
      const share = bin.count / b.count;
      return {
        bucket: b.label,
        lo,
        hi: lo + binW,
        share,
        tip:
          `${b.label} · $${lo.toLocaleString()}–$${(lo + binW).toLocaleString()}\n` +
          `${bin.count.toLocaleString()} ${bin.count === 1 ? 'tenancy' : 'tenancies'}` +
          ` (${(share * 100).toFixed(1)}% of ${b.label})`,
      };
    }),
  );
  const medians = buckets.map((b) => ({
    bucket: b.label,
    median: b.median_cents / 100,
    tip: `${b.label} median · $${Math.round(b.median_cents / 100).toLocaleString()}`,
  }));

  const wrap = document.createElement('div');
  const legend = document.createElement('div');
  legend.className = 'plot-legend';
  for (const b of buckets) {
    const chip = document.createElement('span');
    chip.className = 'lk';
    chip.innerHTML =
      `<span class="sw" style="background:${VINTAGE_COLORS[b.label] ?? 'currentColor'};` +
      `width:12px;height:12px;border-radius:3px"></span>` +
      `${b.label} · ${b.count.toLocaleString()}`;
    legend.append(chip);
  }
  const key = document.createElement('span');
  key.className = 'lk';
  key.innerHTML =
    `<span class="sw" style="background:var(--bg);border:1.5px solid currentColor;` +
    `width:10px;height:10px;border-radius:50%"></span>median`;
  legend.append(key);

  wrap.append(
    legend,
    Plot.plot({
      width: Math.max(280, width),
      height: 90 * buckets.length + 40,
      marginLeft: 8,
      marginRight: 46,
      marginBottom: 32,
      style: { background: 'transparent', color: 'currentColor', fontSize: '11px' },
      x: {
        label: 'Rent set at tenancy start ($)',
        labelArrow: 'none',
        domain: [0, capDollars],
        grid: true,
        tickFormat: (d: number) => `$${d / 1000}k`,
      },
      // Share-of-bucket bars; the exact percentages live in the hover tip, so
      // the y axis stays silent and each facet reads as a shape.
      y: { axis: null },
      // Facets are labelled by in-plot text marks below (the default fy axis
      // sits in the left margin, which this layout keeps at 8px).
      fy: { domain: labels, label: null, axis: null },
      color: { domain: labels, range: labels.map((l) => VINTAGE_COLORS[l] ?? 'currentColor') },
      marks: [
        Plot.text(
          buckets.map((b) => ({ bucket: b.label })),
          {
            fy: 'bucket',
            text: 'bucket',
            frameAnchor: 'top-left',
            dx: 4,
            dy: 4,
            fill: 'currentColor',
            fontWeight: 600,
          },
        ),
        Plot.rectY(bars, {
          x1: 'lo',
          x2: 'hi',
          y: 'share',
          fy: 'bucket',
          fill: 'bucket',
          insetLeft: 0.5,
          insetRight: 0.5,
        }),
        Plot.dotX(medians, {
          x: 'median',
          fy: 'bucket',
          r: 4.5,
          fill: 'var(--bg)',
          stroke: 'currentColor',
          strokeWidth: 1.4,
        }),
        Plot.tip(
          bars,
          Plot.pointerX({
            x: (d: { lo: number; hi: number }) => (d.lo + d.hi) / 2,
            y: 'share',
            fy: 'bucket',
            title: 'tip',
            fill: 'var(--bg)',
            stroke: 'var(--muted)',
            fontSize: 11,
          }),
        ),
        Plot.ruleY([0]),
      ],
    }),
  );
  return wrap;
}

/** Shared renderer for the two quarterly median+IQR-by-bedroom charts: one
 *  colour per bucket, legend-chip toggles, rolling-mean smoothing. 3+ BR is
 *  dropped here (small, spiky bins — and it stays out of every chart pending
 *  issue #11). When a CPI index is supplied, a legend chip toggles the y-values
 *  into constant base-month dollars (each quarter deflated by its own month —
 *  nominal by default, matching the chart as originally shipped). */
function quarterlyBandChart(
  buckets: VintageBucket[],
  width: number,
  yLabel: string,
  cpi?: CpiDeflator,
): HTMLElement {
  const shown = buckets.filter((b) => b.bucket !== '3+');
  const labels = shown.map((b) => b.label);
  const active = new Set(labels);
  const deflate = cpi ? deflatorOf(cpi) : null;
  let real = false;

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
        b.bins.map((bin) => {
          const k = real && deflate ? deflate(bin.period.slice(0, 7)) : 1;
          return {
            bedroom: b.label,
            date: new Date(bin.period),
            median: (bin.median_cents / 100) * k,
            p25: (bin.p25_cents / 100) * k,
            p75: (bin.p75_cents / 100) * k,
          };
        }),
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
          label: real && cpi ? yLabel.replace('($)', `(constant ${baseLabelOf(cpi)} $)`) : yLabel,
          labelArrow: 'none',
          grid: true,
          domain: [0, maxDollars],
          nice: true,
          // Integer thousands stay terse ($3k); off-grid ticks keep one decimal
          // ($4.5k) so 500-step tick domains don't round into duplicate labels.
          tickFormat: (d: number) =>
            `$${Number.isInteger(d / 1000) ? d / 1000 : (d / 1000).toFixed(1)}k`,
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
  if (cpi) {
    toggles.append(
      inflationToggle(cpi, real, (r) => {
        real = r;
        render();
      }),
    );
  }

  wrap.append(toggles, chartHost);
  render();
  return wrap;
}

/* ------------------------------------------------------------------------- *
 *  Move-in cohorts (tenancy-start-year trajectories + coverage heatmap)
 * ------------------------------------------------------------------------- */

/** Cohort-years thinner than this are hidden from the trajectory lines — a
 *  median over a few dozen units is sampling noise, not a cohort's rent. The
 *  heatmap below the chart shows the full count surface, including what this
 *  threshold hides. */
const COHORT_MIN_COUNT = 100;

/** Anchor colours of the cohort ramp (oldest → newest), interpolated across
 *  however many cohorts qualify. Hand-picked mid-lightness purple → blue → teal
 *  so BOTH ends stay legible on the light and dark surface (the off-the-shelf
 *  "cool"/viridis ramps end in near-yellow, which washes out on light). */
const COHORT_RAMP = ['#6e40aa', '#3f7fc2', '#12a99e'] as const;

/** Piecewise-linear sRGB blend through COHORT_RAMP at t ∈ [0, 1]. Colour here
 *  encodes ORDER only (exact identity rides on the hover tip), so a simple
 *  blend is enough — no perceptual-space interpolation needed. */
function cohortColor(t: number): string {
  const stops = COHORT_RAMP.map((h) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ]);
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const c = stops[i]!.map((a, k) => Math.round(a + (stops[i + 1]![k]! - a) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/**
 * Cohort rent trajectories — one line per move-in year: units are grouped by
 * the start year of the tenancy in effect (so a unit leaves its cohort when
 * re-let), and each point is the cohort's median MAR as-of that year's end,
 * reconstructed from the change log. Deflated to constant base-month dollars
 * by default (toggle back to nominal): flat-ish nominal steps become gently
 * falling real lines — rent control holding sitting tenants' real rent down —
 * while each newer cohort enters higher (vacancy decontrol).
 *
 * Colour encodes the cohort's ORDER (start year), so it's a sequential ramp —
 * purple (oldest) → teal (newest) — with a gradient key, not per-line legend
 * chips; exact identity rides on the hover tip. Cohort-years with fewer than
 * COHORT_MIN_COUNT units are hidden (the heatmap shows the full counts).
 */
export function cohortRentChart(
  cohorts: Cohorts,
  width: number,
  cpi: CpiDeflator | undefined,
  latestSweep: string,
): HTMLElement {
  const byStart = new Map<number, typeof cohorts.cells>();
  for (const c of cohorts.cells) {
    if (c.count < COHORT_MIN_COUNT) continue;
    const list = byStart.get(c.start);
    if (list) list.push(c);
    else byStart.set(c.start, [c]);
  }
  for (const [start, list] of byStart) if (list.length < 2) byStart.delete(start); // a line needs 2 points
  const starts = [...byStart.keys()].sort((a, b) => a - b);

  const lastYear = cohorts.years[cohorts.years.length - 1] ?? 0;
  const sweepMonth = latestSweep.slice(0, 7);
  const deflate = cpi ? deflatorOf(cpi) : null;
  // Deflate each observation year by its as-of month: December of that year,
  // except the final (live-sweep) year, which is only as fresh as the sweep.
  const factorOf = (year: number): number =>
    deflate ? deflate(year === lastYear ? sweepMonth : `${year}-12`) : 1;

  const wrap = document.createElement('div');
  const toggles = document.createElement('div');
  toggles.className = 'plot-legend';
  const chartHost = document.createElement('div');
  let real = Boolean(cpi);

  const render = (): void => {
    const rows = starts.flatMap((s) =>
      byStart.get(s)!.map((c) => {
        const nominal = c.median_cents / 100;
        const rent = real ? nominal * factorOf(c.year) : nominal;
        return {
          start: s,
          year: c.year,
          rent,
          tip:
            `moved in ${s}\n` +
            `${c.year}: $${Math.round(rent).toLocaleString()}` +
            (real ? ` (${baseLabelOf(cpi!)} $)` : '') +
            `\nn = ${c.count.toLocaleString()} units`,
        };
      }),
    );

    chartHost.replaceChildren(
      Plot.plot({
        width: Math.max(280, width),
        height: 420,
        marginLeft: 56,
        marginRight: 14,
        marginBottom: 34,
        marginTop: 20,
        style: { background: 'transparent', color: 'currentColor', fontSize: '11px' },
        x: { label: null, grid: false, tickFormat: (d: number) => String(d) },
        y: {
          label: real ? `Median rent (constant ${baseLabelOf(cpi!)} $)` : 'Median rent ($)',
          labelArrow: 'none',
          grid: true,
          nice: true,
          tickFormat: (d: number) =>
            `$${Number.isInteger(d / 1000) ? d / 1000 : (d / 1000).toFixed(1)}k`,
        },
        color: {
          type: 'ordinal',
          domain: starts,
          range: starts.map((_, i) => cohortColor(starts.length < 2 ? 1 : i / (starts.length - 1))),
        },
        marks: [
          Plot.lineY(rows, {
            x: 'year',
            y: 'rent',
            z: 'start',
            stroke: 'start',
            strokeWidth: 1.7,
            marker: 'dot',
          }),
          Plot.tip(
            rows,
            Plot.pointer({
              x: 'year',
              y: 'rent',
              title: 'tip',
              fill: 'var(--bg)',
              stroke: 'var(--muted)',
              fontSize: 11,
            }),
          ),
        ],
      }),
    );
  };

  const key = document.createElement('span');
  key.className = 'lk';
  key.innerHTML =
    `<span class="sw" style="background:linear-gradient(90deg,${COHORT_RAMP.join(',')});` +
    `width:44px;height:10px;border-radius:2px"></span>` +
    `moved in ${starts[0] ?? ''} → ${starts[starts.length - 1] ?? ''}`;
  toggles.append(key);
  if (cpi) {
    toggles.append(
      inflationToggle(cpi, real, (r) => {
        real = r;
        render();
      }),
    );
  }

  wrap.append(toggles, chartHost);
  render();
  return wrap;
}

/**
 * Cohort × year coverage heatmap — the companion that shows how many units
 * stand behind each cohort-year median: x = observation year, y = move-in
 * year (newest at top), cell darkness = unit count (sqrt scale, so the thin
 * old cohorts don't vanish next to 3,000-unit recent ones). This is also the
 * honest-data view: pre-2023 columns cover only portal-backfilled units, and
 * a cohort's row fades to the right as its tenancies end. Dark mode gets its
 * own ramp (dim → bright) rather than a flipped light ramp.
 */
export function cohortHeatmapChart(cohorts: Cohorts, width: number): HTMLElement | SVGSVGElement {
  const years = cohorts.years;
  const starts = [...new Set(cohorts.cells.map((c) => c.start))].sort((a, b) => b - a);
  const rows = cohorts.cells.map((c) => ({
    year: c.year,
    start: c.start,
    count: c.count,
    tip:
      `moved in ${c.start} · as of ${c.year}\n` +
      `${c.count.toLocaleString()} ${c.count === 1 ? 'unit' : 'units'}` +
      ` · median $${Math.round(c.median_cents / 100).toLocaleString()}`,
  }));

  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  return Plot.plot({
    width: Math.max(280, width),
    height: starts.length * 13 + 74,
    marginLeft: 8,
    marginRight: 44,
    marginBottom: 50, // room for the rotated ticks AND the axis label below them
    style: { background: 'transparent', color: 'currentColor', fontSize: '10.5px' },
    x: {
      label: 'As of year',
      labelArrow: 'none',
      domain: years,
      tickFormat: (d: number) => String(d),
      tickRotate: -45,
    },
    y: {
      label: 'Moved in',
      domain: starts,
      axis: 'right',
      tickFormat: (d: number) => String(d),
      ticks: starts.filter((s) => s % 5 === 0),
    },
    color: {
      type: 'sqrt',
      range: dark ? ['#1f2c40', '#9ecae1'] : ['#e5edf7', '#0b3d6b'],
      label: 'units',
      legend: true,
    },
    marks: [
      Plot.cell(rows, { x: 'year', y: 'start', fill: 'count', inset: 0.5 }),
      Plot.tip(
        rows,
        Plot.pointer({
          x: 'year',
          y: 'start',
          title: 'tip',
          fill: 'var(--bg)',
          stroke: 'var(--muted)',
          fontSize: 11,
        }),
      ),
    ],
  });
}
