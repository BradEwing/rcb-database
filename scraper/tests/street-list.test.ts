import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStreetList } from "../src/street-list.ts";

const fixturePath = join(
  import.meta.dirname,
  "fixtures",
  "street-list.html",
);

describe("parseStreetList", () => {
  const html = readFileSync(fixturePath, "utf8");
  const streets = parseStreetList(html);

  it("extracts a meaningful number of street names", () => {
    // The published list is the universe of streets with at least one
    // rent-controlled unit (not all city streets), so commercial corridors
    // like Wilshire are deliberately absent. Empirically ~145-200 entries.
    expect(streets.length).toBeGreaterThan(140);
    expect(streets.length).toBeLessThan(500);
  });

  it("includes known residential streets in MAR-form canonical spelling", () => {
    expect(streets).toContain("Colorado Ave");
    expect(streets).toContain("Lincoln Blvd");
    expect(streets).toContain("Ocean Ave");
    expect(streets).toContain("Montana Ave");
  });

  it("handles streets with no type suffix (e.g. Broadway)", () => {
    expect(streets).toContain("Broadway");
  });

  it("normalizes numeric streets to lowercase ordinals", () => {
    // The MAR form's own example uses "10th St" (not "10TH ST" or "10th Street").
    expect(streets).toContain("10th St");
    expect(streets).toContain("2nd St");
  });

  it("produces no duplicate names", () => {
    expect(new Set(streets).size).toBe(streets.length);
  });

  it("emits canonical title-cased names with optional known suffix", () => {
    for (const s of streets) {
      // Either a multi-word name ending in a recognized type suffix, or a
      // bare suffix-less street from the curated whitelist.
      expect(s).toMatch(
        /^(\S+( \S+)* (Ave|Blvd|St|Rd|Dr|Way|Pl|Ln|Ct|Ter|Trl|Pkwy|Cir|Aly|Walk|Lane|Mall|Park|Front|Hwy|Promenade|Road)|Broadway)$/,
      );
    }
  });
});
