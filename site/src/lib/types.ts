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
