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
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  SITE_DATA_DIR,
  GEOMETRY_CACHE,
  BOUNDARY_CACHE,
  UNITS_CSV,
  OBS_CSV,
  SWEEPS_CSV,
  CHANGES_CSV,
  EXITS_CSV,
  RECON_SUMMARY_CSV,
  readCsv,
  g,
  normApn,
  latestMarByUnit,
  latestSweepDate,
  median,
  sizeClassOf,
  bedroomBucket,
  type Row,
  type LatestMar,
} from "./lib/registry.ts";

/** Fail the build if fewer than this fraction of referenced APNs have geometry.
 *  Observed coverage at seed is 98.86%; 0.95 leaves margin for month-to-month
 *  drift while still catching a real join regression (wrong field, stale cache). */
const MIN_MATCH_RATE = 0.95;

/** One row of the per-APN detail's unit table. Mirrors the `UnitDetail` type in
 *  site/src/lib/types.ts (the two must stay in sync). */
type UnitDetail = {
  unit_id: string;
  address: string;
  unit_label: string;
  bedrooms: string;
  mar_cents: number;
  mar_status: "controlled" | "exempt";
  tenancy_date: string;
};

/** A rent-change event on a parcel (mar_changes.csv row, compacted). Mirrors
 *  `ParcelChange` in site/src/lib/types.ts. */
type ParcelChange = {
  observed_at: string;
  unit_label: string;
  old_mar_cents: number;
  new_mar_cents: number;
  delta_cents: number;
  delta_pct: number;
  reason: string;
  mar_status_change: string;
};

/** A unit that vanished from the latest sweep (unit_exits.csv row). Mirrors
 *  `ParcelExit` in site/src/lib/types.ts. */
type ParcelExit = {
  unit_label: string;
  bedrooms: string;
  last_seen_at: string;
  last_mar_cents: number;
  last_tenancy: string;
};

/** One point in a unit's MAR series (an observation in the change log). Mirrors
 *  `MarHistoryPoint` in site/src/lib/types.ts. */
