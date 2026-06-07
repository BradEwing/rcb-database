import { describe, it, expect } from "vitest";
import { latestSweepDate, deriveExits } from "../src/analyze/exits.ts";
import type { Row } from "../src/csv.ts";

const unit = (unit_id: string, last_seen_at: string): Row => ({
  unit_id,
  apn: "A",
  address: `${unit_id} MAIN`,
  unit_label: "",
  bedrooms: "1",
  first_seen_at: "2023-07-19",
  last_seen_at,
});

const obs = (unit_id: string, observed_at: string, mar: string, tenancy = ""): Row => ({
  unit_id,
  observed_at,
  mar_amount_cents: mar,
  tenancy_date: tenancy,
});

describe("latestSweepDate", () => {
  it("is the max across units' last_seen_at and the sweeps log", () => {
    const units = [unit("u1", "2026-06-07"), unit("u2", "2026-09-01")];
    const sweeps = [{ sweep_date: "2026-10-01" }];
    expect(latestSweepDate(units, sweeps)).toBe("2026-10-01");
  });

  it("works with no sweeps log (falls back to units)", () => {
    expect(latestSweepDate([unit("u1", "2026-06-07")], [])).toBe("2026-06-07");
  });
});

describe("deriveExits", () => {
  it("flags units whose last_seen_at predates the latest sweep", () => {
    const units = [unit("present", "2026-09-01"), unit("gone", "2026-06-07")];
    const exits = deriveExits(units, [], [{ sweep_date: "2026-09-01" }]);
    expect(exits.map((e) => e.unit_id)).toEqual(["gone"]);
    expect(exits[0]!.latest_sweep).toBe("2026-09-01");
  });

  it("returns none when every unit was seen in the latest sweep", () => {
    const units = [unit("u1", "2026-09-01"), unit("u2", "2026-09-01")];
    expect(deriveExits(units, [], [{ sweep_date: "2026-09-01" }])).toHaveLength(0);
  });

  it("attaches the unit's last known MAR/tenancy (carry-forward)", () => {
    const units = [unit("gone", "2026-06-07"), unit("present", "2026-09-01")];
    const observations = [
      obs("gone", "2023-07-19", "200000", "2019-01-01"),
      obs("gone", "2026-06-07", "216600", "2019-01-01"),
    ];
    const e = deriveExits(units, observations, [{ sweep_date: "2026-09-01" }])[0]!;
    expect(e.last_mar_cents).toBe(216600);
    expect(e.last_tenancy).toBe("2019-01-01");
  });

  it("counts sweeps missed since last seen", () => {
    const units = [unit("gone", "2026-06-07")];
    const sweeps = [
      { sweep_date: "2026-06-07" },
      { sweep_date: "2026-07-01" },
      { sweep_date: "2026-08-01" },
    ];
    const e = deriveExits(units, [], sweeps)[0]!;
    expect(e.sweeps_missed).toBe(2); // 07-01 and 08-01 are after 06-07
  });

  it("skips rows with no last_seen_at and emits nothing when there is no sweep", () => {
    const units = [{ ...unit("u1", ""), last_seen_at: "" }];
    expect(deriveExits(units, [], [])).toHaveLength(0);
  });
});
