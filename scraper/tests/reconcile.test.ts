import { describe, it, expect } from "vitest";
import {
  classifyUnits,
  buildBridge,
  normBedrooms,
  sizeClassOf,
  useClassOf,
  type UseClass,
} from "../src/analyze/reconcile.ts";
import type { Row } from "../src/csv.ts";

describe("normBedrooms", () => {
  it("buckets to the report's 0/1/2/3+ grouping", () => {
    expect(normBedrooms("0")).toBe("0");
    expect(normBedrooms("1")).toBe("1");
    expect(normBedrooms("2")).toBe("2");
    expect(normBedrooms("3")).toBe("3+");
    expect(normBedrooms("7")).toBe("3+");
  });
  it("treats blank / non-numeric as unknown", () => {
    expect(normBedrooms("")).toBe("unknown");
    expect(normBedrooms("studio")).toBe("unknown");
  });
});

describe("sizeClassOf", () => {
  it("maps parcel unit counts to size classes", () => {
    expect(sizeClassOf(1)).toBe("single");
    expect(sizeClassOf(2)).toBe("small");
    expect(sizeClassOf(3)).toBe("small");
    expect(sizeClassOf(4)).toBe("multifamily");
    expect(sizeClassOf(532)).toBe("multifamily");
  });
});

describe("useClassOf", () => {
  it("maps the City layer's residential descriptions to coarse classes", () => {
    expect(useClassOf("Residential", "Single")).toBe("single");
    expect(useClassOf("Residential", "Two Units")).toBe("two");
    expect(useClassOf("Residential", "Three Units (Any Combination)")).toBe("three");
    expect(useClassOf("Residential", "Four Units (Any Combination)")).toBe("four");
    expect(useClassOf("Residential", "Five or more apartments")).toBe("five_plus");
    expect(useClassOf("Residential", "Rooming Houses")).toBe("other");
  });
  it("maps commercial and non-residential use types", () => {
    expect(useClassOf("Commercial", "Store Combination")).toBe("commercial");
    expect(useClassOf("Commercial", "Hotel & Motels")).toBe("commercial");
    expect(useClassOf("Institutional", "Homes For Aged & Others")).toBe("other");
    expect(useClassOf("Industrial", "Warehousing, Distribution, Storage")).toBe("other");
  });
  it("treats blank fields as unknown", () => {
    expect(useClassOf("", "")).toBe("unknown");
    expect(useClassOf(" ", " ")).toBe("unknown");
    expect(useClassOf("Residential", "")).toBe("unknown");
  });
});

