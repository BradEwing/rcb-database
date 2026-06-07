import { describe, it, expect } from "vitest";
import { classifyChange, deriveChanges } from "../src/analyze/changes.ts";
import type { Row } from "../src/csv.ts";

const obs = (
  unit_id: string,
  observed_at: string,
  mar_amount_cents: string,
  tenancy_date = "",
): Row => ({ unit_id, observed_at, mar_amount_cents, tenancy_date });

describe("classifyChange", () => {
  it("attributes a moved tenancy_date to a new tenancy", () => {
    const r = classifyChange(
      obs("u", "2023-07-19", "200000", "2019-01-01"),
      obs("u", "2026-06-07", "180000", "2024-11-01"),
    );
    expect(r.reason).toBe("new_tenancy");
    expect(r.mar_status_change).toBe("");
  });

  it("attributes a same-tenancy MAR move to an MAR adjustment (GA/Board)", () => {
    const r = classifyChange(
      obs("u", "2023-07-19", "200000", "2019-01-01"),
      obs("u", "2026-06-07", "216600", "2019-01-01"),
    );
    expect(r.reason).toBe("mar_adjustment");
  });

  it("flags became_exempt when MAR drops to $0", () => {
    const r = classifyChange(
      obs("u", "2023-07-19", "200000", "2019-01-01"),
      obs("u", "2026-06-07", "0", "2019-01-01"),
    );
    expect(r.mar_status_change).toBe("became_exempt");
  });

  it("flags reinstated when MAR returns from $0", () => {
    const r = classifyChange(
      obs("u", "2023-07-19", "0", "2019-01-01"),
      obs("u", "2026-06-07", "250000", "2019-01-01"),
    );
    expect(r.mar_status_change).toBe("reinstated");
  });
});

describe("deriveChanges", () => {
  it("emits no change for a unit with a single (baseline) observation", () => {
    expect(deriveChanges([obs("u1", "2023-07-19", "200000")])).toHaveLength(0);
  });

  it("emits one change per adjacent observation pair, in date order", () => {
    // Deliberately out of order to prove it sorts before pairing.
    const rows: Row[] = [
      obs("u1", "2026-06-07", "216600", "2019-01-01"),
      obs("u1", "2023-07-19", "200000", "2019-01-01"),
      obs("u1", "2025-01-15", "206000", "2019-01-01"),
    ];
    const changes = deriveChanges(rows);
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({
      prev_observed_at: "2023-07-19",
      observed_at: "2025-01-15",
      old_mar_cents: 200000,
      new_mar_cents: 206000,
    });
    expect(changes[1]).toMatchObject({
      prev_observed_at: "2025-01-15",
      observed_at: "2026-06-07",
      new_mar_cents: 216600,
    });
  });

  it("keeps units independent", () => {
    const rows: Row[] = [
      obs("u1", "2023-07-19", "200000"),
      obs("u1", "2026-06-07", "210000"),
      obs("u2", "2026-06-07", "300000"), // u2 first seen in 2026 -> baseline only
    ];
    const changes = deriveChanges(rows);
    expect(changes.map((c) => c.unit_id)).toEqual(["u1"]);
  });
});
