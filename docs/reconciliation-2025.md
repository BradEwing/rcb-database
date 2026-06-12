# Reconciling the registry against the RCB 2025 Annual Report

The registry seeded on 2026-06-07 holds 32,900 positive-MAR units. The Rent
Control Board's 2025 Annual Report counts 27,589 controlled units as of
2025-12-31, a gap of 5,311 units (19.3%). The gap is definitional. The MAR
lookup tool returns a row for every unit with an established Maximum Allowable
Rent, and that universe is broader than the report's "controlled" count, which
excludes rent-level-decontrolled and exempt units even when they still carry a
positive MAR. Confirmed double-counts are effectively zero (next section), so
the registry total is a superset of the RCB count.

Reproduce with `npm run reconcile` (writes `data/derived/unit_categories.csv`
and `data/derived/reconciliation_summary.csv`).

## What the report counts

From the 2025 Annual Report, *Status of Controlled Rental Housing*:

- 27,589 controlled units as of 2025-12-31 (net −79 for the year).
- By size (Fig. 1): 0-BR 2,910 · 1-BR 12,945 · 2-BR 9,695 · 3(+)-BR 2,039.
- By type (Fig. 3): Market-Rate 21,103 · Long-Term 5,521 · Sec 8/HOME/Tax-Credit
  777 · $0-MAR 188. The 188 "$0 MAR" units (controlled, no registered rent) are
  included in the headline.

The report excludes these categories from the 27,589, and each can still carry
a positive MAR in the lookup tool:

| Category | Units | Source |
|---|---:|---|
| Rent-level decontrolled SFR/condo (Costa-Hawkins) | 1,865 | "not included in the count of controlled units" |
| Owner-occupied 2–3 unit exemptions | 1,106 | 456 properties exempt at year end |
| Other use exemptions | 3,205 | units (excl. owner-occupied) holding use exemptions |
| Permanently exempt single-family dwellings | 3,966 | 3,596 by declaration + 370 by owner-occupancy |

Permanently exempt SFDs generally have no registered rent. They show up as `$0`
or not at all, so they land in the 2,519-unit `$0-MAR` bucket or outside the
universe entirely rather than in the 32,900.

## Scraper integrity

The leading bug hypothesis was the multi-frontage / corner-lot double count:
the same APN and unit label listed under several addresses (1,364 candidate
rows). Checked against the cached raw HTML in `data/raw/`:

- Cross-address dedup is correct. For APN `4266013001`, all three frontage
  queries (`2704 Montana Ave`, `803`/`807 Princeton St`) return the same 12
  rows, each self-identifying with its own canonical address. That is a real
  12-unit building collapsed to 12 unique `unit_id`s.
- A fingerprint scan for the same `(apn, unit_label, MAR, tenancy_date)`
  appearing under multiple addresses found 8 suspects in 32,900 units. Spot
  checks against the raw HTML (e.g. `1231`/`1233 17th St`) showed distinct
  units that happen to share a rent and tenancy date.
- The largest APNs are real: the 532-unit APN is the Sea Colony complex
  (2700/2800 Neilson Way) and the 288-unit APN is the 1431 Ocean Ave high-rise.
- 0 duplicate `unit_id`s, 0 blank APNs.

## Where the overage lives

Splitting the 32,900 controlled units by their parcel's total unit count (a
single-family/condo proxy: a house or an individual condo is 1 unit per APN):

| Parcel size | Controlled units | Note |
|---|---:|---|
| single (1 unit) | 3,952 | SFD / condo proxy; 23% are 3+BR |
| small (2–3 units) | 2,194 | owner-occupied exemption zone |
| multifamily (4+ units) | 26,754 | within −3.0% of the report |

The excess sits on 1–3 unit parcels (6,146 units), where the report says
exemptions concentrate. It also skews to large units: the controlled 3+BR count
runs 52% over the report (houses and large condos), versus 14–19% for 1- and
2-BR.

## The bridge

Comparing like-for-like (the report's positive-MAR controlled portion is
27,589 − 188 $0-MAR = 27,401):

```
 32,900  registry positive-MAR units
 −1,865  rent-level decontrolled SFR/condo (report-excluded)        [report figure]
 −1,106  owner-occupied 2–3 unit exemptions (report-excluded)       [report figure]
 −2,528  other use-exempt units retaining a positive MAR            [balancing item]
 ───────                                                            (79% of the 3,205 reported)
 27,401  ≈ report positive-MAR controlled (27,589 − 188 $0-MAR)
   +188  $0-MAR units the report counts as controlled               [report figure]
 ───────
 27,589  = RCB 2025-12-31 headline ✓
```

The 1,865 and 1,106 lines are exact report figures for categories that retain
an established MAR. The −2,528 line is a balancing item; the lookup tool does
not expose exemption status, so that category cannot be measured per unit. It
passes two sanity checks. It consumes 79% of the report's 3,205 use-exempt
units, leaving ~21% to show as `$0`. And it squares with the small-parcel
surplus above: of the 6,146 units on 1–3 unit parcels, ~647 remain genuinely
controlled, matching the ~835 gap between the multifamily estimate and the
headline.

## Which number to publish

Publish both. The registry universe is 32,900 positive-MAR units (plus 2,519 at
`$0`): what the City's tool exposes and what month-over-month diffing tracks,
and a superset of the RCB "controlled" definition. The RCB-comparable count is
~26,754, the positive-MAR units on 4+ unit parcels, persisted as
`rcb_comparable=1` in `data/derived/unit_categories.csv`. That proxy tracks the
headline within ~3% and under-counts slightly, since the report counts ~647
small-parcel units as controlled.

Do not report 32,900 as "controlled units" without qualification; it would
overstate the RCB headline by 19%. The two numbers bracket the true figure:
26,754 ≤ 27,589 ≤ 32,900.

## Open items

- Exemption status is not in the tool output. If exact per-unit reconciliation
  is ever needed, cross-walk APNs against the City/County assessor (use code,
  property type) or the rent control fee-waiver roster (1,865 SFD/condo
  waivers, 1,817 owner-occupied; Fig. 5).
- Re-run `npm run reconcile` after each monthly sweep, and update `RCB_2025` in
  `scraper/src/analyze/reconcile.ts` with each new Annual Report's figures.
- 115 controlled mobile-home-park spaces are tracked separately by the Board
  and are not expected in the lookup tool; immaterial to the bridge.
