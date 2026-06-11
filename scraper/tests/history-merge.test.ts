import { describe, it, expect } from "vitest";
import {
  historyToObs,
  mergeUnitTimeline,
  buildMergePlan,
  SOURCE_MAR_TOOL,
  SOURCE_PORTAL,
} from "../src/history/merge-history.ts";
import type { Row } from "../src/csv.ts";

const hist = (
  unit_id: string,
  report_year: string,
  mar_cents: string,
  new_mar_cents: string,
  market_rate_established = "",
): Row => ({
  parcel: "p",
  unit_id,
  report_year,
  market_rate_established,
  mar_cents,
  new_mar_cents,
});

describe("historyToObs", () => {
  it("emits one row per report year from the current-MAR column, dated to the Sep-1 GA effective date of Y-1", () => {
    const rows = historyToObs(hist("u1", "2018", "200000", "204000", "2010-06-01"));
    expect(rows).toEqual([
      { unit_id: "u1", observed_at: "2017-09-01", mar: "200000", tenancy: "2010-06-01", source: SOURCE_PORTAL },
    ]);
  });

  it("skips empty current-MAR and bad years", () => {
    expect(historyToObs(hist("u1", "n/a", "200000", "204000"))).toEqual([]);
    expect(historyToObs(hist("u1", "2018", "", ""))).toEqual([]);
  });
});

describe("mergeUnitTimeline", () => {
  const p = (at: string, mar: string, tenancy = "t") => ({
    unit_id: "u1", observed_at: at, mar, tenancy, source: SOURCE_PORTAL,
  });
  const m = (at: string, mar: string, tenancy = "t") => ({
    unit_id: "u1", observed_at: at, mar, tenancy, source: SOURCE_MAR_TOOL,
  });

  it("collapses carry-forward runs to one row per distinct value", () => {
    const out = mergeUnitTimeline([], [p("2015-09-01", "100"), p("2016-09-01", "100"), p("2017-09-01", "110")]);
    expect(out.map((o) => [o.observed_at, o.mar])).toEqual([["2015-09-01", "100"], ["2017-09-01", "110"]]);
  });

  it("preserves authoritative anchors and inserts portal points before AND between them (gap refinement)", () => {
    const existing = [m("2023-07-19", "300"), m("2026-06-07", "350")];
    const portal = [p("2015-09-01", "250"), p("2023-09-01", "310")]; // pre-anchor + in the 2023→2026 gap
    const out = mergeUnitTimeline(existing, portal);
    expect(out.map((o) => [o.observed_at, o.mar, o.source])).toEqual([
      ["2015-09-01", "250", SOURCE_PORTAL],
      ["2023-07-19", "300", SOURCE_MAR_TOOL],
      ["2023-09-01", "310", SOURCE_PORTAL], // the Sep-2023 GA ceiling, in the gap
      ["2026-06-07", "350", SOURCE_MAR_TOOL],
    ]);
  });

  it("lets the authoritative observation win a value tie (same MAR, real date kept)", () => {
    const out = mergeUnitTimeline([m("2023-07-19", "300")], [p("2022-09-01", "300")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ observed_at: "2023-07-19", source: SOURCE_MAR_TOOL });
  });
});

describe("buildMergePlan", () => {
  const existing: Row[] = [
    { unit_id: "u1", observed_at: "2023-07-19", mar_amount_cents: "300000", tenancy_date: "2010-06-01" },
  ];
  const registry = new Set(["u1"]);

  it("deepens pre-2023 history AND refines the post-2023 gap, preserving the anchor", () => {
    const history = [
      hist("u1", "2015", "250000", "255000", "2010-06-01"), // → 2014-09-01 (pre)
      hist("u1", "2024", "310000", "317000", "2010-06-01"), // → 2023-09-01 (in-era gap)
    ];
    const plan = buildMergePlan(existing, history, registry);
    const ex = plan.obsRows.find((r) => r.observed_at === "2023-07-19");
    expect(ex?.source).toBe(SOURCE_MAR_TOOL); // anchor preserved + stamped
    const portal = plan.obsRows.filter((r) => r.source === SOURCE_PORTAL);
    expect(portal.some((r) => (r.observed_at ?? "") < "2023-07-19")).toBe(true); // deep history
    expect(portal.some((r) => (r.observed_at ?? "") > "2023-07-19")).toBe(true); // gap refinement
    expect(plan.inEraRefined).toBeGreaterThan(0);
    expect(plan.unitsDeepened).toBe(1);
  });

  it("counts units not in the registry as orphans and excludes them", () => {
    const history = [hist("ghost", "2015", "250000", "255000")];
    const plan = buildMergePlan(existing, history, registry);
    expect(plan.orphanUnits).toBe(1);
    expect(plan.obsRows.filter((r) => r.source === SOURCE_PORTAL)).toHaveLength(0);
  });
});
