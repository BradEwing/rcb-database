# Design: event-sourced (sparse) MAR observations

**Status:** proposed · **Scope:** storage-model refactor · **Owner:** next session

## Problem

`mar_observations.csv` is a *full snapshot per run*: `drill-properties` appends
one row per (unit, date) for **every** unit, changed or not. MAR is sticky
(annual General Adjustment + sporadic tenancy resets), so this is ~12× redundant:

- +~35,419 rows **per monthly run** → ~425k rows/yr, ~19 MB/yr of CSV, and a
  +35k-line `git diff` every month.
- Across a *3-year* gap only ~91% of units changed at all; month-to-month churn
  is far smaller (changes cluster on the September GA date).
- Early symptom already hit: `git push` failed HTTP 400 at ~6 MB (worked only
  after `http.postBuffer=500MB`). The curve steepens every month.

The monthly cron (`.github/workflows/monthly-snapshot.yml`) has **not run on
schedule yet** — change the model now, before bloat accumulates.

## Target model

**`mar_observations.csv` becomes an event log.** Append a row for a unit only
when `(mar_amount_cents, tenancy_date)` **differs from that unit's latest
existing row** (first observation of a unit is always written). The current MAR
of any unit is its **latest** observation — carry-forward. This is already
exactly what `reconcile.ts` computes (last-write-wins over rows sorted by
`unit_id, observed_at`), so the read side needs no change.

Consequence: a unit unchanged since 2023 has a single `2023-07-19` row and no
later rows — and still classifies at its 2023 MAR via carry-forward. That is the
whole point.

### Schema changes

- **`units.csv`**: add `last_seen_at` (ISO date), rewritten to the run date for
  every unit observed in a sweep. Gives cheap liveness and disappearance
  detection without bloating the event log. (`first_seen_at` unchanged.)
- **`mar_observations.csv`**: unchanged columns; semantics change from
  "snapshot" to "change log".
- **New `data/sweeps.csv`** (optional but recommended, tiny — one row per run):
  `sweep_date, parcels_drilled, units_observed, units_changed, units_exited`.
  Run-level coverage/audit so "unchanged" vs "not observed" is always provable.

### Disappearance / exits

Phase 1: derive exits from `last_seen_at` lag (unit present in `units.csv` whose
`last_seen_at` < the latest sweep date = gone). Surface as a derived report; do
**not** write tombstone rows into the event log (keeps the log = MAR changes
only). Revisit explicit tombstones later if attribution needs them.

## Implementation

### `drill-properties` (`scraper/src/index.ts` + `normalize.ts`)

1. Load existing observations once; build `latest: Map<unit_id, {mar, tenancy}>`
   from rows with `observed_at < today` (so same-day re-runs are idempotent).
2. For each parsed `gvMarData` unit row:
   - upsert into `units.csv`; set `last_seen_at = today` (and `first_seen_at` if new).
   - if unit absent from `latest` **or** `(mar, tenancy) !== latest` → append an
     observation row `observed_at = today`.
3. Keep the existing keyed merge (`unit_id, observed_at`) + `writeCsvSorted` so a
   same-day re-run can't double-write.
4. Write/append the `sweeps.csv` row.

Idempotency check to preserve: re-running the same day must produce zero new rows.

### Migration (one-time script, e.g. `scraper/src/backfill/migrate-sparse.ts`)

- Prune `mar_observations.csv`: keep `2023-07-19` (baseline for all units); drop
  each `2026-06-07` row whose `(mar, tenancy)` equals the same unit's
  `2023-07-19` row (~3,039 rows). Keep 2026 rows that changed or are new.
- Add `last_seen_at = 2026-06-07` to every current `units.csv` row.
- Acceptance: `reconcile.ts` output (`reconciliation_summary.csv`) must be
  **byte-identical** before/after (carry-forward is value-preserving).

### `reconcile.ts`

No logic change expected. Add a regression test: a unit with only a 2023 row
(no 2026 row) is classified at its 2023 MAR (carry-forward), not as `$0`.

### Tests (`scraper/tests/`)

- drill appends an observation only when MAR or tenancy changed; otherwise none.
- drill always bumps `last_seen_at`.
- same-day re-run is a no-op (0 new observation rows).
- first sighting of a unit always writes a baseline row.
- reconcile carry-forward (unit with a single old observation).
- migration prunes only unchanged 2026 rows; reconcile summary unchanged.

### Docs

Update `CLAUDE.md` Schema section: `mar_observations.csv` is one row **per
change** (not per date); document `last_seen_at`, `sweeps.csv`, carry-forward
semantics, and disappearance-via-`last_seen_at`. Update the `drill-properties`
description.

## Out of scope (later)

- **GA-deviation-only storage** (store only departures from the deterministic
  published GA) — smaller still, but couples storage correctness to attribution
  logic. Separate phase.
- Explicit exit tombstones; the static site; month-over-month attribution UI.

## Expected outcome

- ~30–35k new rows/**year** (GA-dominated) vs ~425k — ~12× smaller; slow,
  diffable repo growth.
- Each monthly `git diff` *is* the change-log → free change attribution.
- `reconcile` output unchanged; all tests green.
