# Project status & roadmap

Last updated: 2026-06-11. This is the running record of what's shipped and what's
planned. Design specs (current and historical) are indexed at the bottom; CLAUDE.md
carries only the durable operating knowledge.

## Shipped

### Registry (seeded 2026-06-07)

- Scraper implemented and tested against fixtures; both long sweeps run end-to-end
  against the City's servers.
- `streets.csv` (147), `parcels.csv` (10,714 address-rows / ~8,500 distinct APNs),
  `units.csv` + `mar_observations.csv` (35,419 units — 32,900 controlled, 2,519 exempt).
- Phase B runs as a bounded concurrent pool in ~4 min.
- The ~19% overage vs the RCB report's 27,589 headline is **resolved** — definitional,
  not a scraper defect. See `docs/reconciliation-2025.md`.
- `mar_observations.csv` is an event-sourced change log (one row per change,
  carry-forward semantics — see `docs/design/sparse-observations.md`), so monthly
  snapshots grow slowly and each `git diff` is itself the change-log.
- The monthly GitHub Action cron is wired up
  (`.github/workflows/monthly-snapshot.yml`) but has not yet run on schedule.

### Deep MAR-history backfill — complete and merged

Per-unit annual MAR back to ~2012 from the rentcontroldocs OnBase portal. The
four-stage scraper family (`scraper/src/history/`) was validated end-to-end (10/10
anchor match, period-aligned QA 94.7%), the full run finished (index: 8,524 APNs /
264k docs / 0 WAF), and `history-merge --write` has been applied —
`mar_observations.csv` now carries a `source` column with ~195.7k
`portal_mar_report` rows (2012→present) alongside ~67.7k `mar_tool` rows (commit
`50988bb`). Spec + operational learnings: `docs/design/mar-history-backfill.md`.

### Static site — built and deployed

Live at https://bradewing.github.io/rcb-database/ (delivered across PRs 1–7; see
`docs/design/static-site.md`).

- **Map**: interactive parcel choropleth with per-unit breakdowns, change/exit
  layers, search, methodology page.
- **City-limits boundary overlay**: city outline + a dim of everything outside,
  toggleable from the legend; fetched via `npm run fetch-boundary`, cached at
  `data/external/city-boundary.geojson`.
- **3D map density view** (`docs/design/charts-and-density.md` #3): VoteHub-style
  toggleable "3D buildings" mode — pitches the camera and extrudes each parcel by
  its controlled-unit count via a `fill-extrusion` layer, coloured by the active
  metric, 1×–5× height multiplier, clickable through to the detail panel.
- **`/charts` analytics page** (`docs/design/charts-and-density.md`), built from
  `analytics.json` (`buildAnalytics` in `site/scripts/build-data.ts`):
  - Median MAR by bedroom over time — reconstructed as-of each **month** from the
    change log, back to 2012 via the portal backfill. **3+ BR omitted pending
    issue #11** — its reconstructed median drops -15.5% at the 2023 portal→sweep
    boundary (composition skew or a bucket-specific backfill defect).
  - Current-median-by-bedroom text table (the bar chart it accompanied was dropped
    as redundant).
  - Allowed-rent-by-tenancy-vintage view — current MAR vs the month a tenancy
    began; one chart overlaying Studio/1BR/2BR, colour per bucket, legend-chip
    toggles per series, 3+ BR excluded; quarterly median + IQR band, aggregates
    only, no raw-unit scatter; 10,919 empty-tenancy units excluded and counted.
  - New-tenancy-rents-over-time view (`docs/design/charts-and-density.md` #4) —
    the vintage chart's reset-anchored companion: median rent set *at* tenancy
    start, per quarter the tenancy began; one point per GA-clean turnover event,
    14,005 kept / 37.4k GA-lag-excluded at seed; same renderer/bands.
- **GoatCounter analytics**: cookie-free page-view tracking, prod builds only.

### Parcel use-class enrichment — increment 1 (shipped 2026-06)

`docs/design/parcel-enrichment.md` first increment: `fetch-geometry` now also
caches the City layer's raw `usetype`/`usedescrip` per parcel; a derived
`use_class` (single / two / three / four / five_plus / commercial / other —
**no condo split in this layer**, that needs the Assessor increment) flows into:

- the map's **"Use type" categorical choropleth** (Single / Duplex / 3+ units /
  Commercial / Other), whose legend rows double as hide/show **class filters**,
  plus tooltip + detail-panel "County use:" labels;
- `unit_categories.csv` (`use_class` column) and a **re-based `rcb_comparable`**:
  controlled units NOT on assessor-single/two/three parcels (size-proxy fallback
  for the 1.1% unmatched APNs) → 26,556 vs the 27,589 report headline (-3.7%;
  legacy size-proxy figure 26,754 kept as `registry_multifamily_controlled`).
- Coverage at ship: 98.86% of registry APNs, 100% use-field fill among matched;
  95% loud-fail gates in both `reconcile` and `build-data`.

### Change attribution

`npm run changes` → `data/derived/mar_changes.csv`; map UI for changes/exits
shipped. No GA-formula reconstruction (deliberate — see CLAUDE.md "Design
decisions that must not regress").

## Roadmap

- **Tenancy-registration / final-rent OCR parsers** — pre-2013 reset values. The
  docs are already indexed and fetchable (`history-fetch` without `--annual-only`);
  only the OCR parsers are missing.
- **Use-type / vintage enrichment, increments 2+** (ADU vs rental SFR,
  pre/post-1979 vintage, SFR-vs-condo split via LA County Assessor data) — see
  `docs/design/parcel-enrichment.md`; increment 1 (City-layer use class) shipped.
- **Issue #11** — diagnose the 3+ BR median discontinuity at the 2023 portal→sweep
  boundary; restore 3+ BR to the over-time and vintage charts.
- **First scheduled monthly snapshot** — the cron is wired but hasn't fired yet;
  verify the first unattended run end-to-end (sweep → commit → Pages rebuild).

## Spec index

| Doc | Scope | Status |
|---|---|---|
| `docs/design/static-site.md` | Map site architecture, build-data artifacts | shipped |
| `docs/design/charts-and-density.md` | /charts analytics + 3D density view | shipped (3+ BR pending issue #11) |
| `docs/design/mar-history-backfill.md` | OnBase portal backfill (4-stage scraper) | shipped; tenancy/final-rent parsers future |
| `docs/design/sparse-observations.md` | Event-sourced observation change log | shipped |
| `docs/design/parcel-enrichment.md` | Use-type/vintage enrichment | increment 1 shipped; Assessor/permits planned |
| `docs/reconciliation-2025.md` | RCB 2025 Annual Report bridge | resolved; re-run monthly |
| `docs/backfill-2023.md` | One-time 2023 baseline backfill | historical |