describe("classifyUnits", () => {
  const units: Row[] = [
    // A 4-unit parcel (multifamily), one of which is exempt ($0 MAR)
    { unit_id: "u1", apn: "A", address: "10 MAIN", unit_label: "1", bedrooms: "1", first_seen_at: "x" },
    { unit_id: "u2", apn: "A", address: "10 MAIN", unit_label: "2", bedrooms: "2", first_seen_at: "x" },
    { unit_id: "u3", apn: "A", address: "10 MAIN", unit_label: "3", bedrooms: "2", first_seen_at: "x" },
    { unit_id: "u4", apn: "A", address: "10 MAIN", unit_label: "4", bedrooms: "3", first_seen_at: "x" },
    // A single-unit parcel (SFD/condo proxy) with a positive MAR
    { unit_id: "u5", apn: "B", address: "20 OAK", unit_label: "", bedrooms: "4", first_seen_at: "x" },
  ];
  const obs: Row[] = [
    { unit_id: "u1", observed_at: "d", mar_amount_cents: "250000", tenancy_date: "" },
    { unit_id: "u2", observed_at: "d", mar_amount_cents: "300000", tenancy_date: "" },
    { unit_id: "u3", observed_at: "d", mar_amount_cents: "0", tenancy_date: "" }, // exempt
    { unit_id: "u4", observed_at: "d", mar_amount_cents: "400000", tenancy_date: "" },
    { unit_id: "u5", observed_at: "d", mar_amount_cents: "500000", tenancy_date: "" },
  ];

  it("derives parcel size from APN membership across rows", () => {
    const c = classifyUnits(units, obs);
    expect(c.find((x) => x.unit_id === "u1")!.parcel_unit_count).toBe(4);
    expect(c.find((x) => x.unit_id === "u1")!.size_class).toBe("multifamily");
    expect(c.find((x) => x.unit_id === "u5")!.size_class).toBe("single");
  });

  it("marks positive MAR as controlled and $0 as zero_mar", () => {
    const c = classifyUnits(units, obs);
    expect(c.find((x) => x.unit_id === "u3")!.mar_status).toBe("zero_mar");
    expect(c.find((x) => x.unit_id === "u1")!.mar_status).toBe("controlled");
  });

  it("falls back to the size proxy for rcb_comparable when no assessor match", () => {
    const c = classifyUnits(units, obs); // no useByApn → every parcel "unknown"
    expect(c.find((x) => x.unit_id === "u1")!.use_class).toBe("unknown");
    // u1 controlled + multifamily-by-size -> true
    expect(c.find((x) => x.unit_id === "u1")!.rcb_comparable).toBe(true);
    // u3 exempt multifamily -> false
    expect(c.find((x) => x.unit_id === "u3")!.rcb_comparable).toBe(false);
    // u5 controlled but single parcel -> false (excluded as SFD/condo proxy)
    expect(c.find((x) => x.unit_id === "u5")!.rcb_comparable).toBe(false);
  });

  it("prefers the assessor use class over the size proxy for rcb_comparable", () => {
    const useByApn = new Map<string, UseClass>([
      // Assessor says parcel A (4 registry units) is really a 3-unit property
      // (owner-occ exemption zone) → its controlled units drop out.
      ["A", "three"],
      // Assessor says parcel B (1 registry unit) is a 5+ building (the rest of
      // its units unobserved/exempt) → its controlled unit now counts.
      ["B", "five_plus"],
    ]);
    const c = classifyUnits(units, obs, useByApn);
    expect(c.find((x) => x.unit_id === "u1")!.use_class).toBe("three");
    expect(c.find((x) => x.unit_id === "u1")!.rcb_comparable).toBe(false);
    expect(c.find((x) => x.unit_id === "u5")!.use_class).toBe("five_plus");
    expect(c.find((x) => x.unit_id === "u5")!.rcb_comparable).toBe(true);
  });

  it("excludes controlled units on duplex parcels (2-3 owner-occ zone)", () => {
    const useByApn = new Map<string, UseClass>([["A", "two"]]);
    const c = classifyUnits(units, obs, useByApn);
    expect(c.find((x) => x.unit_id === "u1")!.rcb_comparable).toBe(false);
  });

  it("counts controlled units on commercial (mixed-use) parcels as comparable", () => {
    const useByApn = new Map<string, UseClass>([["B", "commercial"]]);
    const c = classifyUnits(units, obs, useByApn);
    expect(c.find((x) => x.unit_id === "u5")!.rcb_comparable).toBe(true);
  });

  it("never flags exempt units regardless of use class", () => {
    const useByApn = new Map<string, UseClass>([["A", "five_plus"]]);
    const c = classifyUnits(units, obs, useByApn);
    expect(c.find((x) => x.unit_id === "u3")!.rcb_comparable).toBe(false);
  });
});

