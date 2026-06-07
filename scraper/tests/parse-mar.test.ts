import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMarPage } from "../src/parse-mar.ts";
import {
  parsePhaseAddresses,
  parsePhaseUnits,
} from "../src/normalize.ts";

const fixturesDir = join(import.meta.dirname, "fixtures");
const read = (name: string) =>
  readFileSync(join(fixturesDir, name), "utf8");

describe("parseMarPage", () => {
  it("returns null grids when the form has not been submitted", () => {
    const page = parseMarPage(read("mar-empty-form.html"));
    // The empty form HTML has no #gvAddresses or #gvMarData in the DOM — the
    // grids are only rendered after a postback. Our parser must therefore
    // return null grids rather than empty ones, so callers can distinguish
    // "no search performed" from "search returned zero rows".
    expect(page.addresses).toBeNull();
    expect(page.marData).toBeNull();
    expect(page.message).toBe("");
  });

  it("parses gvAddresses from a blank-number street sweep", () => {
    const page = parseMarPage(read("colorado-ave-list.html"));
    expect(page.addresses).not.toBeNull();
    expect(page.marData).toBeNull();
    expect(page.addresses!.headers).toEqual(["Addresses"]);
    expect(page.addresses!.rows.length).toBeGreaterThan(40);
    expect(page.addresses!.rows.length).toBeLessThan(120);
    expect(page.addresses!.rows[0]?.Addresses).toMatch(/COLORADO AVE$/);
  });

  it("parses gvMarData from a property drill-down", () => {
    const page = parseMarPage(read("624-lincoln-blvd.html"));
    expect(page.marData).not.toBeNull();
    expect(page.marData!.headers).toEqual([
      "Address",
      "Unit",
      "MAR",
      "Tenancy Date",
      "Bedrooms",
      "Parcel",
    ]);
    expect(page.marData!.rows).toHaveLength(6);
    const unitA = page.marData!.rows[0]!;
    expect(unitA.Unit).toBe("A");
    expect(unitA.MAR).toBe("$3,373");
    expect(unitA.Parcel).toBe("4293011005");
  });
});

describe("parsePhaseAddresses", () => {
  it("emits parcel rows with parsed street numbers", () => {
    const page = parseMarPage(read("colorado-ave-list.html"));
    const rows = parsePhaseAddresses(page, "Colorado Ave", "2026-06-07T00:00:00.000Z");
    expect(rows.length).toBeGreaterThan(40);
    // Every row has a non-empty street_number and the canonical street_name.
    for (const r of rows) {
      expect(r.street_number).toMatch(/^\d/);
      expect(r.street_name).toBe("COLORADO AVE");
      expect(r.parcel_id).toMatch(/^\d.+-colorado-ave$/);
      expect(r.first_seen_at).toBe("2026-06-07");
      expect(r.apn).toBe(""); // APN filled in during phase B
    }
  });
});

describe("parsePhaseUnits", () => {
  const page = parseMarPage(read("624-lincoln-blvd.html"));
  const out = parsePhaseUnits(
    page,
    "624",
    "Lincoln Blvd",
    "2026-06-07T00:00:00.000Z",
  );

  it("yields a unit row per MAR grid row, keyed by the row's own address", () => {
    expect(out.units).toHaveLength(6);
    expect(out.units[0]?.unit_label).toBe("A");
    expect(out.units[0]?.bedrooms).toBe("2");
    expect(out.units[0]?.address).toBe("624 LINCOLN BLVD");
    expect(out.units[0]?.apn).toBe("4293011005");
    expect(out.units[0]?.unit_id).toBe("624-lincoln-blvd-a");
  });

  it("yields an MAR observation per row with cents and ISO tenancy date", () => {
    expect(out.observations).toHaveLength(6);
    const obsA = out.observations[0]!;
    expect(obsA.mar_amount_cents).toBe("337300"); // $3,373.00
    expect(obsA.tenancy_date).toBe("2021-03-01"); // 3/1/2021
    expect(obsA.observed_at).toBe("2026-06-07");

    // Unit B has no tenancy date (the &nbsp; cell).
    const obsB = out.observations[1]!;
    expect(obsB.mar_amount_cents).toBe("93400"); // $934
    expect(obsB.tenancy_date).toBe("");
  });

  it("extracts the LA County APN as a parcel-level attribute", () => {
    expect(out.apn).toBe("4293011005");
  });
});

describe("parsePhaseUnits — multi-address parcel (the de-dup fix)", () => {
  // This response was captured by querying "1430 SANTA MONICA BLVD", but APN
  // 4282021001 spans several addresses, so the form returns the parcel's whole
  // unit list — each row carrying its OWN address (e.g. "1410 15TH ST"). Units
  // must be keyed by that row address, NOT by the queried street, or the same
  // physical units get counted once per alias address.
  const page = parseMarPage(read("1430-santa-monica-blvd.html"));
  const out = parsePhaseUnits(page, "1430", "Santa Monica Blvd", "2026-06-07T00:00:00.000Z");

  it("keys units by the row's address, not the queried street", () => {
    // The queried street never appears in any unit_id…
    expect(out.units.every((u) => !u.unit_id.startsWith("1430-santa-monica-blvd"))).toBe(true);
    // …and the canonical addresses from the grid do.
    const u = out.units.find((x) => x.address === "1410 15TH ST" && x.unit_label === "22");
    expect(u?.unit_id).toBe("1410-15th-st-22");
    expect(u?.apn).toBe("4282021001");
  });

  it("produces identical unit_ids regardless of which alias address was queried", () => {
    // Same parcel, queried by a different alias — unit_ids must match exactly,
    // which is what lets mergeRows collapse the duplicates.
    const viaOther = parsePhaseUnits(
      parseMarPage(read("1430-santa-monica-blvd.html")),
      "9999",
      "Some Other St",
      "2026-06-07T00:00:00.000Z",
    );
    expect(new Set(viaOther.units.map((u) => u.unit_id))).toEqual(
      new Set(out.units.map((u) => u.unit_id)),
    );
  });
});
