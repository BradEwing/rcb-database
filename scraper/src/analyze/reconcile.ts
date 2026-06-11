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
 * This module classifies each unit along independently-derivable dimensions —
 * MAR status, parcel size (the legacy single-family/condo proxy), and the
 * parcel's county-assessor use class (from the cached City "Parcels Public"
 * layer; see docs/design/parcel-enrichment.md) — and prints a bridge from the
 * registry total to the report headline. It does not mutate the source-of-truth
 * CSVs; it writes derived artifacts under data/derived/ and a human-readable
 * bridge to stdout.
 *
 * Run: `npm run reconcile`
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readCsv, writeCsvSorted, type Row } from "../csv.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const DATA_DIR = join(REPO_ROOT, "data");
const UNITS_CSV = join(DATA_DIR, "units.csv");
const OBS_CSV = join(DATA_DIR, "mar_observations.csv");
const DERIVED_DIR = join(DATA_DIR, "derived");
const CATEGORIES_CSV = join(DERIVED_DIR, "unit_categories.csv");
const BRIDGE_CSV = join(DERIVED_DIR, "reconciliation_summary.csv");
const GEOMETRY_CACHE = join(DATA_DIR, "external", "parcels-geometry.geojson");

/** Minimum fraction of registry APNs that must carry assessor use attributes in
 *  the geometry cache. Observed 98.86% (= geometry coverage — same layer); below
 *  this the cache is stale or pre-enrichment, so fail loudly (repo convention). */
const MIN_USE_MATCH_RATE = 0.95;

/** Bedroom buckets, matching the report's "0 / 1 / 2 / 3(or more)" grouping. */
export type BedroomBucket = "0" | "1" | "2" | "3+" | "unknown";
/** Parcel size classes. "single" is the single-family-home / condo proxy. */
export type SizeClass = "single" | "small" | "multifamily";
export type MarStatus = "controlled" | "zero_mar";

/**
 * County-assessor use class, derived per APN from the City "Parcels Public"
 * layer's `usetype`/`usedescrip` (cached with the geometry — see
 * docs/design/parcel-enrichment.md). NOTE: the layer has no condo distinction;
 * "single" lumps SFR + condos (the split needs the Assessor increment).
 * Mirrored in site/scripts/lib/registry.ts `useClassOf` — keep in sync.
 */
export type UseClass =
  | "single"
  | "two"
  | "three"
  | "four"
  | "five_plus"
  | "commercial"
  | "other"
  | "unknown";

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
  /** Assessor use class of the unit's parcel ("unknown" when the APN isn't in the cache). */
  use_class: UseClass;
  /**
   * Counts toward the RCB-comparable "controlled" estimate: positive MAR on a
   * parcel the assessor does NOT class as single (SFR/condo rent-level
   * decontrol), two, or three (the 2–3 unit owner-occupied exemption zone).
   * Falls back to the parcel-size proxy (4+ units) when the APN has no
   * assessor match. Still a documented proxy — not a per-unit exemption
   * determination.
   */
  rcb_comparable: boolean;
};

/** Derive the coarse use class from the layer's raw `usetype`/`usedescrip`. */
export function useClassOf(usetype: string, usedescrip: string): UseClass {
  const t = (usetype ?? "").trim();
  const d = (usedescrip ?? "").trim();
  if (t === "Commercial") return "commercial";
  if (t === "Residential") {
    if (d === "Single") return "single";
    if (d.startsWith("Two Units")) return "two";
    if (d.startsWith("Three Units")) return "three";
    if (d.startsWith("Four Units")) return "four";
    if (d === "Five or more apartments") return "five_plus";
    return d ? "other" : "unknown"; // rooming houses, mobile homes, …
  }
  return t ? "other" : "unknown"; // institutional, industrial, government, …
}

/** apn → use class from the committed geometry cache (which carries the raw
 *  assessor attributes per feature). Fails loudly when the cache is absent —
 *  the monthly CI runs reconcile and must not silently fall back wholesale. */
