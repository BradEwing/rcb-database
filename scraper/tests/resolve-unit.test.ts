import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUnitResolver, type UnitResolver } from "../src/history/resolve-unit.ts";

// A miniature registry: a 10-unit building (numbered labels) and a 2-unit
// exempt parcel whose units carry the street number in the address, blank label.
const UNITS_CSV = `unit_id,apn,address,unit_label,bedrooms,first_seen_at,last_seen_at
854-9th-st-1,4281032011,854 9TH ST,1,2,2023-07-19,2026-06-07
854-9th-st-10,4281032011,854 9TH ST,10,2,2023-07-19,2026-06-07
933-centinela-ave,4264017046,933 CENTINELA AVE,,3,2023-07-19,2026-06-07
937-centinela-ave,4264017046,937 CENTINELA AVE,,3,2023-07-19,2026-06-07
`;

let dir: string;
let resolve: UnitResolver;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "resolve-"));
  const p = join(dir, "units.csv");
  writeFileSync(p, UNITS_CSV);
  resolve = buildUnitResolver(p);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("buildUnitResolver", () => {
  it("(a) resolves a newer-report full label by direct slug", () => {
    expect(resolve("4281032011", "854 9TH ST 1")).toBe("854-9th-st-1");
    expect(resolve("4281032011", "854 9TH ST 10")).toBe("854-9th-st-10");
  });

  it("(a) resolves an exempt full-address label by direct slug", () => {
    expect(resolve("4264017046", "933 CENTINELA AVE")).toBe("933-centinela-ave");
  });

  it("(b) resolves an older bare numeric label by trailing token", () => {
    expect(resolve("4281032011", "1")).toBe("854-9th-st-1");
    expect(resolve("4281032011", "10")).toBe("854-9th-st-10");
  });

  it("(c) resolves an older bare street number to the blank-label unit", () => {
    expect(resolve("4264017046", "933")).toBe("933-centinela-ave");
    expect(resolve("4264017046", "937")).toBe("937-centinela-ave");
  });

  it("returns null for an unknown APN or an unmatchable label", () => {
    expect(resolve("9999999999", "1")).toBeNull();
    expect(resolve("4281032011", "99")).toBeNull();
  });
});
