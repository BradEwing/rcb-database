/**
 * Helpers for the event-sourced (sparse) `mar_observations.csv` model.
 *
 * `mar_observations.csv` is a *change log*, not a per-run snapshot: a unit gets a
 * new row only when its `(mar_amount_cents, tenancy_date)` differs from its
 * latest existing row (the first sighting always writes a baseline). The current
 * MAR of any unit is its latest observation — carry-forward. See
 * `docs/design/sparse-observations.md`.
 *
 * These functions are pure so the drill / migration logic that depends on them
 * is unit-testable without touching the network or the filesystem.
 */
import type { Row } from "./csv.ts";
import type { MarObservationRow, UnitRow } from "./normalize.ts";

export type LatestMar = { mar_amount_cents: string; tenancy_date: string };

/**
 * Build `unit_id -> latest known (mar, tenancy)` from observations strictly
 * *before* `asOf`. Excluding `asOf` itself means a same-day re-run compares
 * against prior history, so it never sees its own freshly-appended rows as the
 * "latest" — that is what keeps a re-run idempotent.
 */
export function latestObservations(
  existingObs: Row[],
  asOf: string,
): Map<string, LatestMar> {
  // The obs file is written sorted by (unit_id, observed_at) ascending, but we
  // compare dates explicitly rather than rely on iteration order so this is
  // correct on arbitrary input too.
  const latestDate = new Map<string, string>();
  const latest = new Map<string, LatestMar>();
  for (const o of existingObs) {
    const observedAt = o.observed_at ?? "";
    if (observedAt >= asOf) continue;
    const id = o.unit_id ?? "";
    const prevDate = latestDate.get(id);
    if (prevDate !== undefined && observedAt <= prevDate) continue;
    latestDate.set(id, observedAt);
    latest.set(id, {
      mar_amount_cents: o.mar_amount_cents ?? "",
      tenancy_date: o.tenancy_date ?? "",
    });
  }
  return latest;
}

/**
 * Should `obs` be appended to the change log? True when the unit has never been
 * observed (first sighting → baseline) or its (mar, tenancy) differs from the
 * latest known value.
 */
export function observationChanged(
  latest: Map<string, LatestMar>,
  obs: MarObservationRow,
): boolean {
  const prev = latest.get(obs.unit_id);
  if (!prev) return true;
  return (
    prev.mar_amount_cents !== obs.mar_amount_cents ||
    prev.tenancy_date !== obs.tenancy_date
  );
}

/**
 * Merge observed units into the existing `units.csv` rows, stamping
 * `last_seen_at = today` on every observed unit. Existing units keep their
 * `first_seen_at` (and other recorded fields); only `last_seen_at` is bumped.
 * Newly-seen units are added as-is (their `first_seen_at`/`last_seen_at` are
 * already today, set by `parsePhaseUnits`). Units not observed this run are left
 * untouched, so their stale `last_seen_at` marks them as candidates for exit.
 */
export function upsertUnits(
  existing: Row[],
  observed: Map<string, UnitRow>,
  today: string,
): Row[] {
  const byId = new Map<string, Row>();
  for (const u of existing) byId.set(u.unit_id ?? "", u);
  for (const [id, u] of observed) {
    const ex = byId.get(id);
    if (ex) byId.set(id, { ...ex, last_seen_at: today });
    else byId.set(id, u as unknown as Row);
  }
  return [...byId.values()];
}

/**
 * One-time migration helper: prune snapshot rows that merely restate the
 * baseline. A `snapshotDate` row is dropped when the same unit has a
 * `baselineDate` row with identical `(mar, tenancy)` — carry-forward makes it
 * redundant. Baseline rows and rows that actually changed are kept.
 */
export function pruneUnchangedSnapshot(
  obs: Row[],
  baselineDate: string,
  snapshotDate: string,
): { kept: Row[]; pruned: number } {
  const baseline = new Map<string, LatestMar>();
  for (const o of obs) {
    if ((o.observed_at ?? "") !== baselineDate) continue;
    baseline.set(o.unit_id ?? "", {
      mar_amount_cents: o.mar_amount_cents ?? "",
      tenancy_date: o.tenancy_date ?? "",
    });
  }
  let pruned = 0;
  const kept = obs.filter((o) => {
    if ((o.observed_at ?? "") !== snapshotDate) return true;
    const b = baseline.get(o.unit_id ?? "");
    if (
      b &&
      b.mar_amount_cents === (o.mar_amount_cents ?? "") &&
      b.tenancy_date === (o.tenancy_date ?? "")
    ) {
      pruned++;
      return false;
    }
    return true;
  });
  return { kept, pruned };
}
