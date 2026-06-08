# Design: parcel/unit enrichment — ADU vs SFR vs multifamily, legacy vs new

**Status:** proposed (roadmap) · **Scope:** build-time enrichment join over external
parcel/permit data · **Depends on:** the registry CSVs + the geometry crosswalk (shipped)

## Goal

Classify each parcel/unit more granularly than the MAR tool allows, so the
registry and map can break down the controlled stock by **use type** (rental
single-family home vs accessory/secondary unit vs small multi vs large
multifamily) and by **vintage** (pre-1979 legacy control vs post-1979 / new
construction). The motivating case: controlled units in the North-of-Montana R1
neighborhood are a *mix* of rented single-family houses and pre-1979 secondary
units (guest houses, garage/"½" units) — but the MAR data can't label which is
which, only let us *infer* it from unit labels, bedroom counts, and parcel
composition.

## Why the MAR data alone can't answer this

The City MAR lookup returns `Address, Unit, MAR, Tenancy Date, Bedrooms, Parcel`
— there is **no use code, year-built, or ADU flag**. Today we proxy "use" with
parcel unit-count (`size_class`: single / small / multifamily) and read tea
leaves from unit labels (`1/2`, `GH`, `REAR`). That's a heuristic, not a
determination. To *confirm* ADU vs SFR vs main-house we need an external join.

## Candidate sources + join keys

Ordered cheapest-first. All keyed on **APN/AIN** (bare digits), the same key the
geometry crosswalk already normalizes.

1. **City "Parcels Public" layer `usetype` / `usedescrip` — already in hand.**
   The FeatureServer we fetch for geometry
   (`Santa_Monica_public_parcels/FeatureServer/0`) also exposes `usetype` and
   `usedescrip` per parcel; `fetch-geometry` currently requests only `ain`.
   **First increment:** also pull these two fields, carry them onto each parcel,
   and surface a coarse use class (SFR / condo / 2–4 / 5+ / commercial-mixed).
   Near-zero cost — same request, same cache, ~99% coverage already proven.

2. **LA County Assessor parcel/improvement data** (LA County GIS / Assessor
   Portal). Gives **`YearBuilt`, units count, bedrooms/baths, use code, building
   count** per AIN → the **pre/post-1979 cut** (the rent-control eligibility
   line) and a real SFR-vs-multi determination. Join on AIN.

3. **City of Santa Monica building / ADU permits.** The authoritative ADU
   signal — explicitly flags permitted accessory units (and their vintage). Join
   on APN where available, else fuzzy-match on normalized address. Availability
   and format (open-data layer vs records request) needs confirming; treat as a
   stretch source behind (1) and (2).

## What it enables

- A real `use_class` + `vintage` per parcel/unit in `unit_categories.csv` and
  the per-APN site JSON → map filters/choropleth by use type, and detail-panel
  labels ("rented SFR" / "accessory unit (pre-1979)" / "new construction —
  exempt").
- Tighter **RCB reconciliation**: the report's excluded categories
  (rent-level-decontrolled SFR/condo, owner-occupied 2–3 unit) become
  *derivable* from year-built + use code instead of proxied by parcel size.
- A factual answer to "is this an ADU or a rental SFH?" per address.

## Approach (sketch)

- Build-time enrichment join (mirrors `fetch-geometry`): cache the external
  attributes per AIN as a committed artifact under `data/external/`, then a
  pure transform stamps `use_class`/`vintage` onto the derived tables.
- **Fail loud** on coverage (repo convention): if the AIN match rate or
  year-built fill drops below a threshold, abort rather than silently
  mislabel — same pattern as the geometry coverage QA.
- Keep raw external values alongside the derived class so the classification can
  be re-derived if the rules change (e.g. the 1979 base date, exemption logic).

## Open questions / risks

- **Address matching** for permit data is fuzzy (½-addresses, multi-frontage);
  prefer APN joins, fall back to normalized-address only with a confidence flag.
- **ADU legal nuance:** a *new* permitted ADU on an R1 parcel is new
  construction → exempt from the rent-control ceiling, so it won't carry a
  controlled MAR at all; the controlled "accessory" units we see are pre-1979
  stock. Vintage from the Assessor is what makes this rigorous.
- **External-source churn:** Assessor/permit schemas change; pin field names and
  re-validate on each refresh (these layers update rarely, so cache + occasional
  re-fetch, like the geometry).
