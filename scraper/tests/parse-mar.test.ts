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

  it("yields a unit row per MAR grid row", () => {
    expect(out.units).toHaveLength(6);
    expect(out.units[0]?.unit_label).toBe("A");
    expect(out.units[0]?.bedrooms).toBe("2");
    expect(out.units[0]?.parcel_id).toBe("624-lincoln-blvd");
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
