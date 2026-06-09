import { describe, it, expect } from "vitest";
import {
  historyToObs,
  prependChain,
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

describe("prependChain", () => {
  const obs = (at: string, mar: string, tenancy = "t") => ({
    unit_id: "u1",
    observed_at: at,
    mar,
    tenancy,
    source: SOURCE_PORTAL,
  });

  it("collapses carry-forward runs to one row per distinct value", () => {
    const cands = [obs("2015-01-01", "100"), obs("2015-09-01", "100"), obs("2016-01-01", "110")];
    const chain = prependChain(cands, "2023-07-19", null);
    expect(chain.map((c) => [c.observed_at, c.mar])).toEqual([
      ["2015-01-01", "100"],
      ["2016-01-01", "110"],
    ]);
  });

  it("drops only candidates in the observed era (>= earliest existing)", () => {
    const cands = [obs("2015-01-01", "100"), obs("2024-09-01", "150")];
    const chain = prependChain(cands, "2023-07-19", null);
    expect(chain.map((c) => c.observed_at)).toEqual(["2015-01-01"]);
  });

  it("drops a trailing backfill row that merely restates the existing baseline", () => {
    const cands = [obs("2015-01-01", "100"), obs("2022-09-01", "120")];
    const chain = prependChain(cands, "2023-07-19", { mar: "120", tenancy: "t" });
    expect(chain.map((c) => c.mar)).toEqual(["100"]); // the 120 row equals the baseline → dropped
  });
});

describe("buildMergePlan", () => {
  const existing: Row[] = [
    { unit_id: "u1", observed_at: "2023-07-19", mar_amount_cents: "300000", tenancy_date: "2010-06-01" },
  ];
  const registry = new Set(["u1"]);

  it("prepends pre-baseline history, stamps provenance, preserves existing rows", () => {
    const history = [
      hist("u1", "2015", "250000", "255000", "2010-06-01"),
      hist("u1", "2016", "255000", "260000", "2010-06-01"),
    ];
    const plan = buildMergePlan(existing, history, registry);
    // existing row preserved + stamped mar_tool
    const ex = plan.obsRows.find((r) => r.observed_at === "2023-07-19");
    expect(ex?.source).toBe(SOURCE_MAR_TOOL);
    // backfill rows added, all portal-sourced and strictly before the baseline
    const added = plan.obsRows.filter((r) => r.source === SOURCE_PORTAL);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((r) => (r.observed_at ?? "") < "2023-07-19")).toBe(true);
    expect(plan.unitsDeepened).toBe(1);
  });

  it("counts units not in the registry as orphans and excludes them", () => {
    const history = [hist("ghost", "2015", "250000", "255000")];
    const plan = buildMergePlan(existing, history, registry);
    expect(plan.orphanUnits).toBe(1);
    expect(plan.obsRows.filter((r) => r.source === SOURCE_PORTAL)).toHaveLength(0);
  });
});
