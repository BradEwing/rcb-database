# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Goal

Build a self-hosted registry of Santa Monica rent-controlled units by scraping the City's public Maximum Allowable Rent (MAR) lookup tool on a monthly schedule. The registry is the source of truth for tracking MAR changes over time (new tenancies, annual general adjustments, capital improvement pass-throughs, etc.) for every rent-controlled parcel in the city.

Everything core is shipped and live: the registry (seeded 2026-06-07, 35,419 units, per-unit MAR history back to 2012 via the portal backfill), the monthly snapshot cron, and the GitHub Pages site (interactive parcel map + `/charts` analytics) at https://bradewing.github.io/rcb-database/. **Status, shipped-feature history, and the roadmap live in `docs/status.md`**; design specs are indexed there and live in `docs/design/`.

## Stack

TS/Node only, end-to-end (Node 24 LTS). Chosen over Python+TS and Go-only to keep one language across scraper, build-time aggregates, and the static site / map / viz layer on GitHub Pages.

Runtime: `tsx`, `undici` (HTTP), `cheerio` (HTML), `zod` (parser validation), `pino` (logs), `csv-stringify` / `csv-parse`. Tests: `vitest` against HTML fixtures in `scraper/tests/fixtures/`. Storage: per-table CSV files in `data/`, committed to the repo so per-line `git diff` and `git blame` give a free per-MAR change history.

## Build, Test, Run

```sh
npm install
npm run typecheck
npm run test
npm run scraper -- <subcommand>
```

Scraper subcommands (defined in `scraper/src/index.ts`):

- `probe-one <street> [number]` — single ad-hoc POST. Saves raw HTML to `data/raw/`, dumps parsed grids. Use this whenever you suspect form behavior or layout has shifted.
- `refresh-streets` — fetch the official street-name list and rewrite `data/streets.csv`.
- `sweep-streets` (Phase A) — for each street in `data/streets.csv`, POST blank-number to get the property index; append to `data/parcels.csv`.
- `drill-properties` (Phase B) — for each parcel not drilled today, POST number+street to get units and MAR; upsert `data/units.csv` (bumping `last_seen_at`); append a row to `data/mar_observations.csv` **only when a unit's MAR/tenancy changed** (event-sourced — see Schema); backfill APN on `data/parcels.csv`; record a `data/sweeps.csv` coverage row. Idempotent — re-running on the same day skips parcels already drilled and produces zero new observation rows.
- `history-index` / `history-fetch` / `history-ocr` / `history-merge` — the deep MAR-history backfill family (`scraper/src/history/`), which mined the rentcontroldocs OnBase portal for per-unit annual MAR back to ~2012. **Complete and merged**; spec, CLI details, and operational learnings (politeness limits, run timings, the macOS `caffeinate -ism` gotcha) are in `docs/design/mar-history-backfill.md`. Key rules if re-running: index/fetch hit the City portal — **stay single-threaded** at `OBPA_MIN_DELAY_MS` (400 ms), never add session concurrency; OCR is local CPU — parallel pool via `OCR_WORKERS` (default 10). All stages are resumable/idempotent.

### Static site (`site/` — separate npm workspace)

The map site is its own package in `site/` (Astro + MapLibre GL JS + Observable Plot), so its deps don't mix with the scraper's. Run from inside `site/`:

```sh
npm install
npm run fetch-geometry   # occasional: cache City parcel polygons + usetype/usedescrip → data/external/ (committed)
npm run fetch-boundary   # occasional: cache the City boundary polygon → data/external/ (committed)
npm run build-data       # transform registry CSVs → site/public/data/ (gitignored build output)
npm run check            # astro check (typecheck for .astro + island scripts)
npm run build            # `prebuild` runs build-data first, then `astro build`
npm run dev              # local dev server
```

`fetch-geometry`/`fetch-boundary`/`build-data` are TS scripts under `site/scripts/` (typecheck them with `npx tsc -p site/scripts/tsconfig.json`; they reuse the registry CSVs read-only via `site/scripts/lib/registry.ts`). Build artifacts in `site/public/data/` and `site/dist/` are gitignored — only the cached City geometry (`data/external/parcels-geometry.geojson` and `data/external/city-boundary.geojson`) is committed. Deploy is `.github/workflows/pages.yml`.