type MarHistoryPoint = {
  unit_label: string;
  observed_at: string;
  mar_cents: number;
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

/** Group every unit (with its carry-forward MAR) under its APN. units.csv is the
 *  source of truth for the parcel universe and unit grouping (never parcels.csv).
 *  Units within a parcel are ordered by address, then unit label (numeric-aware),
 *  so the detail table and any diffs are deterministic. */
function groupUnitsByApn(
  units: Row[],
  latestMar: Map<string, LatestMar>,
): Map<string, UnitDetail[]> {
  const byApn = new Map<string, UnitDetail[]>();
  for (const u of units) {
    const apn = normApn(g(u, "apn"));
    if (!apn) continue;
    const mar = latestMar.get(g(u, "unit_id"));
    const cents = mar?.mar_amount_cents ?? 0;
    const detail: UnitDetail = {
      unit_id: g(u, "unit_id"),
      address: g(u, "address"),
      unit_label: g(u, "unit_label"),
      bedrooms: g(u, "bedrooms"),
      mar_cents: cents,
      mar_status: cents > 0 ? "controlled" : "exempt",
      tenancy_date: mar?.tenancy_date ?? "",
    };
    const list = byApn.get(apn);
    if (list) list.push(detail);
    else byApn.set(apn, [detail]);
  }
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  for (const list of byApn.values()) {
    list.sort(
      (a, b) =>
        collator.compare(a.address, b.address) ||
        collator.compare(a.unit_label, b.unit_label),
    );
  }
  return byApn;
}

type ParcelSummary = {
  unit_count: number;
  controlled: number;
  exempt: number;
  median_mar_cents: number;
};

function summarize(units: UnitDetail[]): ParcelSummary {
  const controlledCents = units.filter((u) => u.mar_cents > 0).map((u) => u.mar_cents);
  return {
    unit_count: units.length,
    controlled: controlledCents.length,
    exempt: units.length - controlledCents.length,
    median_mar_cents: median(controlledCents),
  };
}

/** Distinct addresses for a parcel, sorted (numeric-aware). */
function addressesOf(units: UnitDetail[]): string[] {
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  const set = new Set<string>();
  for (const u of units) if (u.address) set.add(u.address);
  return [...set].sort((a, b) => collator.compare(a, b));
}

const intOf = (r: Row, k: string): number => parseInt(g(r, k) || "0", 10);
const floatOf = (r: Row, k: string): number => parseFloat(g(r, k) || "0") || 0;

/** Unrounded median of a numeric list (0 for empty) — for signed percentages. */
function medianSigned(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
}

/** A parcel's change activity at the latest sweep: how many units changed and
 *  the median signed % move (drives the "recent change" choropleth). */
function recentChange(
  list: ParcelChange[] | undefined,
  sweepDate: string,
): { count: number; medianPct: number } {
  if (!list) return { count: 0, medianPct: 0 };
  const recent = list.filter((c) => c.observed_at === sweepDate);
  const pcts = recent.filter((c) => c.old_mar_cents > 0 && c.new_mar_cents > 0).map((c) => c.delta_pct);
  return { count: recent.length, medianPct: Number(medianSigned(pcts).toFixed(1)) };
}

/** Representative point for a parcel marker — bbox centre of its geometry. */
function bboxCentroid(geom: unknown): [number, number] | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (c: number[]): void => {
    const x = c[0] ?? 0;
    const y = c[1] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  const g0 = geom as { type?: string; coordinates?: unknown };
  if (g0.type === "Polygon") {
    for (const ring of g0.coordinates as number[][][]) for (const c of ring) visit(c);
  } else if (g0.type === "MultiPolygon") {
    for (const poly of g0.coordinates as number[][][][])
      for (const ring of poly) for (const c of ring) visit(c);
  } else {
    return null;
  }
  if (!Number.isFinite(minX)) return null;
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/** Group mar_changes.csv rows by APN, newest first. */
function changesByApn(changes: Row[]): Map<string, ParcelChange[]> {
  const byApn = new Map<string, ParcelChange[]>();
  for (const c of changes) {
    const apn = normApn(g(c, "apn"));
    if (!apn) continue;
    const row: ParcelChange = {
      observed_at: g(c, "observed_at"),
      unit_label: g(c, "unit_label"),
      old_mar_cents: intOf(c, "old_mar_cents"),
      new_mar_cents: intOf(c, "new_mar_cents"),
      delta_cents: intOf(c, "delta_cents"),
      delta_pct: floatOf(c, "delta_pct"),
      reason: g(c, "reason"),
      mar_status_change: g(c, "mar_status_change"),
    };
    const list = byApn.get(apn);
    if (list) list.push(row);
    else byApn.set(apn, [row]);
  }
  for (const list of byApn.values()) {
    list.sort(
      (a, b) =>
        b.observed_at.localeCompare(a.observed_at) ||
        a.unit_label.localeCompare(b.unit_label),
    );
  }
  return byApn;
}

/** Group unit_exits.csv rows by APN. */
function exitsByApn(exits: Row[]): Map<string, ParcelExit[]> {
  const byApn = new Map<string, ParcelExit[]>();
  for (const e of exits) {
    const apn = normApn(g(e, "apn"));
    if (!apn) continue;
    const row: ParcelExit = {
      unit_label: g(e, "unit_label"),
      bedrooms: g(e, "bedrooms"),
      last_seen_at: g(e, "last_seen_at"),
      last_mar_cents: intOf(e, "last_mar_cents"),
      last_tenancy: g(e, "last_tenancy"),
    };
    const list = byApn.get(apn);
    if (list) list.push(row);
    else byApn.set(apn, [row]);
  }
  return byApn;
}

/** Reconstruct each parcel's MAR series from the observation change log. Every
 *  observation row is a point (carry-forward holds between points), so the raw
 *  rows for a parcel's units ARE its history. Keyed by APN via unit→apn/label. */
function historyByApn(
  obs: Row[],
  unitMeta: Map<string, { apn: string; unit_label: string }>,
): Map<string, MarHistoryPoint[]> {
  const byApn = new Map<string, MarHistoryPoint[]>();
  for (const o of obs) {
    const meta = unitMeta.get(g(o, "unit_id"));
    if (!meta) continue;
    const point: MarHistoryPoint = {
      unit_label: meta.unit_label,
      observed_at: g(o, "observed_at"),
      mar_cents: intOf(o, "mar_amount_cents"),
    };
    const list = byApn.get(meta.apn);
    if (list) list.push(point);
    else byApn.set(meta.apn, [point]);
  }
  for (const list of byApn.values()) {
    list.sort(
      (a, b) =>
        a.observed_at.localeCompare(b.observed_at) ||
        a.unit_label.localeCompare(b.unit_label),
    );
  }
  return byApn;
}

/** Citywide header stats (summary.json). */
function buildSummary(
  units: Row[],
  latestMar: Map<string, LatestMar>,
  changes: Row[],
  exits: Row[],
  sweepDate: string,
  reconSummary: Row[],
): Record<string, unknown> {
  let controlled = 0;
  let exempt = 0;
  const bedroomMix: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3+": 0, unknown: 0 };
  for (const u of units) {
    const cents = latestMar.get(g(u, "unit_id"))?.mar_amount_cents ?? 0;
    if (cents > 0) {
      controlled++;
      const b = bedroomBucket(g(u, "bedrooms"));
      bedroomMix[b] = (bedroomMix[b] ?? 0) + 1;
    } else {
      exempt++;
    }
  }
  const recon = new Map(reconSummary.map((r) => [g(r, "metric"), g(r, "value")]));
  const recentChanges = changes.filter((c) => g(c, "observed_at") === sweepDate).length;

  return {
    units_total: units.length,
    controlled_total: controlled,
    exempt_total: exempt,
    bedroom_mix: bedroomMix,
    rcb_comparable: recon.get("registry_multifamily_controlled")
      ? Number(recon.get("registry_multifamily_controlled"))
      : null,
    rcb_report_total: recon.get("report_controlled_total")
      ? Number(recon.get("report_controlled_total"))
      : null,
    latest_sweep: sweepDate,
    recent_change_count: recentChanges,
    total_change_events: changes.length,
    exited_count: exits.length,
  };
}

/** Linear-interpolated percentile (p in 0–100) of a numeric list; 0 for empty. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0]!;
  const rank = (p / 100) * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return s[lo]!;
  const frac = rank - lo;
  return Math.round((s[lo] ?? 0) * (1 - frac) + (s[hi] ?? 0) * frac);
}

/** One bar of the median-rent-by-bedroom chart. Mirrors `RentByBedroom` in
 *  site/src/lib/types.ts (the two must stay in sync). */
type RentByBedroom = {
  bucket: "0" | "1" | "2" | "3+";
  label: string;
  count: number;
  median_cents: number;
  mean_cents: number;
  p25_cents: number;
  p75_cents: number;
};

const BEDROOM_LABELS: Record<string, string> = {
  "0": "Studio",
  "1": "1 BR",
  "2": "2 BR",
  "3+": "3+ BR",
};

/** Citywide analytics aggregates (analytics.json) — the build-time dataset the
 *  /charts page reads. `rent_by_bedroom` is controlled units only; exempt ($0)
 *  units are excluded (they'd drag every median to zero — see charts-and-density.md). */
const BEDROOM_ORDER: Array<"0" | "1" | "2" | "3+"> = ["0", "1", "2", "3+"];

/** One as-of point of a bedroom bucket's median rent over time. */
type RentTimePoint = { date: string; median_cents: number; count: number };

/** Buckets plotted in the over-time series. 3+ BR is omitted pending issue #11 —
 *  its reconstructed median drops -15.5% at the 2023 portal→sweep boundary
 *  (composition skew or a bucket-specific backfill defect; under investigation). */
const OVER_TIME_BUCKETS = BEDROOM_ORDER.filter((b) => b !== "3+");

/** Median MAR per bedroom bucket over time, reconstructed from the event-sourced
 *  change log: a unit's MAR as-of date D is its latest observation with
 *  `observed_at <= D` (carry-forward). Sampled on a MONTHLY grid (first-of-month
 *  from the first observation through the latest sweep, which is appended as the
 *  final point) — the raw change log has thousands of distinct dates (portal
 *  tenancy resets land on arbitrary days) and an as-of point at each would bloat
 *  the artifact ~15× without moving the line. Pre-2023 dates cover only units
 *  with portal-backfilled history. Controlled units only. */
function buildRentOverTime(
  units: Row[],
  obs: Row[],
): { dates: string[]; series: Array<{ bucket: string; label: string; points: RentTimePoint[] }> } {
  // Per-unit observations sorted ascending by date (for as-of carry-forward).
  const obsByUnit = new Map<string, Array<{ at: string; cents: number }>>();
  for (const o of obs) {
    const id = g(o, "unit_id");
    const rec = { at: g(o, "observed_at"), cents: intOf(o, "mar_amount_cents") };
    const list = obsByUnit.get(id);
    if (list) list.push(rec);
    else obsByUnit.set(id, [rec]);
  }
  for (const list of obsByUnit.values()) list.sort((a, b) => a.at.localeCompare(b.at));

  const bedroomByUnit = new Map<string, string>();
  for (const u of units) bedroomByUnit.set(g(u, "unit_id"), bedroomBucket(g(u, "bedrooms")));

  const obsDates = [...new Set(obs.map((o) => g(o, "observed_at")).filter(Boolean))].sort();
  const first = obsDates[0]!;
  const last = obsDates[obsDates.length - 1]!;
  const dates: string[] = [];
  for (let y = +first.slice(0, 4), m = +first.slice(5, 7); ; ) {
    const d = `${y}-${String(m).padStart(2, "0")}-01`;
    if (d > last) break;
    if (d >= first) dates.push(d);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  if (dates[dates.length - 1] !== last) dates.push(last);

  const series = OVER_TIME_BUCKETS.map((b) => ({
    bucket: b as string,
    label: BEDROOM_LABELS[b] ?? b,
    points: [] as RentTimePoint[],
  }));

  for (const d of dates) {
    const buckets = new Map<string, number[]>();
    for (const [id, list] of obsByUnit) {
      // As-of MAR: the last observation on or before this date.
      let cents = -1;
      for (const o of list) {
        if (o.at <= d) cents = o.cents;
        else break;
      }
      if (cents <= 0) continue; // not yet present, or exempt at this date
      const bucket = bedroomByUnit.get(id);
      if (!bucket || bucket === "unknown") continue;
      const arr = buckets.get(bucket);
      if (arr) arr.push(cents);
      else buckets.set(bucket, [cents]);
    }
    for (const s of series) {
      const arr = buckets.get(s.bucket) ?? [];
      s.points.push({ date: d, median_cents: median(arr), count: arr.length });
    }
  }
  return { dates, series };
}

/** One quarterly bin of the tenancy-vintage view: median + IQR of MAR for the
 *  controlled units whose current tenancy began in that quarter. Mirrors
 *  `VintageBin` in site/src/lib/types.ts. */
type VintageBin = {
  period: string; // quarter-start date, YYYY-MM-01 (Jan/Apr/Jul/Oct)
  count: number;
  median_cents: number;
  p25_cents: number;
  p75_cents: number;
};

/** One raw (month-of-tenancy, MAR) point feeding the quarterly bins. Build-time
 *  only — analytics.json carries the binned aggregates, never raw units. */
type VintagePoint = { t: string; mar_cents: number };

/** All tenancy-vintage data for one bedroom bucket. Mirrors `VintageBucket`. */
type VintageBucket = {
  bucket: "0" | "1" | "2" | "3+";
  label: string;
  count: number;
  bins: VintageBin[];
};

/** mar_by_tenancy_vintage in analytics.json — the deliverable-#1 dataset: per
 *  controlled unit, current MAR vs the month-year its tenancy began, pre-binned
 *  quarterly (median + 25th–75th band) per bedroom bucket. Mirrors
 *  `MarByTenancyVintage` in site/src/lib/types.ts. */
type MarByTenancyVintage = {
  bin: "quarter";
  /** Controlled units carrying a tenancy_date — the points behind the chart. */
  total_points: number;
  /** Controlled units with NO tenancy_date (long-term tenancy, &nbsp;) — excluded. */
  excluded_empty_tenancy: number;
  /** Exempt ($0 MAR) units — never rent data points, reported for context. */
  excluded_exempt: number;
  buckets: VintageBucket[];
};

/** Quarter-start date (YYYY-MM-01, month ∈ {01,04,07,10}) for a YYYY-MM-.. date. */
function quarterStart(monthDate: string): string {
  const year = monthDate.slice(0, 4);
  const m = parseInt(monthDate.slice(5, 7), 10);
  const q = Math.floor((m - 1) / 3) * 3 + 1;
  return `${year}-${String(q).padStart(2, "0")}-01`;
}

/** Initial-MAR-by-tenancy-vintage aggregate (deliverable #1). Per controlled unit
 *  (mar > 0) with a tenancy_date, take the LATEST observation's (mar, tenancy);
 *  truncate tenancy to its month, bin quarterly, and emit median + IQR per
 *  bedroom bucket. Aggregates only — no raw-unit scatter, so a handful of very
 *  high-MAR units can't stretch the chart's shared y-range. Honest-data note: the
 *  y-value is the CURRENT MAR (tenancy-start rent + every General Adjustment
 *  since), not the literal move-in rent — direct observations only begin at the
 *  2023 RCB-archive snapshot (live scrapes 2026-06+). tenancy_date is the
 *  faithful reset date, so this is "allowed rent by
 *  tenancy vintage." Units with an empty tenancy_date have no x and are excluded
 *  (counted). See docs/design/charts-and-density.md #1. */
function buildMarByTenancyVintage(
  units: Row[],
  latestMar: Map<string, LatestMar>,
): MarByTenancyVintage {
  const bedroomByUnit = new Map<string, string>();
  for (const u of units) bedroomByUnit.set(g(u, "unit_id"), bedroomBucket(g(u, "bedrooms")));

  const pointsByBucket = new Map<string, VintagePoint[]>();
  for (const b of BEDROOM_ORDER) pointsByBucket.set(b, []);
  let totalPoints = 0;
  let excludedEmptyTenancy = 0;
  let excludedExempt = 0;
  let excludedUnknownBedroom = 0;

  for (const u of units) {
    const mar = latestMar.get(g(u, "unit_id"));
    const cents = mar?.mar_amount_cents ?? 0;
    if (cents <= 0) {
      excludedExempt++;
      continue; // exempt $0 — not a rent data point
    }
    const tenancy = (mar?.tenancy_date ?? "").trim();
    if (!tenancy) {
      excludedEmptyTenancy++;
      continue; // long-term tenancy, no reset date → no x
    }
    const bucket = bedroomByUnit.get(g(u, "unit_id"));
    if (!bucket || bucket === "unknown") {
      excludedUnknownBedroom++;
      continue;
    }
    pointsByBucket.get(bucket)!.push({ t: `${tenancy.slice(0, 7)}-01`, mar_cents: cents });
    totalPoints++;
  }

  const buckets: VintageBucket[] = BEDROOM_ORDER.map((b) => {
    const pts = pointsByBucket.get(b)!;
    // Quarterly bins: median + IQR of MAR per tenancy-vintage quarter.
    const byQuarter = new Map<string, number[]>();
    for (const p of pts) {
      const q = quarterStart(p.t);
      const arr = byQuarter.get(q);
      if (arr) arr.push(p.mar_cents);
      else byQuarter.set(q, [p.mar_cents]);
    }
    const bins: VintageBin[] = [...byQuarter.entries()]
      .map(([period, vals]) => ({
        period,
        count: vals.length,
        median_cents: median(vals),
        p25_cents: percentile(vals, 25),
        p75_cents: percentile(vals, 75),
      }))
      .sort((x, y) => x.period.localeCompare(y.period));

    return {
      bucket: b,
      label: BEDROOM_LABELS[b] ?? b,
      count: pts.length,
      bins,
    };
  });

  if (excludedUnknownBedroom > 0) {
    process.stdout.write(
      `  tenancy-vintage: ${excludedUnknownBedroom} controlled units with a ` +
        `tenancy date but unparseable bedrooms excluded\n`,
    );
  }

  return {
    bin: "quarter",
    total_points: totalPoints,
    excluded_empty_tenancy: excludedEmptyTenancy,
    excluded_exempt: excludedExempt,
    buckets,
  };
}

/** Per-UNIT MAR reconstructed "as of" the end of each year, grouped by parcel —
 *  the dataset behind the configurable MAR-change choropleth. For any chosen
 *  baseline/end year the map computes EACH unit's own % move (over units
 *  controlled in both years) and takes the parcel's median, so a building with a
 *  mix of rises and falls reflects its typical per-unit move rather than the shift
 *  of a snapshot median.
 *
 *  As-of(year) = a unit's latest observation on or before Dec 31 of that year
 *  (carry-forward), except the most recent year uses the latest sweep date (its
 *  Sep-1 GA may not have landed yet). Each entry is the unit's controlled MAR in
 *  cents, or 0 when the unit had no established/positive MAR as-of that year
 *  (exempt or not yet present) — 0 excludes the unit from that year's comparison.
 *  Units never controlled in any year, and parcels with no such units, are
 *  dropped. Mirrors `MarByYear` in site/src/lib/types.ts. */
type MarByYear = {
  years: number[];
  latest_sweep: string;
  /** apn → one MAR-by-year vector per controlled unit (cents; 0 = excluded that year). */
  parcels: Record<string, number[][]>;
};

function buildMarByYear(
  parcelUnits: Map<string, UnitDetail[]>,
  obs: Row[],
  sweepDate: string,
): MarByYear {
  // Per-unit observations sorted ascending by date (for as-of carry-forward),
  // plus a per-year observation count so we can floor the range at the first year
  // with real coverage (a stray early row shouldn't add an all-zero dropdown year).
  const obsByUnit = new Map<string, Array<{ at: string; cents: number }>>();
  const obsPerYear = new Map<number, number>();
  for (const o of obs) {
    const at = g(o, "observed_at");
    if (!at) continue;
    const y = Number(at.slice(0, 4));
    obsPerYear.set(y, (obsPerYear.get(y) ?? 0) + 1);
    const rec = { at, cents: intOf(o, "mar_amount_cents") };
    const list = obsByUnit.get(g(o, "unit_id"));
    if (list) list.push(rec);
    else obsByUnit.set(g(o, "unit_id"), [rec]);
  }
  for (const list of obsByUnit.values()) list.sort((a, b) => a.at.localeCompare(b.at));

  const sweepYear = Number(sweepDate.slice(0, 4));
  // First year with at least this many observations is the selectable floor.
  const MIN_YEAR_OBS = 500;
  const covered = [...obsPerYear.entries()]
    .filter(([y, n]) => n >= MIN_YEAR_OBS && y <= sweepYear)
    .map(([y]) => y);
  const minYear = covered.length ? Math.min(...covered) : sweepYear;
  const years: number[] = [];
  for (let y = minYear; y <= sweepYear; y++) years.push(y);
  // Cutoff per year: Dec 31 of the year, but the final year reads the live sweep.
  const cutoffs = years.map((y) => (y >= sweepYear ? sweepDate : `${y}-12-31`));

  const parcels: Record<string, number[][]> = {};
  for (const [apn, unitList] of parcelUnits) {
    const vectors: number[][] = [];
    for (const u of unitList) {
      const list = obsByUnit.get(u.unit_id);
      if (!list) continue;
      // Two-pointer sweep: both `cutoffs` and `list` are sorted ascending, so the
      // carry-forward value only ever moves forward as the year cutoff advances.
      // An exempt ($0) observation carries forward as 0 → excluded that year.
      const vec: number[] = new Array(years.length).fill(0);
      let li = 0;
      let cur = 0;
      let anyControlled = false;
      for (let yi = 0; yi < years.length; yi++) {
        const cutoff = cutoffs[yi]!;
        while (li < list.length && list[li]!.at <= cutoff) cur = list[li++]!.cents;
        if (cur > 0) {
          vec[yi] = cur;
          anyControlled = true;
        }
      }
      if (anyControlled) vectors.push(vec);
    }
    if (vectors.length) parcels[apn] = vectors;
  }
  return { years, latest_sweep: sweepDate, parcels };
}

function buildAnalytics(
  units: Row[],
  latestMar: Map<string, LatestMar>,
  obs: Row[],
  sweepDate: string,
): Record<string, unknown> {
  const byBucket = new Map<string, number[]>();
  for (const u of units) {
    const cents = latestMar.get(g(u, "unit_id"))?.mar_amount_cents ?? 0;
    if (cents <= 0) continue; // exempt — not a rent data point
    const bucket = bedroomBucket(g(u, "bedrooms"));
    if (bucket === "unknown") continue;
    const list = byBucket.get(bucket);
    if (list) list.push(cents);
    else byBucket.set(bucket, [cents]);
  }
  const rentByBedroom: RentByBedroom[] = BEDROOM_ORDER.filter((b) => byBucket.has(b)).map((b) => {
    const v = byBucket.get(b)!;
    const sum = v.reduce((a, c) => a + c, 0);
    return {
      bucket: b,
      label: BEDROOM_LABELS[b] ?? b,
      count: v.length,
      median_cents: median(v),
      mean_cents: Math.round(sum / v.length),
      p25_cents: percentile(v, 25),
      p75_cents: percentile(v, 75),
    };
  });
  return {
    latest_sweep: sweepDate,
    rent_by_bedroom: rentByBedroom,
    rent_over_time: buildRentOverTime(units, obs),
    mar_by_tenancy_vintage: buildMarByTenancyVintage(units, latestMar),
  };
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
  const exits = readCsv(EXITS_CSV);
  const reconSummary = readCsv(RECON_SUMMARY_CSV);
  const latestMar = latestMarByUnit(obs);
  const sweepDate = latestSweepDate(sweeps);

  const parcelUnits = groupUnitsByApn(units, latestMar);

  // Per-parcel time data for the detail panel.
  const unitMeta = new Map<string, { apn: string; unit_label: string }>();
  for (const u of units) {
    unitMeta.set(g(u, "unit_id"), { apn: normApn(g(u, "apn")), unit_label: g(u, "unit_label") });
  }
  const changesFor = changesByApn(changes);
  const exitsFor = exitsByApn(exits);
  const historyFor = historyByApn(obs, unitMeta);

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

  // Per-APN detail JSON, lazy-loaded on parcel click. Written for EVERY APN (not
  // just mapped ones) so search can resolve any parcel later; cheap static files.
  const parcelsDir = join(SITE_DATA_DIR, "parcels");
  mkdirSync(parcelsDir, { recursive: true });

  const features: GeoFeature[] = [];
  const exitFeatures: GeoFeature[] = [];
  const searchIndex: Array<{ apn: string; label: string; addr: string[] }> = [];
  const unmatchedApns: string[] = [];
  for (const [apn, parcelUnitList] of parcelUnits) {
    const summary = summarize(parcelUnitList);
    const addresses = addressesOf(parcelUnitList);

    writeFileSync(
      join(parcelsDir, `${apn}.json`),
      JSON.stringify({
        apn,
        addresses,
        summary,
        units: parcelUnitList,
        changes: changesFor.get(apn) ?? [],
        exited: exitsFor.get(apn) ?? [],
        mar_history: historyFor.get(apn) ?? [],
      }),
    );

    const geometry = geomByApn.get(apn);
    if (!geometry) {
      unmatchedApns.push(apn);
      continue;
    }
    // Searchable only for mapped parcels (search flies to geometry).
    searchIndex.push({ apn, label: addresses[0] ?? "", addr: addresses });

    const change = recentChange(changesFor.get(apn), sweepDate);
    features.push({
      type: "Feature",
      geometry,
      properties: {
        apn,
        label_address: addresses[0] ?? "",
        unit_count: summary.unit_count,
        controlled_count: summary.controlled,
        exempt_count: summary.exempt,
        median_mar_cents: summary.median_mar_cents,
        size_class: sizeClassOf(summary.unit_count),
        has_recent_change: recentlyChanged.has(apn),
        recent_change_count: change.count,
        recent_change_pct: change.medianPct,
      },
    });

    // Exit markers — parcels that lost a unit from the latest sweep.
    const exitedHere = exitsFor.get(apn);
    if (exitedHere?.length) {
      const centroid = bboxCentroid(geometry);
      if (centroid) {
        exitFeatures.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: centroid },
          properties: { apn, label_address: addresses[0] ?? "", exit_count: exitedHere.length },
        });
      }
    }
  }

  const referenced = parcelUnits.size;
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

  // Exit markers (point per parcel that lost a unit). Empty at the seed; the
  // layer exists so steady-state demolitions/exemptions surface on the map.
  exitFeatures.sort((a, b) =>
    String(a.properties.apn).localeCompare(String(b.properties.apn)),
  );
  const exitsPath = join(SITE_DATA_DIR, "exits.geojson");
  writeFileSync(exitsPath, JSON.stringify({ type: "FeatureCollection", features: exitFeatures }));

  // Search index (address / APN → parcel), mapped parcels only.
  searchIndex.sort((a, b) => a.apn.localeCompare(b.apn));
  const searchPath = join(SITE_DATA_DIR, "search.json");
  writeFileSync(searchPath, JSON.stringify(searchIndex));

  // City-limits overlay — pass the cached boundary polygon straight through.
  // Cosmetic, so a missing cache only warns (the map layer is optional): run
  // `npm run fetch-boundary` to (re)create it. Unlike parcel geometry it never
  // gates the build.
  const boundaryPath = join(SITE_DATA_DIR, "city-boundary.geojson");
  let boundaryCopied = false;
  if (existsSync(BOUNDARY_CACHE)) {
    copyFileSync(BOUNDARY_CACHE, boundaryPath);
    boundaryCopied = true;
  } else {
    process.stderr.write(
      `WARN: ${BOUNDARY_CACHE} missing — city-limits overlay will be absent. ` +
        `Run \`npm run fetch-boundary\`.\n`,
    );
  }

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

  const summaryJson = buildSummary(units, latestMar, changes, exits, sweepDate, reconSummary);
  const summaryPath = join(SITE_DATA_DIR, "summary.json");
  writeFileSync(summaryPath, JSON.stringify(summaryJson, null, 2) + "\n");

  const analyticsJson = buildAnalytics(units, latestMar, obs, sweepDate);
  const analyticsPath = join(SITE_DATA_DIR, "analytics.json");
  writeFileSync(analyticsPath, JSON.stringify(analyticsJson, null, 2) + "\n");
  const vintage = analyticsJson.mar_by_tenancy_vintage as MarByTenancyVintage;

  // Per-parcel median-MAR-by-year matrix for the configurable change choropleth.
  const marByYear = buildMarByYear(parcelUnits, obs, sweepDate);
  const marByYearPath = join(SITE_DATA_DIR, "mar_by_year.json");
  writeFileSync(marByYearPath, JSON.stringify(marByYear));

  const bytes = Buffer.byteLength(JSON.stringify({ type: "FeatureCollection", features }));
  process.stdout.write(
    `\nWrote ${parcelsPath} (${features.length} features, ${(bytes / 1e6).toFixed(2)} MB)\n` +
      `Wrote ${exitsPath} (${exitFeatures.length} exit markers)\n` +
      `Wrote ${searchPath} (${searchIndex.length} searchable parcels)\n` +
      (boundaryCopied ? `Wrote ${boundaryPath} (city-limits overlay)\n` : "") +
      `Wrote ${parcelUnits.size} per-APN files to ${parcelsDir}/\n` +
      `Wrote ${summaryPath}\n` +
      `Wrote ${analyticsPath} (tenancy-vintage: ${vintage.total_points} controlled points, ` +
      `${vintage.excluded_empty_tenancy} excluded for empty tenancy_date)\n` +
      `Wrote ${marByYearPath} (${marByYear.years.length} years ${marByYear.years[0]}–` +
      `${marByYear.years[marByYear.years.length - 1]}, ${Object.keys(marByYear.parcels).length} parcels)\n` +
      `Wrote ${metaPath}\n`,
  );
}

main();