function loadUseByApn(): Map<string, UseClass> {
  if (!existsSync(GEOMETRY_CACHE)) {
    throw new Error(
      `Geometry cache missing at ${GEOMETRY_CACHE} — run \`npm run fetch-geometry\` (site/) first; ` +
        `reconciliation needs its assessor use attributes.`,
    );
  }
  const cache = JSON.parse(readFileSync(GEOMETRY_CACHE, "utf8")) as {
    features: Array<{ properties?: { ain?: unknown; usetype?: unknown; usedescrip?: unknown } }>;
  };
  const byApn = new Map<string, UseClass>();
  for (const f of cache.features) {
    const p = f.properties ?? {};
    const ain = String(p.ain ?? "").replace(/\D/g, "");
    if (!ain || byApn.has(ain)) continue;
    byApn.set(ain, useClassOf(String(p.usetype ?? ""), String(p.usedescrip ?? "")));
  }
  return byApn;
}

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
 * Classify every unit using independently-derivable signals: MAR status (from
 * the latest observation), parcel size (units sharing an APN), and the parcel's
 * assessor use class (from the cached City layer). RCB-comparable = controlled
 * and not on an assessor single (SFR/condo) or two_three (owner-occ zone)
 * parcel; APNs without an assessor match fall back to the size proxy.
 */
export function classifyUnits(
  units: Row[],
  obs: Row[],
  useByApn: Map<string, UseClass> = new Map(),
): UnitClass[] {
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
    const use_class = useByApn.get(apn) ?? "unknown";
    const comparableParcel =
      use_class === "unknown"
        ? size_class === "multifamily"
        : use_class !== "single" && use_class !== "two" && use_class !== "three";
    return {
      unit_id: g(u, "unit_id"),
      apn,
      bedrooms: normBedrooms(g(u, "bedrooms")),
      mar_status,
      parcel_unit_count: size,
      size_class,
      use_class,
      rcb_comparable: mar_status === "controlled" && comparableParcel,
    };
  });
}

export type Bridge = {
  totalUnits: number;
  controlled: number;
  zeroMar: number;
  /** Legacy size-proxy estimate (controlled on a 4+ unit parcel) — kept for comparison. */
  multifamilyControlled: number;
  /** The published estimate: controlled units flagged rcb_comparable (assessor-based). */
  rcbComparable: number;
  controlledByBedroom: Record<BedroomBucket, number>;
  controlledBySize: Record<SizeClass, number>;
  controlledByUse: Record<UseClass, number>;
};

