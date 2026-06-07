# MAR registry snapshot — 2023-07-19

A one-time bulk export of the **entire** Santa Monica Maximum Allowable Rent
registry, published by the City on its CKAN open-data portal. This is the only
known historical bulk snapshot of the data that the live `mar.aspx` lookup tool
serves one-unit-at-a-time. It predates this project's own first sweep
(2026-06-07) by ~3 years, giving the registry a genuine second time-point.

**Committed, not gitignored** (unlike `data/raw/`): this artifact is *not*
reproducible — it exists only at the URL below and would be lost if the City
removes the dataset. `data/raw/` is re-fetchable from the live form; this is not.

## Provenance

- **Source:** City of Santa Monica Open Data (CKAN)
  - Dataset page: https://data.santamonica.gov/dataset/maximum-allowable-rents
  - API: `https://data.santamonica.gov/api/3/action/package_show?id=maximum-allowable-rents`
- **Dataset created / last modified:** 2023-07-19 (both; a static one-shot dump)
- **Downloaded:** 2026-06-07 (the three CSVs below, via the CKAN→S3 redirect)
- **License:** none stated on the dataset (City public record)
- **Snapshot date used for observations:** `2023-07-19`

The companion nightly Socrata mirror (`data.smgov.net`, id `7vmf-n89t`) was
*current-only* (no history) and was unreachable as of 2026-06-07 — likely
retired in the smgov.net → santamonica.gov migration. So this frozen 2023 dump
is the sole bulk historical source.

## Files & schema (verbatim, as published)

### `units.csv` — 36,244 rows
`parcel_no, UNIT_ID, MAR1, UNITMASTER_ADDRESS, UNITMASTER_UNIT_ID, BEDROOM, effectivedate`

| column | meaning | maps to registry |
|---|---|---|
| `parcel_no` | 10-digit LA County APN | `units.apn` |
| `UNIT_ID` | `<streetno>-<unit>` composite (not globally unique) | — |
| `MAR1` | Maximum Allowable Rent, **in dollars** | `mar_observations.mar_amount_cents` (×100) |
| `UNITMASTER_ADDRESS` | the unit's own address | `units.address` |
| `UNITMASTER_UNIT_ID` | the unit label (`1`, `A`, `1021`, …; blank for single-unit) | `units.unit_label` |
| `BEDROOM` | bedroom count | `units.bedrooms` |
| `effectivedate` | tenancy/MAR effective date, `M/D/YYYY h:mm:ss AM` | `mar_observations.tenancy_date` |

`MAR1 == 0` means exempt (same semantics as the live tool's `$0`).

### `sites.csv` — 13,820 rows
`PARCEL_NO, FULLSTNO, SITEMASTER_ADDRESS, ZIP, CITYAREA` — parcel-level index
(adds ZIP + a `CITYAREA` zone code the live form doesn't expose).

### `associatedaddresses.csv` — 5,764 rows
`siteaddress, SMAddress, FULLSTNO, UMAddress, Parcel` — the multi-address ↔
parcel crosswalk (the City's own resolution of the "one APN listed under several
street addresses" behavior documented in `CLAUDE.md`).

## Join to the registry

The registry keys a unit as `slug("<address> <unit_label>")`. The identical key
is reconstructable here as `slug(UNITMASTER_ADDRESS + " " + (UNITMASTER_UNIT_ID || "_"))`.
Validated against `data/units.csv` (2026-06-07): **35,303 units match** (99.7% of
the registry, 97.4% of the 2023 file), **0 key collisions**, 7 APN disagreements.

- **35,303** units present in both 2023 and 2026 → get a `2023-07-19` observation row.
- **941** units in 2023 but gone by 2026 (exemption / demolition / re-label / decontrol).
- **116** units new since 2023.

Regenerate the backfill (observations + diff) with:

```sh
npm run backfill:snapshot-2023
```
