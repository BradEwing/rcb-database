/**
 * Shared helpers for the site's build-time data scripts. Pure reads over the
 * committed registry CSVs (the source of truth) + the cached parcel geometry —
 * no network, no mutation of the registry. Mirrors the scraper's conventions
 * (see scraper/src/csv.ts, scraper/src/sparse.ts) but kept self-contained in the
 * `site` package so its deps don't mix with the scraper's.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";

export type Row = Record<string, string>;

/** Repo root, resolved from this file's location (site/scripts/lib → repo). */
export const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
export const DATA_DIR = join(REPO_ROOT, "data");
export const DERIVED_DIR = join(DATA_DIR, "derived");
export const EXTERNAL_DIR = join(DATA_DIR, "external");
export const SITE_DIR = join(REPO_ROOT, "site");
export const SITE_DATA_DIR = join(SITE_DIR, "public", "data");

export const UNITS_CSV = join(DATA_DIR, "units.csv");
export const OBS_CSV = join(DATA_DIR, "mar_observations.csv");
export const SWEEPS_CSV = join(DATA_DIR, "sweeps.csv");
export const CHANGES_CSV = join(DERIVED_DIR, "mar_changes.csv");
export const EXITS_CSV = join(DERIVED_DIR, "unit_exits.csv");
export const RECON_SUMMARY_CSV = join(DERIVED_DIR, "reconciliation_summary.csv");
export const GEOMETRY_CACHE = join(EXTERNAL_DIR, "parcels-geometry.geojson");
export const BOUNDARY_CACHE = join(EXTERNAL_DIR, "city-boundary.geojson");

export function readCsv(path: string): Row[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  if (content.trim().length === 0) return [];
  return parse(content, { columns: true, skip_empty_lines: true }) as Row[];
}

export const g = (r: Row, k: string): string => r[k] ?? "";

/** Bare-digit normalization so registry APN and City AIN compare 1:1. */
export function normApn(raw: string): string {
  return (raw ?? "").replace(/\D/g, "");
}

export type LatestMar = { mar_amount_cents: number; tenancy_date: string };

/**
 * unit_id → latest (mar_amount_cents, tenancy_date) from the event-sourced
 * change log: the current MAR of a unit is its newest observation
 * (carry-forward). Mirrors scraper/src/sparse.ts `latestObservations`, but reads
 * the whole log (no `asOf` cutoff — we want the live value).
 */
export function latestMarByUnit(obs: Row[]): Map<string, LatestMar> {
  const latestDate = new Map<string, string>();
  const latest = new Map<string, LatestMar>();
  for (const o of obs) {
    const id = g(o, "unit_id");
    const observedAt = g(o, "observed_at");
    const prev = latestDate.get(id);
    if (prev !== undefined && observedAt <= prev) continue;
    latestDate.set(id, observedAt);
    latest.set(id, {
      mar_amount_cents: parseInt(g(o, "mar_amount_cents") || "0", 10),
      tenancy_date: g(o, "tenancy_date"),
    });
  }
  return latest;
}

/** The most recent sweep date (max sweep_date in sweeps.csv), or "" if none. */
export function latestSweepDate(sweeps: Row[]): string {
  let max = "";
  for (const s of sweeps) {
    const d = g(s, "sweep_date");
    if (d > max) max = d;
  }
  return max;
}

/** Median of a numeric list (0 for empty). */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
  }
  return sorted[mid] ?? 0;
}

/** Bedroom bucket, matching scraper reconcile.ts `normBedrooms` (report grouping). */
export function bedroomBucket(raw: string): "0" | "1" | "2" | "3+" | "unknown" {
  const n = parseInt((raw ?? "").trim(), 10);
  if (Number.isNaN(n)) return "unknown";
  if (n <= 0) return "0";
  if (n === 1) return "1";
  if (n === 2) return "2";
  return "3+";
}

/** Parcel size class, matching scraper reconcile.ts `sizeClassOf`. */
export function sizeClassOf(unitCount: number): "single" | "small" | "multifamily" {
  if (unitCount <= 1) return "single";
  if (unitCount <= 3) return "small";
  return "multifamily";
}

/** County-assessor use class derived from the City "Parcels Public" layer's raw
 *  `usetype`/`usedescrip` (cached on each geometry feature). NOTE: the layer has
 *  no condo distinction — "single" lumps SFR + condos. Matches scraper
 *  reconcile.ts `useClassOf` (the two must stay in sync). */
export type UseClass =
  | "single"
  | "two_three"
  | "four"
  | "five_plus"
  | "commercial"
  | "other"
  | "unknown";

export function useClassOf(usetype: string, usedescrip: string): UseClass {
  const t = (usetype ?? "").trim();
  const d = (usedescrip ?? "").trim();
  if (t === "Commercial") return "commercial";
  if (t === "Residential") {
    if (d === "Single") return "single";
    if (d.startsWith("Two Units") || d.startsWith("Three Units")) return "two_three";
    if (d.startsWith("Four Units")) return "four";
    if (d === "Five or more apartments") return "five_plus";
    return d ? "other" : "unknown"; // rooming houses, mobile homes, …
  }
  return t ? "other" : "unknown"; // institutional, industrial, government, …
}