## Commit Conventions

- **Conventional Commits**: `type: subject`, imperative, lower-case, no trailing period. Keep it terse — one line is the norm; add a body only when the *why* isn't obvious.
- **Types in use**: `feat`, `fix`, `docs`, `refactor`, `chore`, `ci`, plus project-specific `data` (registry CSV snapshots) and `analysis` (derived artifacts / reconciliation).
- **No `Co-Authored-By` trailer** and no tool attribution lines.

## Canonical Data Sources

- MAR lookup tool: https://www.smgov.net/departments/rentcontrol/mar.aspx
- Published street-name list (the universe filter — already formatted to match the MAR form's expected spelling): https://www.smgov.net/WorkArea/linkit.aspx?LinkIdentifier=id&ItemID=44652
- Rent Control program info: https://www.smgov.net/Departments/RentControl/content.aspx?id=44652
- Rent Control public document portal (filings, petitions, decisions): https://rentcontroldocs.santamonica.gov/
- LA County / Santa Monica GIS Parcels Public — only relevant for lat/lon + geometry on the map. APN is already returned inline by the MAR form, so no separate cross-walk is needed for APN attribution: https://gis-smgov.opendata.arcgis.com/datasets/smgov::parcels-public-1/explore

Treat smgov.net and santamonica.gov as the same program — the City migrated domains; both still serve live pages.

## MAR Form Behavior

ASP.NET WebForms at `mar.aspx`. One `<form>` posting back to itself. Every POST must replay `__VIEWSTATE`, `__VIEWSTATEGENERATOR`, `__EVENTVALIDATION`, and the Ektron CMS field `EktronClientManager`. The two text inputs are `ctl00$mainContent$txtStNumber` and `ctl00$mainContent$txtStreet`; the submit button is `ctl00$mainContent$btnSearch=Search`.

The form returns one of two GridViews, never both:

- **Blank number + street** → `gvAddresses`. Single column (`Addresses`), one row per controlled property on that street (e.g. `2615 COLORADO AVE`).
- **Number + street** → `gvMarData`. Columns: `Address`, `Unit`, `MAR`, `Tenancy Date`, `Bedrooms`, `Parcel`. `Parcel` is the LA County APN.
  - **Critical:** the form returns *every* unit on a parcel for *any* of that parcel's addresses, each row self-identifying via its own `Address` + `Unit`. A physical parcel (one APN) is listed in `gvAddresses` under several street addresses (corner lots, multi-frontage buildings), so querying each address re-returns the same unit list. Identify units by the row's own `Address` + `Unit` (`unit_id = slug("<row Address> <Unit>")`), **never** by the queried street — that double-counts. A single address query can even return units spanning multiple APNs.

Other observed behaviors:

- The `gvAddresses` anchor links (`?number=N&street=NAME`) are plain GET URLs that only **pre-fill** the form. A drill-down still requires a POST with the form-token triplet — the GET alone returns the empty form.
- `$0` MAR means the unit is currently exempt (Costa-Hawkins vacancy decontrol, Ellis-withdrawn, post-1978 exempt, etc.).
- Some addresses come back from `gvAddresses` but return zero `gvMarData` rows (e.g. 2615 / 2703 Colorado Ave). Record them in `parcels.csv` regardless — "in the index but currently no controlled units" is itself a tracked signal.
- The published street-name list is the universe of streets with at least one controlled unit (147 entries today). Commercial corridors like Wilshire are deliberately absent — do not assume it's a list of all Santa Monica streets.

## Design Decisions That Must Not Regress

- **The ~19% overage vs the RCB Annual Report is definitional — do not "fix" it by mangling data.** The MAR tool returns every unit with an established MAR, a *superset* of the report's "controlled" definition (which excludes rent-level-decontrolled SFR/condos, owner-occupied 2–3 unit exemptions, and other use-exempt units that still carry a positive MAR). The bridge closes against the report's own exclusion counts — see `docs/reconciliation-2025.md`. Publish both the registry total *and* the RCB-comparable estimate (`rcb_comparable`, persisted by `npm run reconcile`). Re-run `npm run reconcile` each month and bump the `RCB_2025` figures in `scraper/src/analyze/reconcile.ts` per the latest Annual Report.
- **No GA-formula reconstruction.** We do not reconstruct/predict the general adjustment from its published formula (it shifts yearly with CPI and by ballot — Measure RC changed it). Change attribution reads straight off whether the `tenancy_date` moved (`new_tenancy` vs `mar_adjustment`), so it can't drift with CPI or ballot changes.
- **Keep raw scraped values** (`data/raw/` snapshots, verbatim CSV columns) alongside derived fields so attribution can be re-run if classification logic changes.

## Schema (`data/`)

- `streets.csv` — `street_name, first_swept_at`. Mirrors the published street list.
- `parcels.csv` — `parcel_id, street_number, street_name, apn, first_seen_at, last_drilled_at`. `parcel_id` is `slug("<street_number> <street_name>")` — the *address* found in the street sweep; several `parcel_id`s can map to one `apn`. `apn` + `last_drilled_at` are filled in Phase B; re-running Phase B the same day skips parcels already stamped `last_drilled_at == today` (idempotent/resumable).
- `units.csv` — `unit_id, apn, address, unit_label, bedrooms, first_seen_at, last_seen_at`. A unit is keyed by the gvMarData row's OWN `address` + `unit_label`: `unit_id = slug("<address> <unit_label>")` (blank label → `slug("<address>")`). This de-duplicates the multi-address form behavior above while keeping genuinely distinct units (e.g. corner buildings with one unit per street number) apart. `apn` is the per-row LA County parcel. `last_seen_at` is rewritten to the run date for every unit observed in a sweep (`first_seen_at` is set once and never changes) — cheap liveness: a unit whose `last_seen_at` lags the latest sweep date has **disappeared** (demolition / full exemption), derived as a report rather than a tombstone row.
- `mar_observations.csv` — `unit_id, observed_at, mar_amount_cents, tenancy_date, source`. **Event-sourced change log, one row per *change* (not per run).** A unit gets a new row only when its `(mar_amount_cents, tenancy_date)` differs from its latest existing row; the first sighting of a unit always writes a baseline. The current MAR of any unit is its **latest** observation — **carry-forward**: a unit unchanged since 2023 keeps a single `2023-07-19` row and still reads at that MAR. Integer cents avoid float drift. Empty `tenancy_date` means the form returned `&nbsp;` (long-term tenancy, no recent reset). `mar_amount_cents=0` means exempt. `source` is provenance: `mar_tool` (form sweeps) vs `portal_mar_report` (OnBase backfill) — **every observation writer must carry it.** See `docs/design/sparse-observations.md`.
- `sweeps.csv` — `sweep_date, parcels_drilled, units_observed, units_changed, units_exited`. One row per Phase B run, derived from on-disk state so it is resume-safe and idempotent. Run-level coverage/audit, so "unchanged" (carried forward, no new obs row) is always distinguishable from "not observed" (`units_exited`).

All tables are sorted by primary key and written deterministically so month-over-month `git diff` is meaningful — and because the observation table is a change log, each monthly diff *is* the change attribution. `data/raw/` (per-query HTML snapshots) is gitignored — re-fetchable from the CSVs.

`data/derived/` holds regenerable analysis artifacts (committed for diff history). These are *derived*, never a source of truth — regenerate after each sweep.

- `npm run reconcile` → `unit_categories.csv` (`unit_id, apn, bedrooms, mar_status, parcel_unit_count, size_class, use_class, rcb_comparable`) classifies each unit by independently-derivable signals: MAR status, parcel size, and the parcel's assessor `use_class` (derived from `usetype`/`usedescrip` cached on `data/external/parcels-geometry.geojson` — reconcile **requires** that cache and fails loudly below 95% use coverage; the layer has no condo split, `single` = SFR or condo). `rcb_comparable` = controlled AND NOT on an assessor-`single`/`two`/`three` parcel (size-proxy fallback for unmatched APNs); the legacy size-proxy count stays as `registry_multifamily_controlled`. `reconciliation_summary.csv` is the bridge-summary metrics.
- `npm run changes` → `mar_changes.csv`: one row per rent change, derived from adjacent pairs in the observation change log. Columns include `old_mar_cents`, `new_mar_cents`, `delta_cents`, `delta_pct`, and `reason` — `new_tenancy` (the `tenancy_date` moved) vs `mar_adjustment` (ceiling moved under a sitting tenant: GA or Board order) — plus `mar_status_change` for `$0` exempt transitions (`became_exempt` / `reinstated`).

## Hosting & Distribution

**Live** on **GitHub Pages** at https://bradewing.github.io/rcb-database/ (Pages source = GitHub Actions; framework `base` = `/rcb-database/`, so every asset/data URL must be base-relative), with the registry data committed to the repo. No always-on server. Two workflows:

- `.github/workflows/monthly-snapshot.yml` — cron that runs Phase B (Phase A quarterly), commits the raw snapshot **before** the derived steps (so a derived-step failure — e.g. reconcile's stale-geometry hard-fail — can't hold the month's scrape hostage), commits the derived artifacts second, then explicitly dispatches the Pages rebuild. The explicit dispatch is required: bot pushes made with `GITHUB_TOKEN` never fire `pages.yml`'s push trigger (GitHub's recursion guard; verified in the 2026-06-11 dry run).
- `.github/workflows/pages.yml` — builds `site/` (`npm run check` then `npm run build`) and deploys via `actions/deploy-pages` on push to `main` touching `site/**` or `data/**` (human pushes only — see above), or on dispatch.

The site precomputes aggregates at build time via `site/scripts/build-data.ts` into `site/public/data/` (`parcels.geojson`, per-APN `parcels/<apn>.json` lazy-loaded on click, `summary.json`/`exits.geojson`/`search.json`/`meta.json`/`city-boundary.geojson`/`analytics.json` — the last feeds `/charts`). Parcel polygons come from the City **Parcels Public** FeatureServer; the join field is **`ain`** (= APN, bare digits), ~98.9% coverage at seed. `build-data` fails the build loudly if coverage drops below 95% (stale cache / renamed field). See `docs/design/static-site.md` and `docs/design/charts-and-density.md`.

## Run Cadence

`MarClient` GETs the form once to seed an ASP.NET token chain, then reuses it by harvesting the fresh token triplet from each POST response — so it spends **one request per query** in steady state (re-seeding only if a token is rejected). Cadence is configurable: `MAR_MIN_DELAY_MS` (per-worker delay) and `MAR_WORKERS` (bounded concurrent sessions, each its own token chain). 429/503 → exponential back-off honoring `Retry-After`.

- Phase A (`sweep-streets`): 147 streets, single client, ~30–60s.
- Phase B (`drill-properties`): ~10,700 parcels. Seeded at `MAR_WORKERS=6 MAR_MIN_DELAY_MS=150` (~40 req/s) in **~4 min**, 0 throttles / 0 failures. Fits the GHA 6h cap with huge margin — **chunking and self-hosted runners are not needed.** Dial down (e.g. 4 workers / 200ms) for a gentler run.

## Operational Constraints to Respect

- **Be polite to the City's servers.** The MAR tool is a public service, not an API. `MarClient` identifies itself in the User-Agent, backs off on 429/503, and is rate-limited (default 5s for ad-hoc `probe-one`; sweeps default 150ms/6 workers ≈ 40 req/s). `robots.txt` explicitly `Allow`s `/departments/rentcontrol/mar.aspx` (the rest of the site is `Disallow: /`) and publishes **no** `Crawl-delay`, so automated access is sanctioned but uncapped — stay a good citizen and let the 429/503 back-off be the safety valve. Keep concurrency bounded (single-digit workers); do not fan out to many parallel jobs.
- **Parsers must fail loudly** on unexpected HTML rather than silently producing nulls, so a layout change surfaces in the next monthly run instead of corrupting history. The current parser tolerates absent grids (returns null) and unknown column headers (returns empty strings via `pickFirst`); tighten with a `zod` schema check the first time we see real layout drift, not before.
