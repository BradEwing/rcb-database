# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Goal

Build a self-hosted registry of Santa Monica rent-controlled units by scraping the City's public Maximum Allowable Rent (MAR) lookup tool on a monthly schedule. The registry is the source of truth for tracking MAR changes over time (new tenancies, annual general adjustments, capital improvement pass-throughs, etc.) for every rent-controlled parcel in the city.

Status: scraper implemented and tested against fixtures; both long sweeps have been run end-to-end against the City's servers. The registry is seeded as of 2026-06-07: `streets.csv` (147), `parcels.csv` (10,714 address-rows / ~8,500 distinct APNs), `units.csv` + `mar_observations.csv` (35,419 units — 32,900 controlled, 2,519 exempt). Phase B runs as a bounded concurrent pool in ~4 min (see "Run cadence"). The ~19% overage vs the RCB report's 27,589 headline is **resolved** — it is definitional, not a scraper defect (see "Completeness / RCB reconciliation" under Core Design Problems and `docs/reconciliation-2025.md`). The monthly GitHub Action cron is wired up (`.github/workflows/monthly-snapshot.yml`) but has not yet run on schedule. Open: month-over-month diffing/attribution and the static site are not yet built.

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

## Core Design Problems

### 1. Enumerating the universe of rent-controlled parcels — design solved, registry seeded 2026-06-07

Implemented as the two-phase architecture above. As seeded 2026-06-07: 10,714 address-parcels → ~8,500 distinct APNs, 35,419 units (32,900 controlled + 2,519 exempt). After fixing the multi-address double-count (keying units by row `Address`, not the queried street), the controlled count sits **~19% above** the RCB 2025 Annual Report's 27,589 headline. Integrity is clean (0 duplicate `unit_id`s).

**Completeness / RCB reconciliation — resolved (see `docs/reconciliation-2025.md`).** The ~19% overage is **definitional, not a scraper defect.** The MAR lookup tool returns a row for every unit with an established MAR — a *superset* of the report's "controlled" definition, which excludes rent-level-decontrolled SFR/condos (1,865), owner-occupied 2–3 unit exemptions (1,106), and other use-exempt units (3,205) that can still carry a positive MAR. Scraper integrity was verified against raw HTML: the cross-address dedup is correct (confirmed double-counts ≈ 0), large APNs are real complexes, and the surplus is concentrated on 1–3 unit parcels (the SFD/condo/small-property exemption zone) and skewed to large units — exactly matching the report's excluded categories. The bridge closes to 27,589 against the report's own exclusion counts. **Do not "fix" this by mangling data.** Publish the registry total (32,900 positive-MAR) as a superset *and* the RCB-comparable estimate (~26,754 = controlled units on 4+ unit parcels, persisted as `rcb_comparable` by `npm run reconcile`). Re-run `npm run reconcile` each month and bump the `RCB_2025` figures in `scraper/src/analyze/reconcile.ts` per the latest Annual Report.

### 2. Monthly diffing and change attribution — open

Each monthly pull stores one `mar_observations.csv` row per (unit, date). Interesting signals:

- MAR increases on the annual GA effective date (typically September 1) → general adjustment.
- Mid-year jumps that don't match the GA → likely a new tenancy reset (a fresh `tenancy_date`) or a Board-approved adjustment.
- `$0` MAR appearing where there was a positive MAR → exemption / Ellis withdrawal; cross-check rentcontroldocs.santamonica.gov.
- Disappearance of a unit from `gvMarData` → possible demolition or full exemption.

Keep raw scraped values (`data/raw/` snapshots until they get too large, plus the verbatim CSV columns) alongside derived fields so attribution can be re-run if classification logic changes.

## Schema (`data/`)

