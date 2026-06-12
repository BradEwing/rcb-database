# Reconciling the registry against the RCB 2025 Annual Report

The registry seeded on 2026-06-07 holds 32,900 positive-MAR units, plus 2,519
units listed at `$0`. The Rent Control Board's 2025 Annual Report counts
27,589 controlled units as of 2025-12-31, a gap of 5,311 units (19.3%). The
gap is definitional. The MAR lookup tool returns a row for every unit with an
established Maximum Allowable Rent, and that universe is broader than the
report's "controlled" count, which excludes rent-level-decontrolled and exempt
units even when they still carry a positive MAR. Double-counting was audited
against the cached raw HTML in `data/raw/` and is effectively zero, so the
overage is not an artifact of double-counting.

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

Permanently exempt SFDs generally have no registered rent. They show up as
`$0` or not at all, so they land in the registry's 2,519-unit `$0` bucket
(too small to hold all 3,966, so most fall outside the universe entirely)
rather than in the 32,900. The registry's `$0` bucket and the report's 188
controlled "$0 MAR" units share a label but are different populations.

## Where the overage lives

Splitting the 32,900 positive-MAR units by their parcel's total unit count (a
single-family/condo proxy: a house or an individual condo is 1 unit per APN):

| Parcel size | Positive-MAR units | Note |
|---|---:|---|
| single (1 unit) | 3,952 | SFD / condo proxy; 23% are 3+BR |
| small (2–3 units) | 2,194 | owner-occupied exemption zone |
| multifamily (4+ units) | 26,754 | within −3.0% of the report |

This is consistent with the excess sitting on 1–3 unit parcels (6,146 units):
the decontrolled SFR/condo and owner-occupied exemption categories live on
1–3 unit parcels by definition. The overage also skews to large units, the
other fingerprint of houses and condos: the registry's 3+BR count runs 52%
over the report, versus 14% and 19% for 1- and 2-BR.

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
 27,589  = RCB 2025-12-31 headline (balances by construction)
```

The 1,865 and 1,106 lines are exact report figures for categories that retain
an established MAR. The −2,528 line is a balancing item: the lookup tool does
not expose exemption status, so that category cannot be measured per unit, and
the bridge closes by construction. The residual is plausible, though. Nothing
forced it to land between 0 and the report's 3,205 use-exempt units; it
consumes 79% of them, leaving ~21% to show as `$0`. The small-parcel
arithmetic is also internally consistent: if the excluded categories all sit
on 1–3 unit parcels (the first two do by definition; the use-exempt units are
assumed to), ~647 of the 6,146 remain genuinely controlled, and those 647 plus
the 188 $0-MAR controlled units equal 835, exactly the gap between the
multifamily estimate and the headline. Both are consistency checks. The
independent evidence is the multifamily slice landing within 3% of the
headline and the 3+BR skew above.

## Which number to publish

Publish both. The registry universe is 32,900 positive-MAR units (plus 2,519
at `$0`): what the City's tool exposes and what month-over-month diffing
tracks. The RCB-comparable count is persisted as `rcb_comparable=1` in
`data/derived/unit_categories.csv`. At the seed it was a parcel-size proxy
(positive-MAR units on 4+ unit parcels, 26,754, within 3.0% of the headline);
it has since been refined to an assessor use-class rule (positive-MAR units on
parcels the assessor does not class as single, two, or three-unit residential,
with the size proxy as fallback for unmatched APNs), giving 26,558 as of the
2026-06-11 sweep, within 3.7%. The proxy under-counts because the report
counts some small-parcel units (the ~647 above) and the 188 $0-MAR units as
controlled.

Do not report 32,900 as "controlled units" without qualification; it would
overstate the RCB headline by 19%. At this snapshot the two numbers straddle
the headline: 26,558 ≤ 27,589 ≤ 32,900. Nothing guarantees that ordering;
re-check it after each sweep.

## Open items

- Exemption status is not in the tool output. If exact per-unit reconciliation
  is ever needed, cross-walk APNs against the City/County assessor (use code,
  property type) or the rent control fee-waiver roster (1,865 SFD/condo
  waivers, 1,817 owner-occupied; Fig. 5).
- Re-run `npm run reconcile` after each monthly sweep, and update `RCB_2025` in
  `scraper/src/analyze/reconcile.ts` with each new Annual Report's figures.
- 115 controlled mobile-home-park spaces are tracked separately by the Board
  and are not expected in the lookup tool; immaterial to the bridge.
