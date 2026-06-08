# Design: analytics charts + map unit-density view

**Status:** partially shipped · **Scope:** new site charts section + one map
layer · **Depends on:** the registry CSVs (shipped) + the static site (shipped)

**Progress:** #1 (tenancy-vintage scatter) and #2 (rent by bedroom) are
**shipped** — see each section's "Shipped" note below. #3 (map density) remains
planned.

## Goal

Move beyond the per-parcel map into **citywide analytics** — a charts section
that reads the registry as a dataset, plus a spatial **density** view of the
controlled stock. Three deliverables, each shippable on its own:

1. **Initial MAR by tenancy start date** — a scatter of allowed rent against the
   month-year a tenancy began (the Costa-Hawkins "rent by vintage" story). *(shipped)*
2. **Average / median MAR by bedroom count** — what a controlled 0/1/2/3+ BR unit
   rents for. *(shipped)*
3. **Map density view** — unit count rendered as a heat/density layer, not just
   the existing per-parcel choropleth. *(planned)*

All three are build-time aggregates over the source CSVs (no backend), rendered
with the chart stack the site already ships (**Observable Plot**, used today for
the per-parcel MAR-history chart) and MapLibre.

## 1. Initial MAR by tenancy start date (month-year)

Inspired by the move-in-date rent scatters in housing data journalism (e.g.
Berkeleyside's 2023 Berkeley affordable-housing coverage,
<https://www.berkeleyside.org/2023/10/23/berkeley-affordable-housing-construction>).

### Shipped

A third section on the **`/charts`** page — **"Allowed rent by tenancy
vintage"** — renders the rent-by-vintage story as **small multiples, one facet
per bedroom bucket** (Studio / 1 / 2 / 3+ BR). Each facet overlays a
downsampled raw scatter underlay, a 25th–75th-percentile **band**, and the
**median line** over **quarterly** tenancy-vintage bins. Fed by a new
`mar_by_tenancy_vintage` aggregate in `analytics.json` (`buildMarByTenancyVintage`
in `build-data.ts`; types in `types.ts`; `marByTenancyVintageChart` in
`chart.ts`).

Design decisions made during the build:

- **Overplotting (the main risk).** Of 32,900 controlled units, **21,981 carry a
  tenancy_date** (the plottable points); the other **10,919 have an empty
  tenancy_date** (long-term tenancy, `&nbsp;` — no reset, no x) and are
  **excluded and counted** in the chart note. Rather than ship a 22k-point raw
  scatter, the primary view is **pre-binned quarterly** (median + IQR per
  bedroom). Quarterly over monthly because the 1999–2010 years are sparse
  per-bucket and monthly medians there would be n=1 noise. A **deterministic
  stride-downsampled** scatter (≤1,500 points/bucket → ~5.4k total, logged)
  underlays the bins so it still reads as a genuine scatter without bloat.
  `analytics.json` lands at ~0.55 MB (vs the multi-MB parcels.geojson).
- **tenancy_date is day-granular, not month-granular** as earlier docs assumed
  (e.g. `2024-07-24`) — truncated to its month before quarter-binning.
- **Y-axis clamp.** p99 MAR is ~$9.4k but a handful of large units reach ~$45k;
  the axis is clamped to **$10k** (`axis_cap_cents`, surfaced in the note) so the
  cloud stays legible. The clamp is a *display* bound only — no data is dropped
  from the medians/IQR.
- **Honest-data framing (on the chart note).** The y-value is the **current** MAR
  — the rent set at tenancy start **plus every General Adjustment since** — not
  the literal move-in rent (observations begin at the 2023 seed). The axis is
  labelled "allowed rent — current MAR" and the section titled "by tenancy
  *vintage*," consistent with the no-GA-formula stance.

- **Plot:** one point per controlled unit — **x = `tenancy_date`** (already
  month-granular, `YYYY-MM-01`), **y = MAR** (current carry-forward value, dollars).
  A strip/scatter with light alpha (32k+ points → bin or sample; consider a 2-D
  density/hexbin or monthly box-and-whisker overlay so the trend reads through
  the overplotting).
- **Story:** rent-controlled MAR tracks the tenancy reset — units whose current
  tenancy began recently sit near market (vacancy decontrol), long tenancies sit
  far below. The cloud should slope up toward recent dates.
- **Controls:** filter/facet by **bedroom count** (`units.csv.bedrooms`, bucketed
  0/1/2/3+ to match the reconcile grouping) and optionally hide `$0` exempt units.
- **Honest-data caveat (do not paper over):** the y-value is the *current* MAR,
  i.e. the rent set at tenancy start **plus every General Adjustment since** — not
  the literal initial rent. Our observations only begin at the 2023 seed, so the
  true move-in MAR for a pre-2023 tenancy isn't recoverable. `tenancy_date` is the
  faithful reset date, so frame the axis as "allowed rent by tenancy vintage,"
  and label the caveat on the chart. (Consistent with the project's no-GA-formula
  stance — see [sparse-observations.md](./sparse-observations.md).)

## 2. Average / median MAR by bedroom count

- **Plot:** bar chart, **x = bedroom bucket** (0, 1, 2, 3+), **y = median MAR**
  (prefer median over mean — rents are right-skewed; show both if cheap). Error
  bars or an IQR band convey spread; annotate each bar with the unit count.
- **Data:** controlled units only (`mar_amount_cents > 0`), grouped by
  `bedrooms`. Reuse `bedroomBucket()` / `median()` from
  `site/scripts/lib/registry.ts`; the citywide `bedroom_mix` already lands in
  `summary.json`, so this is the same group-by with a MAR aggregate added.
- **Optional cut:** by `size_class` (single / small / multifamily) to show the
  SFR-vs-apartment rent gap. *(not yet built)*

### Shipped

A **`/charts`** page (`site/src/pages/charts.astro`, linked from the map header
nav) renders two complementary views, both fed by a new build-time
**`analytics.json`** (`buildAnalytics` in `build-data.ts`; types in
`site/src/lib/types.ts`; chart helpers in `site/src/lib/chart.ts`):

- **Median MAR by bedroom, over time** — the primary chart: one line per bucket,
  a point at each registry snapshot. Built from `buildRentOverTime`, which
  reconstructs every unit's MAR **as-of** each distinct `observed_at` date by
  carry-forward over the event-sourced log, then takes the per-bucket median.
  Currently two points (the 2023 baseline + the 2026 sweep); **the series deepens
  by one point per monthly sweep** with no further work — the registry's whole
  reason for existing. Honest framing on the chart note (history is shallow today).
- **Current median by bedroom count** — the latest snapshot as a bar per bucket
  with a 25th–75th-percentile whisker for spread, plus a value label and a
  summary table of median + unit count.

Both are **controlled units only** (`mar_amount_cents > 0`); exempt `$0` units are
excluded so they can't drag medians to zero. Added a linear-interpolated
`percentile()` helper for the IQR. Median chosen over mean (right-skewed rents);
the per-bucket `mean_cents` is persisted in `analytics.json` too but not yet
plotted. Charts render via Observable Plot (theme-aware via `currentColor`) and
re-render on resize.

## 3. Map density view (units)

The map already has a **"Units per parcel"** choropleth (`unit_count` stepped
fill). "Density" adds a *spatial* read that a parcel-keyed choropleth can't give
— where controlled units concentrate regardless of parcel boundaries.

- **Layer:** a MapLibre **heatmap** weighted by per-parcel `unit_count`, sourced
  from parcel centroids (we already compute `bboxCentroid` in `build-data.ts` for
  exit markers — emit a `unit-density.geojson` of `{lng,lat,unit_count}` points,
  or reuse parcel centroids client-side). Heatmap intensity ramps with
  unit_count; fades out on zoom-in to hand off to the parcel fill.
- **Alternative / complement:** graduated proportional circles at centroids
  (radius ∝ √unit_count) — more legible than a heatmap for discrete buildings,
  and clickable straight through to the existing detail panel.
- **Wiring:** add as a new entry in the metric switcher (or a separate layer
  toggle in the legend's map-settings group, alongside "City limits" / "Place
  labels"). Build the points in `build-data.ts`; no new external data needed.

## Where it lives

- Charts 1–2: a new static page (e.g. `/charts` or fold into `/about`'s
  methodology), an Astro route with Plot islands fed by a small build-time
  artifact (e.g. `analytics.json`: the tenancy-vs-MAR points already exist in the
  observation log; the bedroom aggregate is tiny). Keep the points artifact lean
  — bin server-side if the raw 32k-point scatter is too heavy to ship.
- Density: a map layer, no new page.

## Open questions / risks

- **Overplotting at 32k points** — decide bin vs sample vs density surface before
  committing to a raw scatter; a monthly aggregate (median + IQR per month) may
  tell the story better and ship ~100× smaller.
- **Artifact size** — the scatter is the one artifact that could bloat the
  gitignored build output; measure and prefer a pre-binned form.
- **Exempt units** — `$0` MARs must be excluded from rent aggregates (they'd drag
  medians to zero); keep them as a separate count, not a data point.
- **Centroid accuracy** — `bboxCentroid` is a bbox midpoint, fine for a density
  heat surface; if proportional circles look off on L-shaped parcels, switch to a
  true polygon centroid.
