/**
 * Reconcile the scraped MAR-tool universe against the Rent Control Board's
 * published "controlled units" headline.
 *
 * Background: the MAR lookup tool returns a row for every unit that has an
 * established Maximum Allowable Rent — a universe BROADER than the RCB Annual
 * Report's "controlled units" count, which excludes units that are exempt or
 * rent-level decontrolled (single-family homes & condos under Costa-Hawkins,
 * owner-occupied 2-3 unit properties, other use exemptions). Investigation
 * (see docs/reconciliation-2025.md) established that the ~19% overage is
 * DEFINITIONAL, not a scraper double-count: cross-address dedup is correct and
 * confirmed-duplicate rows are ≈0.
 *
 * This module classifies each unit along the dimensions we CAN derive from the
 * scraped fields (MAR status + parcel size, the single-family/condo proxy) and
 * prints a bridge from the registry total to the report headline. It does not
 * mutate the source-of-truth CSVs; it writes derived artifacts under
 * data/derived/ and a human-readable bridge to stdout.
 *
 * Run: `npm run reconcile`
 */
import { join } from "node:path";
import { readCsv, writeCsvSorted, type Row } from "../csv.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const DATA_DIR = join(REPO_ROOT, "data");
const UNITS_CSV = join(DATA_DIR, "units.csv");
const OBS_CSV = join(DATA_DIR, "mar_observations.csv");
const DERIVED_DIR = join(DATA_DIR, "derived");
const CATEGORIES_CSV = join(DERIVED_DIR, "unit_categories.csv");
const BRIDGE_CSV = join(DERIVED_DIR, "reconciliation_summary.csv");

/** Bedroom buckets, matching the report's "0 / 1 / 2 / 3(or more)" grouping. */
export type BedroomBucket = "0" | "1" | "2" | "3+" | "unknown";
/** Parcel size classes. "single" is the single-family-home / condo proxy. */
export type SizeClass = "single" | "small" | "multifamily";
export type MarStatus = "controlled" | "zero_mar";

export type UnitClass = {
  unit_id: string;
  apn: string;
  bedrooms: BedroomBucket;
  /** controlled = positive MAR in the tool; zero_mar = $0 (exempt or no registered rent). */
  mar_status: MarStatus;
  /** Total units sharing this unit's APN, across all addresses. */
  parcel_unit_count: number;
  /** single = 1 unit/parcel (SFD/condo), small = 2-3 (owner-occ exemption zone), multifamily = 4+. */
  size_class: SizeClass;
  /**
   * Heuristic: counts toward the RCB-comparable "controlled" estimate
   * (positive MAR on a 4+ unit parcel). A documented proxy — see the memo —
   * not a per-unit exemption determination, which the tool does not expose.
   */
  rcb_comparable: boolean;
};

/**
 * RCB 2025 Annual Report figures (as of 2025-12-31). Source: Santa Monica Rent
 * Control Board 2025 Annual Report — Status of Controlled Rental Housing (Fig.
 * 1, Fig. 3), Permanent / Use Exemptions, Rent-Level Decontrolled SFD/Condo.
 */
export const RCB_2025 = {
  asOf: "2025-12-31",
  controlledTotal: 27589,
  byBedroom: { "0": 2910, "1": 12945, "2": 9695, "3+": 2039 } as Record<string, number>,
  byType: { marketRate: 21103, longTerm: 5521, sec8HomeTaxCredit: 777, zeroMar: 188 },
  excluded: {
    rentLevelDecontrolledSfrCondo: 1865,
    ownerOccupied2to3Unit: 1106,
    useExempt: 3205,
    permanentlyExemptSfd: 3966,
  },
} as const;

const g = (r: Row, k: string): string => r[k] ?? "";

export function normBedrooms(raw: string): BedroomBucket {
  const n = parseInt((raw ?? "").trim(), 10);
  if (Number.isNaN(n)) return "unknown";
  if (n <= 0) return "0";
  if (n === 1) return "1";
  if (n === 2) return "2";
  return "3+";
}

export function sizeClassOf(parcelUnitCount: number): SizeClass {
  if (parcelUnitCount <= 1) return "single";
  if (parcelUnitCount <= 3) return "small";
  return "multifamily";
}

/**
 * Classify every unit using only independently-derivable signals: MAR status
 * (from the latest observation) and parcel size (units sharing an APN).
 */
export function classifyUnits(units: Row[], obs: Row[]): UnitClass[] {
  const cents = new Map<string, number>();
  for (const o of obs) {
    cents.set(g(o, "unit_id"), parseInt(g(o, "mar_amount_cents") || "0", 10));
  }
  const parcelSize = new Map<string, number>();
  for (const u of units) {
    const apn = g(u, "apn");
    parcelSize.set(apn, (parcelSize.get(apn) ?? 0) + 1);
  }
  return units.map((u) => {
    const apn = g(u, "apn");
    const c = cents.get(g(u, "unit_id")) ?? 0;
    const size = parcelSize.get(apn) ?? 0;
    const size_class = sizeClassOf(size);
    const mar_status: MarStatus = c > 0 ? "controlled" : "zero_mar";
    return {
      unit_id: g(u, "unit_id"),
      apn,
      bedrooms: normBedrooms(g(u, "bedrooms")),
      mar_status,
      parcel_unit_count: size,
      size_class,
      rcb_comparable: mar_status === "controlled" && size_class === "multifamily",
    };
  });
}

export type Bridge = {
  totalUnits: number;
  controlled: number;
  zeroMar: number;
  multifamilyControlled: number;
  controlledByBedroom: Record<BedroomBucket, number>;
  controlledBySize: Record<SizeClass, number>;
};