- `streets.csv` — `street_name, first_swept_at`. Mirrors the published street list.
- `parcels.csv` — `parcel_id, street_number, street_name, apn, first_seen_at, last_drilled_at`. `parcel_id` is `slug("<street_number> <street_name>")` — the *address* found in the street sweep; several `parcel_id`s can map to one `apn`. `apn` + `last_drilled_at` are filled in Phase B; re-running Phase B the same day skips parcels already stamped `last_drilled_at == today` (idempotent/resumable).
- `units.csv` — `unit_id, apn, address, unit_label, bedrooms, first_seen_at`. A unit is keyed by the gvMarData row's OWN `address` + `unit_label`: `unit_id = slug("<address> <unit_label>")` (blank label → `slug("<address>")`). This de-duplicates the multi-address form behavior above while keeping genuinely distinct units (e.g. corner buildings with one unit per street number) apart. `apn` is the per-row LA County parcel.
- `mar_observations.csv` — `unit_id, observed_at, mar_amount_cents, tenancy_date`. Integer cents avoid float drift. Empty `tenancy_date` means the form returned `&nbsp;` (long-term tenancy, no recent reset). `mar_amount_cents=0` means exempt.

All tables are sorted by primary key and written deterministically so month-over-month `git diff` is meaningful. `data/raw/` (per-query HTML snapshots) is gitignored — re-fetchable from the CSVs.

`data/derived/` holds regenerable analysis artifacts (committed for diff history), produced by `npm run reconcile`: `unit_categories.csv` (`unit_id, apn, bedrooms, mar_status, parcel_unit_count, size_class, rcb_comparable`) classifies each unit by independently-derivable signals (MAR status + parcel size); `reconciliation_summary.csv` is the bridge-summary metrics. These are *derived*, never a source of truth — regenerate after each sweep.

## Hosting & Distribution

Target: **GitHub Pages**, with the registry data committed to the repo. Monthly job is a **GitHub Action on cron** that runs Phase B (and Phase A on a slower cadence — parcels rarely change), commits the new snapshot, and triggers a Pages rebuild. No always-on server.

The static site stays TS/Node — Astro or Vite + MapLibre GL JS + Observable Plot for the map / charts. Precompute aggregates at build time; lazy-load per-parcel history on demand.

## Run Cadence

`MarClient` GETs the form once to seed an ASP.NET token chain, then reuses it by harvesting the fresh token triplet from each POST response — so it spends **one request per query** in steady state (re-seeding only if a token is rejected). Cadence is configurable: `MAR_MIN_DELAY_MS` (per-worker delay) and `MAR_WORKERS` (bounded concurrent sessions, each its own token chain). 429/503 → exponential back-off honoring `Retry-After`.

- Phase A (`sweep-streets`): 147 streets, single client, ~30–60s.
- Phase B (`drill-properties`): ~10,700 parcels. Seeded at `MAR_WORKERS=6 MAR_MIN_DELAY_MS=150` (~40 req/s) in **~4 min**, 0 throttles / 0 failures. Fits the GHA 6h cap with huge margin — **chunking and self-hosted runners are not needed.** Dial down (e.g. 4 workers / 200ms) for a gentler run.

## Operational Constraints to Respect

- **Be polite to the City's servers.** The MAR tool is a public service, not an API. `MarClient` identifies itself in the User-Agent, backs off on 429/503, and is rate-limited (default 5s for ad-hoc `probe-one`; sweeps default 150ms/6 workers ≈ 40 req/s). `robots.txt` explicitly `Allow`s `/departments/rentcontrol/mar.aspx` (the rest of the site is `Disallow: /`) and publishes **no** `Crawl-delay`, so automated access is sanctioned but uncapped — stay a good citizen and let the 429/503 back-off be the safety valve. Keep concurrency bounded (single-digit workers); do not fan out to many parallel jobs.
- **Parsers must fail loudly** on unexpected HTML rather than silently producing nulls, so a layout change surfaces in the next monthly run instead of corrupting history. The current parser tolerates absent grids (returns null) and unknown column headers (returns empty strings via `pickFirst`); tighten with a `zod` schema check the first time we see real layout drift, not before.
