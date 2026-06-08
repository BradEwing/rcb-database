# Design: static site — parcel map with unit breakdown

**Status:** proposed · **Scope:** new GitHub Pages site (multi-PR) · **Depends on:** the registry CSVs + derived reports (shipped)

## Goal

A public, self-hosted map of Santa Monica's rent-controlled stock. The core
interaction: **pan/zoom a parcel map → click a parcel → see its unit breakdown**
(each unit's MAR, tenancy date, bedrooms, exempt status), plus the parcel's
recent rent-change history. No always-on server — GitHub Pages, all data
precomputed at build time, per-parcel detail lazy-loaded on click.

This is intentionally delivered as **several small PRs** (see Delivery), each
shippable on its own, so the site is live early and grows feature by feature.

## Constraints that shape the design

- **Static only.** GitHub Pages serves files; there is no backend, no query API,
  no server-side proxy. Anything dynamic happens at build time or in the browser.
- **No exposed secrets.** A static client can't hide an API key, so the basemap
  must work key-free (or with a domain-locked, free-tier key that's safe to ship).
- **Project Pages base path.** The site lives at
  `https://bradewing.github.io/rcb-database/`, so the build base is
  `/rcb-database/` — every asset/data URL must be base-relative, not root-relative.
- **Repo-size discipline.** Per [[data-layer-scaling-stance]] we don't bloat git.
  Site data artifacts are **build outputs** (generated in CI, deployed to Pages,
  **gitignored**). Only the geometry *input* is committed (it's an external
  source we cache, see Geometry).
- **Licensing/attribution.** Code MIT, data CC0 (per README). The map must
  attribute the basemap provider and the LA County / City of Santa Monica parcel
  geometry.

## The geographic key is the APN

A "parcel" on the map is a physical parcel = one **APN** (10-digit assessor
number, e.g. `4285027001`). Two grounding facts:

- The authoritative parcel universe is the **8,539 distinct APNs in
  `units.csv`** (each unit row self-identifies its own APN). `parcels.csv` is an
  *address* index — its `apn` column is only partially backfilled (6,961/10,714
  rows; 5,224 distinct) because a single address drill returns units spanning
  several APNs. **Build the map's parcel layer and the unit grouping from
  `units.csv.apn`, never from `parcels.csv`.**
- One APN has many addresses (corner lots, multi-frontage). The detail view
  lists all addresses for the APN; the map labels a representative one.

## Stack

TS/Node end-to-end, matching the rest of the repo (all decided):

- **Astro** for the site shell — static-first, ships zero JS by default, renders
  the interactive map as a single client island, and makes it cheap to add
  static `/about` (methodology) and summary pages later.
- **MapLibre GL JS** for rendering (vector, open-source, no token).
- **Observable Plot** for the small charts in the detail panel / summary (MAR
  history, bedroom mix).
- **Basemap:** CARTO Positron (free, key-free, attribution required) — no secret
  to manage on a static site.

Site lives in `site/` (its own `package.json`/workspace) so its deps don't mix
with the scraper's.

## Data pipeline (build time)

Two scripts; both pure transforms over the committed CSVs + cached geometry.

### 1. `fetch-geometry` (occasional, output committed)

Query the City's **Parcels Public** ArcGIS FeatureServer for parcel polygons,
keyed by APN/AIN, and cache the result as
`data/external/parcels-geometry.geojson` (committed — it's a stable external
input that changes rarely, not a per-build fetch). Trim to the fields we need
(APN + geometry) and optionally clip to the APNs we reference to keep it small.

- **Join field:** confirm the exact attribute name (`AIN` / `APN` / `apn`) and
  normalize both sides to bare digits before matching.
- **Coverage QA:** report matched vs unmatched APNs. Rent control is within city
  limits, so coverage should be near-complete; **fail the build loudly** (repo
  convention) if the match rate drops below a threshold. *Contingency:* fall back
  to LA County Assessor parcels for any gaps the City layer misses.

### 2. `build-data` (every build) → site data artifacts

Reads `units.csv`, `mar_observations.csv` (latest obs per unit = carry-forward,
via the existing `latestObservations` helper), the derived
`unit_categories.csv` / `mar_changes.csv` / `unit_exits.csv` /
`reconciliation_summary.csv` / `sweeps.csv`, plus the cached geometry. Emits into
`site/public/data/` (gitignored):

- **`parcels.geojson`** — one feature per APN, geometry simplified for the web.
  `properties` carry everything the choropleth + hover tooltip need *without* a
  detail fetch: `{ apn, label_address, unit_count, controlled_count,
  exempt_count, median_mar_cents, size_class, has_recent_change }`.
- **`parcels/<apn>.json`** — lazy-loaded on click. The full breakdown:
  ```jsonc
  {
    "apn": "4285027001",
    "addresses": ["1000 ASHLAND AVE", ...],
    "summary": { "unit_count": 4, "controlled": 3, "exempt": 1, "median_mar_cents": 299500 },
    "units": [
      { "unit_id": "...", "address": "...", "unit_label": "2", "bedrooms": "2",
        "mar_cents": 142100, "mar_status": "controlled", "tenancy_date": "2019-01-01" }
    ],
    "changes": [
      { "observed_at": "2026-06-07", "old_mar_cents": 131200, "new_mar_cents": 142100,
        "delta_cents": 10900, "reason": "mar_adjustment" }
    ],
    "exited": [ /* units gone from the latest sweep, if any */ ]
  }
  ```
- **`summary.json`** — citywide header stats: registry totals, RCB-comparable
  estimate, bedroom mix, latest sweep date (from `sweeps.csv`), change counts.
- **`meta.json`** — build timestamp, source data git SHA, geometry source date,
  unmatched-APN count. Surfaced in the site footer for provenance.

8,539 small per-APN files are fine for Pages (static file fetches). If that ever
becomes unwieldy, the fallback is a single keyed `units-by-apn.json` loaded once
— noted, not built now.

## UI

- **Map page (landing).** Full-bleed MapLibre map of all parcels, choropleth by a
  switchable metric (default **unit count**; toggles: **median MAR**, **recent
  change**). Hover → tooltip (address, unit count, median MAR). Legend. A summary
  header strip from `summary.json`. Search box (by address or APN) that flies to
  + selects a parcel.
- **Detail panel.** On parcel click, lazy-fetch `parcels/<apn>.json` and open a
  side panel: address list, per-unit table (label, BR, MAR, tenancy date,
  status), a small MAR-history chart, and any recent changes/exits. Deep-linkable
  via `#apn=<apn>` so a selected parcel is shareable.
- **Methodology/about page.** Short static page: what MAR is, the superset-vs-RCB
  caveat (link the reconciliation memo), data sources, update cadence, licenses.

## Deployment

A GitHub Actions workflow (`.github/workflows/pages.yml`): on push to `main`
that touches `site/**` or `data/**`, build the site (`build-data` then the
framework build) and deploy with `actions/deploy-pages`. The **monthly snapshot
workflow** triggers a Pages rebuild after it commits fresh data, so the map
tracks each monthly pull automatically. Enable Pages (Actions source) and set the
framework `base` to `/rcb-database/`.

## Delivery (multi-PR)

Each PR is independently shippable and reviewable:

1. **Scaffold + deploy.** `site/` app skeleton, Pages workflow, base path; deploys
   a placeholder. Proves hosting end-to-end early.
2. **Geometry crosswalk.** `fetch-geometry` + committed cache + APN-join coverage
   report. Data-engineering only, no UI; emits `parcels.geojson` + QA stats.
3. **Map renders parcels.** Basemap + all parcels as a choropleth by unit count;
   pan/zoom/hover/legend. No click-through yet.
4. **Click → unit breakdown.** The core ask: `build-data` per-APN JSON + the
   lazy-loaded detail panel with the per-unit table.
5. **Enrich detail + summary.** MAR-history chart, change list, exits; the
   citywide summary header; deep-linkable `#apn=`.
6. **Change/time layer.** Choropleth metric for recent changes (`mar_changes`),
   exit markers, and 2023→2026 context.
7. **Polish.** Metric switcher, address/APN search, mobile layout, methodology
   page, attribution/footer provenance.

## Risks

- **Geometry join coverage / field name.** Mitigated by the build-time coverage
  QA + loud-fail threshold + LA County fallback (PR2 de-risks the whole effort —
  do it before any UI work).
- **Basemap key constraint.** A static site can't hide a key; we use the
  key-free CARTO Positron style. If it's ever throttled, a domain-locked MapTiler
  free key is the fallback.
- **Payload size.** Simplify polygon geometry aggressively; if `parcels.geojson`
  is heavy, switch the parcel layer to PMTiles (single static file, range
  requests) — noted as the scale path, not built in v1.
- **Base-path bugs.** Project-Pages base trips up asset/data URLs; bake the base
  into a single config and use base-relative fetches everywhere.

## Decisions (locked 2026-06-07)

- **Framework:** Astro (static shell + MapLibre client island).
- **Basemap:** CARTO Positron (key-free).
- **v1 time scope:** current snapshot first; 2023→2026 + monthly change layer
  lands in PR6.

## Roadmap (planned)

- **Analytics charts + map unit-density view** — a citywide charts section
  (initial-MAR-by-tenancy-vintage scatter, median rent by bedroom count) and a
  spatial unit-density map layer. Build-time aggregates over the registry CSVs,
  rendered with the Observable Plot / MapLibre stack already shipped. Designed in
  [charts-and-density.md](./charts-and-density.md).

## Out of scope (later)

- Per-unit rent-history beyond what the registry holds (the tool only exposes
  current MAR; history starts at the 2023 dump + monthly sweeps).
- User accounts, saved searches, server-side search/filtering.
- GA-formula reconstruction (rejected — see [sparse-observations.md](./sparse-observations.md)).
- Use-type / vintage breakdowns (ADU vs rental SFR vs multifamily; legacy vs new
  construction) — needs an external parcel/permit cross-reference, tracked
  separately in [parcel-enrichment.md](./parcel-enrichment.md).

## Shipped after the initial PRs

- **City-limits boundary overlay (done).** Santa Monica's city boundary is drawn
  as an outline plus a soft dim of everything outside the limits, toggleable from
  the legend (default on). The single boundary polygon is fetched from the City's
  `Santa_Monica_city_boundary` ArcGIS FeatureServer and cached under
  `data/external/city-boundary.geojson` (committed, like the parcel geometry) by
  `npm run fetch-boundary`; `build-data` passes it through to
  `site/public/data/` and the map builds a "world minus the city ring" mask for
  the dim. It orients the ~45°-rotated street grid and distinguishes "inside the
  city, no controlled units here" from "outside the city." Unlike the parcel
  geometry the overlay is cosmetic, so a missing cache only warns — it never
  gates the build.