export function buildBridge(classes: UnitClass[]): Bridge {
  const controlled = classes.filter((c) => c.mar_status === "controlled");
  const byBedroom: Record<BedroomBucket, number> = { "0": 0, "1": 0, "2": 0, "3+": 0, unknown: 0 };
  const bySize: Record<SizeClass, number> = { single: 0, small: 0, multifamily: 0 };
  for (const c of controlled) {
    byBedroom[c.bedrooms]++;
    bySize[c.size_class]++;
  }
  return {
    totalUnits: classes.length,
    controlled: controlled.length,
    zeroMar: classes.length - controlled.length,
    multifamilyControlled: controlled.filter((c) => c.size_class === "multifamily").length,
    controlledByBedroom: byBedroom,
    controlledBySize: bySize,
  };
}

function pad(s: string | number, w: number): string {
  return String(s).padStart(w);
}

function printReport(b: Bridge): void {
  const r = RCB_2025;
  const lines: string[] = [];
  lines.push(`RCB reconciliation — registry vs ${r.asOf} Annual Report`);
  lines.push("");
  lines.push(`  Registry units total .............. ${pad(b.totalUnits, 8)}`);
  lines.push(`  Positive-MAR ("controlled") ....... ${pad(b.controlled, 8)}`);
  lines.push(`  $0-MAR (exempt / no rent) ......... ${pad(b.zeroMar, 8)}`);
  lines.push("");
  lines.push("  Controlled by bedroom        registry   report   delta");
  for (const k of ["0", "1", "2", "3+"] as const) {
    const mine = b.controlledByBedroom[k];
    const rep = r.byBedroom[k] ?? 0;
    lines.push(`    ${pad(k + "-BR", 6)}  ${pad(mine, 18)} ${pad(rep, 8)} ${pad(mine - rep, 7)}`);
  }
  lines.push("");
  lines.push("  Controlled by parcel size (SFD/condo = single):");
  lines.push(`    single (1 unit) ................. ${pad(b.controlledBySize.single, 6)}`);
  lines.push(`    small  (2-3 units) ............. ${pad(b.controlledBySize.small, 6)}`);
  lines.push(`    multifamily (4+ units) ......... ${pad(b.controlledBySize.multifamily, 6)}`);
  lines.push("");
  lines.push("  Bridge to the report headline:");
  const ex = r.excluded;
  const reportPositiveMar = r.controlledTotal - r.byType.zeroMar;
  const excess = b.controlled - reportPositiveMar;
  const useExemptBalancing = excess - ex.rentLevelDecontrolledSfrCondo - ex.ownerOccupied2to3Unit;
  lines.push(`    ${pad(b.controlled, 8)}  registry positive-MAR units`);
  lines.push(`   ${pad(-ex.rentLevelDecontrolledSfrCondo, 9)}  rent-level decontrolled SFR/condo (report-excluded)`);
  lines.push(`   ${pad(-ex.ownerOccupied2to3Unit, 9)}  owner-occupied 2-3 unit exemptions (report-excluded)`);
  lines.push(`   ${pad(-useExemptBalancing, 9)}  other use-exempt retaining positive MAR (of ${ex.useExempt} reported)`);
  lines.push(`    ${pad(reportPositiveMar, 8)}  = report positive-MAR controlled (${r.controlledTotal} − ${r.byType.zeroMar} $0-MAR)`);
  lines.push(`   ${pad("+" + r.byType.zeroMar, 9)}  $0-MAR units the report counts as controlled`);
  lines.push(`    ${pad(r.controlledTotal, 8)}  = RCB ${r.asOf} headline`);
  lines.push("");
  lines.push(`  RCB-comparable estimate (multifamily controlled): ${b.multifamilyControlled}`);
  lines.push(`  vs report headline ${r.controlledTotal} → ${((b.multifamilyControlled / r.controlledTotal - 1) * 100).toFixed(1)}%`);
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

function main(): void {
  const units = readCsv(UNITS_CSV);
  const obs = readCsv(OBS_CSV);
  if (units.length === 0) {
    throw new Error(`No units found at ${UNITS_CSV} — run the scraper first.`);
  }
  const classes = classifyUnits(units, obs);
  const bridge = buildBridge(classes);

  writeCsvSorted(
    CATEGORIES_CSV,
    ["unit_id", "apn", "bedrooms", "mar_status", "parcel_unit_count", "size_class", "rcb_comparable"],
    classes.map((c) => ({
      unit_id: c.unit_id,
      apn: c.apn,
      bedrooms: c.bedrooms,
      mar_status: c.mar_status,
      parcel_unit_count: String(c.parcel_unit_count),
      size_class: c.size_class,
      rcb_comparable: c.rcb_comparable ? "1" : "0",
    })),
    ["unit_id"],
  );

  const summary: Row[] = [
    { metric: "registry_units_total", value: String(bridge.totalUnits) },
    { metric: "registry_controlled_positive_mar", value: String(bridge.controlled) },
    { metric: "registry_zero_mar", value: String(bridge.zeroMar) },
    { metric: "registry_multifamily_controlled", value: String(bridge.multifamilyControlled) },
    { metric: "controlled_single_parcel", value: String(bridge.controlledBySize.single) },
    { metric: "controlled_small_parcel", value: String(bridge.controlledBySize.small) },
    { metric: "controlled_multifamily_parcel", value: String(bridge.controlledBySize.multifamily) },
    { metric: "report_controlled_total", value: String(RCB_2025.controlledTotal) },
    { metric: "report_as_of", value: RCB_2025.asOf },
  ];
  writeCsvSorted(BRIDGE_CSV, ["metric", "value"], summary, ["metric"]);

  printReport(bridge);
  // eslint-disable-next-line no-console
  console.log(`\nWrote ${CATEGORIES_CSV}\nWrote ${BRIDGE_CSV}`);
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
