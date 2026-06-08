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
  /** Median signed % MAR move among those changes (drives the change choropleth). */
  recent_change_pct: number;
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

/** One snapshot point of a bedroom bucket's median rent over time. */
export interface RentTimePoint {
  date: string;
  median_cents: number;
  count: number;
}

/** A bedroom bucket's median-rent time series (mirrors build-data). */
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

/** A downsampled scatter point (month-of-tenancy, MAR). Mirrors build-data. */
export interface VintageScatterPoint {
  t: string;
  mar_cents: number;
}

/** All tenancy-vintage data for one bedroom bucket (mirrors build-data `VintageBucket`). */
export interface VintageBucket {
  bucket: '0' | '1' | '2' | '3+';
  label: string;
  count: number;
  bins: VintageBin[];
  scatter: VintageScatterPoint[];
}

/** mar_by_tenancy_vintage — current MAR vs tenancy-start month per controlled
 *  unit, pre-binned quarterly per bedroom bucket (mirrors build-data
 *  `MarByTenancyVintage`). The y-value is the CURRENT MAR (tenancy-start rent +
 *  every GA since), not the literal move-in rent — see charts-and-density.md #1. */
export interface MarByTenancyVintage {
  bin: 'quarter';
  total_points: number;
  excluded_empty_tenancy: number;
  excluded_exempt: number;
  axis_cap_cents: number;
  scatter_cap_per_bucket: number;
  scatter_count: number;
  buckets: VintageBucket[];
}

/** analytics.json — citywide aggregates read by the /charts page. */
export interface SiteAnalytics {
  latest_sweep: string;
  rent_by_bedroom: RentByBedroom[];
  rent_over_time: { dates: string[]; series: RentOverTimeSeries[] };
  mar_by_tenancy_vintage: MarByTenancyVintage;
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
