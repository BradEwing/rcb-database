# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Goal

Build a self-hosted registry of Santa Monica rent-controlled units by scraping the City's public Maximum Allowable Rent (MAR) lookup tool on a monthly schedule. The registry is the source of truth for tracking MAR changes over time (new tenancies, annual general adjustments, capital improvement pass-throughs, etc.) for every rent-controlled parcel in the city.

Status: scraper implemented and tested against captured fixtures; `data/streets.csv` is populated (147 streets). The two long sweeps (street index → property drill-down) have not yet been run end-to-end against the city's servers — that's an operational decision, not code work. See "Run cadence" below.

## Stack

TS/Node only, end-to-end (Node 24 LTS). Chosen over Python+TS and Go-only to keep one language across scraper, build-time aggregates, and the eventual static site / map / viz layer on GitHub Pages.

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
- `drill-properties` (Phase B) — for each parcel without an observation today, POST number+street to get units and MAR; append to `data/units.csv` and `data/mar_observations.csv`; backfill APN on `data/parcels.csv`. Idempotent — re-running on the same day skips parcels already drilled.

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

Other observed behaviors:

- The `gvAddresses` anchor links (`?number=N&street=NAME`) are plain GET URLs that only **pre-fill** the form. A drill-down still requires a POST with the form-token triplet — the GET alone returns the empty form.
- `$0` MAR means the unit is currently exempt (Costa-Hawkins vacancy decontrol, Ellis-withdrawn, post-1978 exempt, etc.).
- Some addresses come back from `gvAddresses` but return zero `gvMarData` rows (e.g. 2615 / 2703 Colorado Ave). Record them in `parcels.csv` regardless — "in the index but currently no controlled units" is itself a tracked signal.
- The published street-name list is the universe of streets with at least one controlled unit (147 entries today). Commercial corridors like Wilshire are deliberately absent — do not assume it's a list of all Santa Monica streets.

## Core Design Problems

### 1. Enumerating the universe of rent-controlled parcels — design solved, sweeps unrun

Implemented as the two-phase architecture above. Completeness check: total `units.csv` rows should land within ~5% of 27,589 (RCB 2025 Annual Report); `parcels.csv` within ~10% of ~7,000.

### 2. Monthly diffing and change attribution — open

Each monthly pull stores one `mar_observations.csv` row per (unit, date). Interesting signals:

- MAR increases on the annual GA effective date (typically September 1) → general adjustment.
- Mid-year jumps that don't match the GA → likely a new tenancy reset (a fresh `tenancy_date`) or a Board-approved adjustment.
- `$0` MAR appearing where there was a positive MAR → exemption / Ellis withdrawal; cross-check rentcontroldocs.santamonica.gov.
- Disappearance of a unit from `gvMarData` → possible demolition or full exemption.

Keep raw scraped values (`data/raw/` snapshots until they get too large, plus the verbatim CSV columns) alongside derived fields so attribution can be re-run if classification logic changes.

## Schema (`data/`)

- `streets.csv` — `street_name, first_swept_at`. Mirrors the published street list.
- `parcels.csv` — `parcel_id, street_number, street_name, apn, first_seen_at`. `parcel_id` is `slug("<street_number> <street_name>")`. `apn` is empty until Phase B fills it.
- `units.csv` — `unit_id, parcel_id, unit_label, bedrooms, first_seen_at`. `unit_id` is `slug("<parcel_id> <unit_label>")`.
- `mar_observations.csv` — `unit_id, observed_at, mar_amount_cents, tenancy_date`. Integer cents avoid float drift. Empty `tenancy_date` means the form returned `&nbsp;` (long-term tenancy, no recent reset). `mar_amount_cents=0` means exempt.

All tables are sorted by primary key and written deterministically so month-over-month `git diff` is meaningful. `data/raw/` (per-query HTML snapshots) is gitignored — re-fetchable from the CSVs.

## Hosting & Distribution

Target: **GitHub Pages**, with the registry data committed to the repo. Monthly job is a **GitHub Action on cron** that runs Phase B (and Phase A on a slower cadence — parcels rarely change), commits the new snapshot, and triggers a Pages rebuild. No always-on server.

The static site stays TS/Node — Astro or Vite + MapLibre GL JS + Observable Plot for the map / charts. Precompute aggregates at build time; lazy-load per-parcel history on demand.

## Run Cadence

- Phase A: ~147 POSTs @ 5s rate limit ≈ 12 min. Only when `streets.csv` stales, maybe once a quarter.
- Phase B: ~7,000 POSTs @ 5s rate limit ≈ 10 hours. **Too long for a default GHA job (6h cap).** Options to decide before wiring the cron:
  - Drop rate limit to ~2s (~4 hours) — likely still polite for a once-monthly scrape.
  - Chunk by street and run multiple GHA jobs in parallel.
  - Use a self-hosted runner.

## Operational Constraints to Respect

- **Be polite to the City's servers.** The MAR tool is a public service, not an API. `MarClient` identifies itself in the User-Agent and rate-limits to 5s by default. A monthly pass does not need to be fast.
- **Parsers must fail loudly** on unexpected HTML rather than silently producing nulls, so a layout change surfaces in the next monthly run instead of corrupting history. The current parser tolerates absent grids (returns null) and unknown column headers (returns empty strings via `pickFirst`); tighten with a `zod` schema check the first time we see real layout drift, not before.