describe("classifyUnits — carry-forward (sparse event log)", () => {
  it("uses the most-recent observation when a unit has several", () => {
    const units: Row[] = [
      { unit_id: "u1", apn: "A", address: "10 MAIN", unit_label: "1", bedrooms: "1", first_seen_at: "x", last_seen_at: "y" },
    ];
    const obs: Row[] = [
      { unit_id: "u1", observed_at: "2023-07-19", mar_amount_cents: "100000", tenancy_date: "" },
      { unit_id: "u1", observed_at: "2026-06-07", mar_amount_cents: "0", tenancy_date: "" },
    ];
    // Latest observation is $0 -> zero_mar, not the older positive value.
    expect(classifyUnits(units, obs)[0]!.mar_status).toBe("zero_mar");
  });

  it("classifies a unit with only an old observation at that old MAR (no $0 default)", () => {
    // A unit unchanged since 2023 keeps a single 2023 row in the sparse log; it
    // must still classify as controlled via carry-forward, not fall through to $0.
    const units: Row[] = [
      { unit_id: "u1", apn: "A", address: "10 MAIN", unit_label: "1", bedrooms: "1", first_seen_at: "x", last_seen_at: "y" },
    ];
    const obs: Row[] = [
      { unit_id: "u1", observed_at: "2023-07-19", mar_amount_cents: "250000", tenancy_date: "" },
    ];
    expect(classifyUnits(units, obs)[0]!.mar_status).toBe("controlled");
  });
});

describe("buildBridge", () => {
  const units: Row[] = [
    { unit_id: "u1", apn: "A", address: "10 MAIN", unit_label: "1", bedrooms: "1", first_seen_at: "x" },
    { unit_id: "u2", apn: "A", address: "10 MAIN", unit_label: "2", bedrooms: "2", first_seen_at: "x" },
    { unit_id: "u3", apn: "A", address: "10 MAIN", unit_label: "3", bedrooms: "2", first_seen_at: "x" },
    { unit_id: "u4", apn: "A", address: "10 MAIN", unit_label: "4", bedrooms: "3", first_seen_at: "x" },
    { unit_id: "u5", apn: "B", address: "20 OAK", unit_label: "", bedrooms: "4", first_seen_at: "x" },
  ];
  const obs: Row[] = [
    { unit_id: "u1", observed_at: "d", mar_amount_cents: "250000", tenancy_date: "" },
    { unit_id: "u2", observed_at: "d", mar_amount_cents: "300000", tenancy_date: "" },
    { unit_id: "u3", observed_at: "d", mar_amount_cents: "0", tenancy_date: "" },
    { unit_id: "u4", observed_at: "d", mar_amount_cents: "400000", tenancy_date: "" },
    { unit_id: "u5", observed_at: "d", mar_amount_cents: "500000", tenancy_date: "" },
  ];

  it("counts controlled, zero-MAR, and the multifamily-controlled estimate", () => {
    const b = buildBridge(classifyUnits(units, obs));
    expect(b.totalUnits).toBe(5);
    expect(b.controlled).toBe(4); // u3 is $0
    expect(b.zeroMar).toBe(1);
    expect(b.multifamilyControlled).toBe(3); // u1,u2,u4 (u5 is single, u3 is exempt)
    // No assessor data → rcb_comparable falls back to the size proxy.
    expect(b.rcbComparable).toBe(3);
  });

  it("tallies controlled units by bedroom and size", () => {
    const b = buildBridge(classifyUnits(units, obs));
    expect(b.controlledByBedroom["1"]).toBe(1);
    expect(b.controlledByBedroom["2"]).toBe(1); // only u2 (u3 exempt excluded)
    expect(b.controlledByBedroom["3+"]).toBe(2); // u4 (3BR) + u5 (4BR)
    expect(b.controlledBySize.multifamily).toBe(3);
    expect(b.controlledBySize.single).toBe(1);
  });

  it("tallies controlled units by assessor use class and re-bases rcbComparable", () => {
    const useByApn = new Map<string, UseClass>([
      ["A", "five_plus"],
      ["B", "single"],
    ]);
    const b = buildBridge(classifyUnits(units, obs, useByApn));
    expect(b.controlledByUse.five_plus).toBe(3); // u1,u2,u4 (u3 exempt)
    expect(b.controlledByUse.single).toBe(1); // u5
    expect(b.rcbComparable).toBe(3); // u5 excluded by assessor single
    expect(b.multifamilyControlled).toBe(3); // legacy proxy unchanged
  });
});
