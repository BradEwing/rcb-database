# Historical backfill — 2023-07-19 snapshot

The live `mar.aspx` tool only shows the *current* MAR, so this project's own
history starts at its first sweep (2026-06-07). The City, however, published a
single bulk dump of the entire registry on its CKAN open-data portal, frozen at
**2023-07-19**. Ingesting it gives the registry a genuine **second time-point
~3 years earlier** — real observed history, not formula-reconstructed.

- Raw snapshot + provenance: [`data/external/mar-2023-07-19/`](../data/external/mar-2023-07-19/README.md)
- Ingest script: `scraper/src/backfill/ingest-snapshot-2023.ts` (`npm run backfill:snapshot-2023`, idempotent)

## How units are matched

The registry keys a unit as `slug("<address> <unit_label>")`. The snapshot's
`UNITMASTER_ADDRESS` + `UNITMASTER_UNIT_ID` reproduce the identical key via the
same exported `slug()`. Validated join:

| | count | note |
|---|---:|---|
| Snapshot units | 36,244 | |
| **Matched (present in both)** | **35,303** | 99.7% of the registry; get a `2023-07-19` observation row |
| Gone by 2026 | 941 | exemption / demolition / re-label / decontrol |
| New since 2023 | 116 | |
| Key collisions | 0 | reconstructed `unit_id` is a clean key |
| APN disagreements (matched) | 7 | negligible |

## What changed in `data/`

- **`mar_observations.csv`**: 35,419 → **70,722** rows. Each matched unit now has
  two observations (`2023-07-19`, `2026-06-07`). MAR is stored in cents
  (snapshot `MAR1` is dollars, ×100); `effectivedate` → `tenancy_date` (ISO).
- **`data/derived/mar_change_2023_2026.csv`** (new, regenerable): per-unit
  2023→2026 delta — `mar_2023_cents`, `mar_2026_cents`, `mar_delta_cents`,
  `mar_pct`, `tenancy_2023/2026`, `tenancy_changed`, and a `status`
  (`present_both` / `gone_by_2026` / `new_since_2023`). The 941 disappeared units
  live here (and in the raw external file) — they are intentionally **not**
  added to `units.csv`, which stays the current-state registry so the
  RCB-headline reconciliation is unaffected (verified: `reconciliation_summary.csv`
  is byte-identical before/after).

## 2023 → 2026 signal (matched units)

- MAR increased: **30,766**  ·  decreased: **1,387**  ·  net **+$8.37M**/mo aggregate MAR
- Tenancy reset (effective-date changed): **7,562** units — candidate new-tenancy
  resets to attribute against the General Adjustment schedule.
- Decreases concentrate in high-MAR units turning over (e.g. ocean-front towers
  resetting from ~$20k to ~$13k on a new post-2022 tenancy).

This is a two-point series, not continuous: it cannot by itself separate annual
General Adjustments from mid-cycle tenancy resets within the gap. Pair
`tenancy_changed` with the published GA schedule (see research notes) to
attribute the rest.
