/** Shapes of the build-time data artifacts (see site/scripts/build-data.ts). */

/** One feature per APN in parcels.geojson — everything the map layer needs
 *  without a detail fetch. */
export interface ParcelProperties {
  apn: string;
  label_address: string;
  unit_count: number;
  controlled_count: number;
  exempt_count: number;
  median_mar_cents: number;
  size_class: 'single' | 'small' | 'multifamily';
  has_recent_change: boolean;
  /** Units changed at the latest sweep. */
  recent_change_count: number;
  /** Median signed % MAR move among those changes (latest-sweep, for the tooltip). */
  recent_change_pct: number;
  /** % change in the parcel's median MAR over the selected year range — computed
   *  client-side from mar_by_year.json and written onto the feature at runtime. */
  range_change_pct?: number;
  /** 1 if the year-range change is defined (controlled MAR in the baseline year). */
  range_has_data?: 0 | 1;
}

/** One unit row in a parcel's detail (parcels/<apn>.json). Mirrors the
 *  `UnitDetail` type in site/scripts/build-data.ts (the two must stay in sync). */
export interface UnitDetail {
  unit_id: string;
  address: string;
  unit_label: string;
  bedrooms: string;
  mar_cents: number;
  mar_status: 'controlled' | 'exempt';
  tenancy_date: string;
}

export interface ParcelSummary {
  unit_count: number;
  controlled: number;
  exempt: number;
  median_mar_cents: number;
}

/** A rent-change event on a parcel (mirrors build-data `ParcelChange`). */
export interface ParcelChange {
  observed_at: string;
  unit_label: string;
  old_mar_cents: number;
  new_mar_cents: number;
  delta_cents: number;
  delta_pct: number;
  /** "new_tenancy" | "mar_adjustment" | "" (status-only). */
  reason: string;
  /** "became_exempt" | "reinstated" | "". */
  mar_status_change: string;
}

/** A unit gone from the latest sweep (mirrors build-data `ParcelExit`). */
export interface ParcelExit {
  unit_label: string;
  bedrooms: string;
  last_seen_at: string;
  last_mar_cents: number;
  last_tenancy: string;
}

/** One point in a unit's MAR series (mirrors build-data `MarHistoryPoint`). */
export interface MarHistoryPoint {
  unit_label: string;
  observed_at: string;
  mar_cents: number;
}

/** parcels/<apn>.json — the full per-parcel breakdown, lazy-loaded on click. */
export interface ParcelDetail {
  apn: string;
  addresses: string[];
  summary: ParcelSummary;
  units: UnitDetail[];
  changes: ParcelChange[];
  exited: ParcelExit[];
  mar_history: MarHistoryPoint[];
}

/** summary.json — citywide header stats. */
export interface SiteSummary {
  units_total: number;
  controlled_total: number;
  exempt_total: number;
  bedroom_mix: Record<string, number>;
  rcb_comparable: number | null;
  rcb_report_total: number | null;
  latest_sweep: string;
  recent_change_count: number;
  total_change_events: number;
  exited_count: number;
}

/** One bar of the median-rent-by-bedroom chart (mirrors build-data `RentByBedroom`). */
export interface RentByBedroom {
  bucket: '0' | '1' | '2' | '3+';
  label: string;
  count: number;
  median_cents: number;
  mean_cents: number;
  p25_cents: number;
  p75_cents: number;
}

/** One monthly as-of point of a bedroom bucket's median rent over time. */
export interface RentTimePoint {
  date: string;
  median_cents: number;
  count: number;
}

/** A bedroom bucket's median-rent time series (mirrors build-data). 3+ BR is
 *  omitted upstream pending issue #11. */
export interface RentOverTimeSeries {
  bucket: string;
  label: string;
  points: RentTimePoint[];
}

/** One quarterly bin of the tenancy-vintage chart (mirrors build-data `VintageBin`). */
export interface VintageBin {
  /** Quarter-start date, YYYY-MM-01 (Jan/Apr/Jul/Oct). */
  period: string;
  count: number;
  median_cents: number;
  p25_cents: number;
  p75_cents: number;
}

/** All tenancy-vintage data for one bedroom bucket (mirrors build-data `VintageBucket`). */
export interface VintageBucket {
  bucket: '0' | '1' | '2' | '3+';
  label: string;
  count: number;
  bins: VintageBin[];
}

/** mar_by_tenancy_vintage — current MAR vs tenancy-start month per controlled
 *  unit, pre-binned quarterly per bedroom bucket (mirrors build-data
 *  `MarByTenancyVintage`). Aggregates only — no raw-unit scatter. The y-value is
 *  the CURRENT MAR (tenancy-start rent + every GA since), not the literal
 *  move-in rent — see charts-and-density.md #1. */
export interface MarByTenancyVintage {
  bin: 'quarter';
  total_points: number;
  excluded_empty_tenancy: number;
  excluded_exempt: number;
  buckets: VintageBucket[];
}

/** new_tenancy_rent — the "going rate for new tenancies" series (mirrors
 *  build-data `NewTenancyRent`). Companion to mar_by_tenancy_vintage: here the
 *  y-value is the rent set AT the tenancy start (earliest GA-clean observation
 *  of each establishment event), binned quarterly by tenancy-start month per
 *  bedroom bucket. Events whose first observation lagged past a Sep-1 GA are
 *  excluded (counted) — see charts-and-density.md #4. */
export interface NewTenancyRent {
  bin: 'quarter';
  total_events: number;
  excluded_ga_lag: number;
  excluded_invalid: number;
  buckets: VintageBucket[];
}

/** analytics.json — citywide aggregates read by the /charts page. */
export interface SiteAnalytics {
  latest_sweep: string;
  rent_by_bedroom: RentByBedroom[];
  rent_over_time: { dates: string[]; series: RentOverTimeSeries[] };
  mar_by_tenancy_vintage: MarByTenancyVintage;
  new_tenancy_rent: NewTenancyRent;
}

/** mar_by_year.json — per-UNIT MAR (cents) "as of" the end of each year, grouped by
 *  parcel; the dataset behind the configurable MAR-change choropleth. The map
 *  computes each unit's own % move between any chosen baseline and end year (over
 *  units controlled in both) and takes the parcel median, client-side.
 *  Mirrors `MarByYear` in site/scripts/build-data.ts. */
export interface MarByYear {
  years: number[];
  latest_sweep: string;
  /** apn → one MAR-by-year vector per controlled unit (cents; 0 = excluded that year). */
  parcels: Record<string, number[][]>;
}

/** meta.json — build provenance, surfaced in the footer (later PR). */
export interface SiteMeta {
  built_at: string;
  source_sha: string;
  latest_sweep: string;
  geometry_source: string | null;
  geometry_precision: number | null;
  parcels_total: number;
  parcels_mapped: number;
  parcels_unmatched: number;
  match_rate: number;
  units_total: number;
}
