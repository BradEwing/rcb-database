import { describe, it, expect } from "vitest";
import {
  latestObservations,
  observationChanged,
  upsertUnits,
  pruneUnchangedSnapshot,
} from "../src/sparse.ts";
import type { Row } from "../src/csv.ts";
import type { MarObservationRow, UnitRow } from "../src/normalize.ts";

const obs = (
  unit_id: string,
  observed_at: string,
  mar_amount_cents: string,
  tenancy_date = "",
): Row => ({ unit_id, observed_at, mar_amount_cents, tenancy_date });

describe("latestObservations", () => {
  it("takes the most-recent value strictly before asOf", () => {
    const rows: Row[] = [
      obs("u1", "2023-07-19", "100000", "2020-01-01"),
      obs("u1", "2025-09-01", "110000", "2020-01-01"),
    ];
    const latest = latestObservations(rows, "2026-06-07");
    expect(latest.get("u1")).toEqual({
      mar_amount_cents: "110000",
      tenancy_date: "2020-01-01",
    });
  });

  it("ignores rows on/after asOf so a same-day re-run sees prior history only", () => {
    const rows: Row[] = [
      obs("u1", "2023-07-19", "100000"),
      obs("u1", "2026-06-07", "999999"), // today's own append — must be ignored
    ];
    const latest = latestObservations(rows, "2026-06-07");
    expect(latest.get("u1")?.mar_amount_cents).toBe("100000");
  });

  it("is order-independent (compares dates, not iteration order)", () => {
    const rows: Row[] = [
      obs("u1", "2025-09-01", "110000"),
      obs("u1", "2023-07-19", "100000"),
    ];
    expect(latestObservations(rows, "2026-06-07").get("u1")?.mar_amount_cents).toBe(
      "110000",
    );
  });
});

describe("observationChanged", () => {
  const latest = latestObservations(
    [obs("u1", "2023-07-19", "100000", "2020-01-01")],
    "2026-06-07",
  );
  const o = (
    mar_amount_cents: string,
    tenancy_date = "",
  ): MarObservationRow => ({
    unit_id: "u1",
    observed_at: "2026-06-07",
    mar_amount_cents,
    tenancy_date,
    source: "mar_tool",
  });

  it("is true for a first sighting (unit absent from latest)", () => {
    const fresh: MarObservationRow = {
      unit_id: "brand-new",
      observed_at: "2026-06-07",
      mar_amount_cents: "0",
      tenancy_date: "",
      source: "mar_tool",
    };
    expect(observationChanged(latest, fresh)).toBe(true);
  });

  it("is false when mar and tenancy are unchanged", () => {
    expect(observationChanged(latest, o("100000", "2020-01-01"))).toBe(false);
  });

  it("is true when the MAR moved", () => {
    expect(observationChanged(latest, o("110000", "2020-01-01"))).toBe(true);
  });

  it("is true when only the tenancy date moved (a reset)", () => {
    expect(observationChanged(latest, o("100000", "2024-11-01"))).toBe(true);
  });
});

describe("upsertUnits", () => {
  const existing: Row[] = [
    {
      unit_id: "u1",
      apn: "A",
      address: "10 MAIN",
      unit_label: "1",
      bedrooms: "2",
      first_seen_at: "2023-07-19",
      last_seen_at: "2026-06-07",
    },
  ];
  const newUnit: UnitRow = {
    unit_id: "u2",
    apn: "A",
    address: "10 MAIN",
    unit_label: "2",
    bedrooms: "1",
    first_seen_at: "2026-09-15",
    last_seen_at: "2026-09-15",
  };

  it("bumps last_seen_at on an observed existing unit, preserving first_seen_at", () => {
    const observed = new Map<string, UnitRow>([
      ["u1", { ...newUnit, unit_id: "u1", first_seen_at: "2026-09-15" }],
    ]);
    const merged = upsertUnits(existing, observed, "2026-09-15");
    const u1 = merged.find((u) => u.unit_id === "u1")!;
    expect(u1.last_seen_at).toBe("2026-09-15");
    expect(u1.first_seen_at).toBe("2023-07-19"); // preserved, not overwritten
  });

  it("adds a newly-seen unit as-is", () => {
    const observed = new Map<string, UnitRow>([["u2", newUnit]]);
    const merged = upsertUnits(existing, observed, "2026-09-15");
    expect(merged.find((u) => u.unit_id === "u2")).toMatchObject({
      first_seen_at: "2026-09-15",
      last_seen_at: "2026-09-15",
    });
  });

  it("leaves unobserved units untouched (stale last_seen_at marks an exit)", () => {
    const merged = upsertUnits(existing, new Map(), "2026-09-15");
    expect(merged.find((u) => u.unit_id === "u1")!.last_seen_at).toBe("2026-06-07");
  });
});

describe("pruneUnchangedSnapshot", () => {
  it("drops only snapshot rows that restate the baseline", () => {
    const rows: Row[] = [
      // u1: unchanged -> 2026 row pruned
      obs("u1", "2023-07-19", "100000", "2020-01-01"),
      obs("u1", "2026-06-07", "100000", "2020-01-01"),
      // u2: MAR changed -> 2026 row kept
      obs("u2", "2023-07-19", "100000"),
      obs("u2", "2026-06-07", "120000"),
      // u3: new since 2023 (no baseline) -> kept
      obs("u3", "2026-06-07", "90000"),
    ];
    const { kept, pruned } = pruneUnchangedSnapshot(rows, "2023-07-19", "2026-06-07");
    expect(pruned).toBe(1);
    const has = (id: string, date: string) =>
      kept.some((r) => r.unit_id === id && r.observed_at === date);
    expect(has("u1", "2023-07-19")).toBe(true);
    expect(has("u1", "2026-06-07")).toBe(false); // pruned
    expect(has("u2", "2026-06-07")).toBe(true);
    expect(has("u3", "2026-06-07")).toBe(true);
  });

  it("is idempotent — re-pruning the kept set prunes nothing", () => {
    const rows: Row[] = [
      obs("u1", "2023-07-19", "100000"),
      obs("u1", "2026-06-07", "100000"),
    ];
    const once = pruneUnchangedSnapshot(rows, "2023-07-19", "2026-06-07");
    const twice = pruneUnchangedSnapshot(once.kept, "2023-07-19", "2026-06-07");
    expect(twice.pruned).toBe(0);
  });
});
