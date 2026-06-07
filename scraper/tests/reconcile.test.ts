import { describe, it, expect } from "vitest";
import {
  classifyUnits,
  buildBridge,
  normBedrooms,
  sizeClassOf,
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

  it("flags rcb_comparable only for controlled multifamily units", () => {
    const c = classifyUnits(units, obs);
    // u1 controlled + multifamily -> true
    expect(c.find((x) => x.unit_id === "u1")!.rcb_comparable).toBe(true);
    // u3 exempt multifamily -> false
    expect(c.find((x) => x.unit_id === "u3")!.rcb_comparable).toBe(false);
    // u5 controlled but single parcel -> false (excluded as SFD/condo proxy)
    expect(c.find((x) => x.unit_id === "u5")!.rcb_comparable).toBe(false);
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
  });

  it("tallies controlled units by bedroom and size", () => {
    const b = buildBridge(classifyUnits(units, obs));
    expect(b.controlledByBedroom["1"]).toBe(1);
    expect(b.controlledByBedroom["2"]).toBe(1); // only u2 (u3 exempt excluded)
    expect(b.controlledByBedroom["3+"]).toBe(2); // u4 (3BR) + u5 (4BR)
    expect(b.controlledBySize.multifamily).toBe(3);
    expect(b.controlledBySize.single).toBe(1);
  });
});