export function buildBridge(classes: UnitClass[]): Bridge {
  const controlled = classes.filter((c) => c.mar_status === "controlled");
  const byBedroom: Record<BedroomBucket, number> = { "0": 0, "1": 0, "2": 0, "3+": 0, unknown: 0 };
  const bySize: Record<SizeClass, number> = { single: 0, small: 0, multifamily: 0 };
  const byUse: Record<UseClass, number> = {
    single: 0,
    two: 0,
    three: 0,
    four: 0,
    five_plus: 0,
    commercial: 0,
    other: 0,
    unknown: 0,
  };
  for (const c of controlled) {
    byBedroom[c.bedrooms]++;
    bySize[c.size_class]++;
    byUse[c.use_class]++;
  }
  return {
    totalUnits: classes.length,
    controlled: controlled.length,
    zeroMar: classes.length - controlled.length,
    multifamilyControlled: controlled.filter((c) => c.size_class === "multifamily").length,
    rcbComparable: controlled.filter((c) => c.rcb_comparable).length,
    controlledByBedroom: byBedroom,
    controlledBySize: bySize,
    controlledByUse: byUse,
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
  lines.push("  Controlled by assessor use class (City Parcels Public layer):");
  lines.push(`    single (SFR/condo) ............. ${pad(b.controlledByUse.single, 6)}  (report excludes ${r.excluded.rentLevelDecontrolledSfrCondo} rent-level decontrolled)`);
  lines.push(`    two units (duplex) ............. ${pad(b.controlledByUse.two, 6)}`);
  lines.push(`    three units .................... ${pad(b.controlledByUse.three, 6)}  (2-3 zone: report excludes ${r.excluded.ownerOccupied2to3Unit} owner-occupied)`);
  lines.push(`    four units ..................... ${pad(b.controlledByUse.four, 6)}`);
  lines.push(`    five or more apartments ........ ${pad(b.controlledByUse.five_plus, 6)}`);
  lines.push(`    commercial / mixed ............. ${pad(b.controlledByUse.commercial, 6)}`);
  lines.push(`    other (instit., industrial…) ... ${pad(b.controlledByUse.other, 6)}`);
  lines.push(`    unknown (no assessor match) .... ${pad(b.controlledByUse.unknown, 6)}  (size-proxy fallback)`);
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
  lines.push(`  RCB-comparable estimate (assessor-based): ${b.rcbComparable}`);
  lines.push(`  vs report headline ${r.controlledTotal} → ${((b.rcbComparable / r.controlledTotal - 1) * 100).toFixed(1)}%`);
  lines.push(`  (legacy size-proxy estimate, 4+ unit parcels: ${b.multifamilyControlled})`);
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

function main(): void {
  const units = readCsv(UNITS_CSV);
  const obs = readCsv(OBS_CSV);
  if (units.length === 0) {
    throw new Error(`No units found at ${UNITS_CSV} — run the scraper first.`);
  }
  const useByApn = loadUseByApn();

  // Loud coverage QA (repo convention): if the cache no longer matches the
  // registry's APNs — or predates the use-attribute enrichment — abort rather
  // than silently classifying everything "unknown" (which would quietly revert
  // rcb_comparable to the size proxy).
  const apns = new Set(units.map((u) => g(u, "apn")).filter(Boolean));
  let matched = 0;
  for (const apn of apns) {
    const cls = useByApn.get(apn);
    if (cls && cls !== "unknown") matched++;
  }
  const useRate = apns.size ? matched / apns.size : 0;
  if (useRate < MIN_USE_MATCH_RATE) {
    throw new Error(
      `Assessor use coverage ${(useRate * 100).toFixed(2)}% < ${(MIN_USE_MATCH_RATE * 100).toFixed(0)}% ` +
        `(${matched}/${apns.size} APNs). The geometry cache is stale or predates the ` +
        `use-attribute fields — re-run \`npm run fetch-geometry\` (site/).`,
    );
  }

  const classes = classifyUnits(units, obs, useByApn);
  const bridge = buildBridge(classes);

  writeCsvSorted(
    CATEGORIES_CSV,
    ["unit_id", "apn", "bedrooms", "mar_status", "parcel_unit_count", "size_class", "use_class", "rcb_comparable"],
    classes.map((c) => ({
      unit_id: c.unit_id,
      apn: c.apn,
      bedrooms: c.bedrooms,
      mar_status: c.mar_status,
      parcel_unit_count: String(c.parcel_unit_count),
      size_class: c.size_class,
      use_class: c.use_class,
      rcb_comparable: c.rcb_comparable ? "1" : "0",
    })),
    ["unit_id"],
  );

  const summary: Row[] = [
    { metric: "registry_units_total", value: String(bridge.totalUnits) },
    { metric: "registry_controlled_positive_mar", value: String(bridge.controlled) },
    { metric: "registry_zero_mar", value: String(bridge.zeroMar) },
    // The published estimate (assessor-based) + the legacy size-proxy figure,
    // kept so stale readers of the old key never blank (cf. 4493454).
    { metric: "registry_rcb_comparable", value: String(bridge.rcbComparable) },
    { metric: "registry_multifamily_controlled", value: String(bridge.multifamilyControlled) },
    { metric: "controlled_single_parcel", value: String(bridge.controlledBySize.single) },
    { metric: "controlled_small_parcel", value: String(bridge.controlledBySize.small) },
    { metric: "controlled_multifamily_parcel", value: String(bridge.controlledBySize.multifamily) },
    { metric: "controlled_use_single", value: String(bridge.controlledByUse.single) },
    { metric: "controlled_use_two", value: String(bridge.controlledByUse.two) },
    { metric: "controlled_use_three", value: String(bridge.controlledByUse.three) },
    { metric: "controlled_use_four", value: String(bridge.controlledByUse.four) },
    { metric: "controlled_use_five_plus", value: String(bridge.controlledByUse.five_plus) },
    { metric: "controlled_use_commercial", value: String(bridge.controlledByUse.commercial) },
    { metric: "controlled_use_other", value: String(bridge.controlledByUse.other) },
    { metric: "controlled_use_unknown", value: String(bridge.controlledByUse.unknown) },
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
