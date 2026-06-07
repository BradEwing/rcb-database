import type { MarPage } from "./parse-mar.ts";
import type { Row } from "./csv.ts";

export type ParcelRow = {
  parcel_id: string;
  street_number: string;
  street_name: string;
  apn: string;
  first_seen_at: string;
};

export type UnitRow = {
  unit_id: string;
  apn: string;
  address: string;
  unit_label: string;
  bedrooms: string;
  first_seen_at: string;
};

export type MarObservationRow = {
  unit_id: string;
  observed_at: string;
  mar_amount_cents: string;
  tenancy_date: string;
};

/**
 * Phase A: parse a street-sweep response (gvAddresses) into bare parcel rows.
 * APN is left blank — it gets filled in during phase B drill-down.
 */
export function parsePhaseAddresses(
  page: MarPage,
  streetName: string,
  fetchedAtIso: string,
): ParcelRow[] {
  const today = fetchedAtIso.slice(0, 10);
  const rows: ParcelRow[] = [];
  if (!page.addresses) return rows;
  for (const r of page.addresses.rows) {
    const text = pickFirst(r, ["Addresses", "Address"]);
    const { streetNumber, name } = splitAddress(text);
    if (!streetNumber) continue;
    rows.push({
      parcel_id: slug(`${streetNumber} ${name || streetName}`),
      street_number: streetNumber,
      street_name: name || streetName,
      apn: "",
      first_seen_at: today,
    });
  }
  return rows;
}

/**
 * Phase B: parse a property-drill response (gvMarData) into unit + observation rows.
 * Also returns the APN observed for the parcel so callers can backfill parcels.csv.
 */
export function parsePhaseUnits(
  page: MarPage,
  streetNumber: string,
  streetName: string,
  fetchedAtIso: string,
): {
  apn: string;
  units: UnitRow[];
  observations: MarObservationRow[];
} {
  const today = fetchedAtIso.slice(0, 10);
  const queriedAddress = `${streetNumber} ${streetName}`;
  const units: UnitRow[] = [];
  const observations: MarObservationRow[] = [];
  let apn = "";

  if (!page.marData) {
    return { apn, units, observations };
  }

  for (const r of page.marData.rows) {
    // Identify the unit by the form's OWN Address column, not the queried
    // street. The MAR form returns every unit on a parcel for any of that
    // parcel's addresses, each row self-identifying via Address + Unit. Keying
    // on the queried street double-counts buildings that span several addresses
    // (one APN, many street numbers); keying on the row's Address collapses
    // those duplicates while keeping genuinely distinct units apart.
    const rowAddress = pickFirst(r, ["Address"]) || queriedAddress;
    const unitLabel = pickFirst(r, ["Unit", "Unit Number", "Apt", "Suite"]);
    const bedrooms = pickFirst(r, ["Bedrooms", "BR", "Beds"]);
    const marText = pickFirst(r, ["MAR", "Maximum Allowable Rent"]);
    const tenancyText = pickFirst(r, ["Tenancy Date", "Tenancy"]);
    const rowApn = pickFirst(r, ["Parcel", "APN"]);
    if (rowApn) apn = rowApn;

    const unitId = slug(`${rowAddress} ${unitLabel || "_"}`);
    units.push({
      unit_id: unitId,
      apn: rowApn,
      address: rowAddress,
      unit_label: unitLabel,
      bedrooms,
      first_seen_at: today,
    });
    observations.push({
      unit_id: unitId,
      observed_at: today,
      mar_amount_cents: String(parseMarCents(marText)),
      tenancy_date: parseTenancyDate(tenancyText),
    });
  }
  return { apn, units, observations };
}

function pickFirst(row: Record<string, string>, candidates: string[]): string {
  for (const key of candidates) {
    const v = row[key];
    if (v !== undefined && v.trim().length > 0) return v.trim();
  }
  return "";
}

function splitAddress(text: string): { streetNumber: string; name: string } {
  const m = text.trim().match(/^(\d+\S*)\s+(.+)$/);
  if (!m) return { streetNumber: "", name: text.trim() };
  return { streetNumber: m[1]!, name: m[2]!.trim() };
}

function parseMarCents(text: string): number {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (cleaned === "" || cleaned === "0") return 0;
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function parseTenancyDate(text: string): string {
  // "7/27/2024" -> "2024-07-27"; empty/&nbsp; passthrough as "".
  if (!text || text === " ") return "";
  const m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return "";
  const [_, mo, da, yr] = m;
  return `${yr}-${mo!.padStart(2, "0")}-${da!.padStart(2, "0")}`;
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
