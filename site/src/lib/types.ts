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

/** parcels/<apn>.json — the full per-parcel breakdown, lazy-loaded on click. */
export interface ParcelDetail {
  apn: string;
  addresses: string[];
  summary: ParcelSummary;
  units: UnitDetail[];
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
