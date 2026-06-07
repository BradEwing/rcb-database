# Reconciling the registry against the RCB 2025 Annual Report

**Question.** The seeded registry (2026-06-07) holds **32,900 positive-MAR units**,
while the Santa Monica Rent Control Board's **2025 Annual Report** headlines
**27,589 controlled units as of 2025-12-31** — a **+5,311 (+19.3%)** overage. Is
this a scraper bug or a definition mismatch?

**Answer.** It is **definitional, not a scraper defect.** The MAR lookup tool
returns a row for every unit with an established Maximum Allowable Rent — a
universe broader than the report's "controlled" count, which excludes units that
are rent-level decontrolled or exempt. Scraper integrity is clean: confirmed
double-counts are effectively zero. The registry's positive-MAR total should be
understood as a **superset** of the RCB "controlled" definition.

Reproduce with `npm run reconcile` (writes `data/derived/unit_categories.csv` and
`data/derived/reconciliation_summary.csv`).

## What the report counts

From the 2025 Annual Report, *Status of Controlled Rental Housing*:

- **27,589 controlled units** as of 2025-12-31 (net −79 for the year).
- By size (Fig. 1): 0-BR **2,910** · 1-BR **12,945** · 2-BR **9,695** · 3(+)-BR **2,039**.
- By type (Fig. 3): Market-Rate **21,103** · Long-Term **5,521** · Sec 8/HOME/Tax-Credit **777** · **$0-MAR 188**. The report **includes** 188 "$0 MAR" units (controlled but no registered rent) in the headline.

Explicitly **excluded** from the 27,589 (the over-count candidates, since these
can still carry a positive MAR in the lookup tool):

| Category | Units | Source |
|---|---:|---|
| Rent-level decontrolled SFR/condo (Costa-Hawkins) | 1,865 | "not included in the count of controlled units" |
| Owner-occupied 2–3 unit exemptions | 1,106 | 456 properties exempt at year end |
| Other use exemptions | 3,205 | units (excl. owner-occupied) holding use exemptions |
| Permanently exempt single-family dwellings | 3,966 | 3,596 by declaration + 370 by owner-occupancy |

Permanently exempt SFDs (3,966) generally have **no registered rent** → they
appear as `$0` or not at all, so they land in our 2,519 `$0-MAR` bucket or
outside the universe, **not** in the 32,900.

## Scraper integrity: verified clean

The leading bug hypothesis was the multi-frontage / corner-lot double count
(same APN + unit label under several addresses — 1,364 candidate rows). Checked
against the cached raw HTML (`data/raw/`):

- **Cross-address dedup is correct.** For APN `4266013001`, all three frontage
  queries (`2704 Montana Ave`, `803`/`807 Princeton St`) return the *identical*
  12 rows, each self-identifying with its own canonical address, with distinct
  MARs / tenancy dates / bedrooms — a real 12-unit building, collapsed to 12
  unique `unit_id`s. The CLAUDE.md canonical-address assumption holds.
- **True duplicates ≈ 0.** A fingerprint scan for the same
  `(apn, unit_label, MAR, tenancy_date)` across multiple addresses found only
  **8** suspects across all 32,900 units; spot-checking them against raw HTML
  (e.g. `1231`/`1233 17TH ST`) showed they are *distinct* units that merely
  share a rent and tenancy date — not double-counts.
- **Large APNs are real.** The 532-unit APN is the 2700/2800 Neilson Way Sea
  Colony complex (532 distinctly-labeled units); the 288-unit APN is the
  1431 Ocean Ave high-rise. No parse artifacts.
- `unit_id` integrity: 0 duplicates, 0 blank APNs.

No data was mutated. There is no scraper bug to fix.

## Where the overage lives

Splitting the 32,900 controlled units by their parcel's total unit count (the
single-family/condo proxy — a house or individual condo is 1 unit per APN):

| Parcel size | Controlled units | Note |
|---|---:|---|
| single (1 unit) | 3,952 | SFD / condo proxy; 23% are 3+BR |
| small (2–3 units) | 2,194 | owner-occupied exemption zone |
| **multifamily (4+ units)** | **26,754** | tracks the report within −3.0% |

The entire excess sits on **1–3 unit parcels** (6,146 units), precisely where the
report says exemptions concentrate, and skews to large units — the controlled
**3+BR** count runs **+52%** over the report (houses and large condos), versus
~14–19% for 1- and 2-BR. The multifamily core (26,754) lands within 3% of the
27,589 headline. Both fingerprints point to the same conclusion: the surplus is
exempt/decontrolled small-parcel housing the report does not count.

## The bridge

Comparing like-for-like (the report's positive-MAR controlled portion is
27,589 − 188 $0-MAR = **27,401**):

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

**Confidence.** The 1,865 and 1,106 lines are exact report figures for
categories that retain an established MAR. The **−2,528** "other use-exempt" line
is a **balancing item**, not an independent per-unit measurement — the lookup
tool does not expose exemption status, so we cannot label each unit. It is
bounded and plausible: it consumes 79% of the report's 3,205 use-exempt units
(the remaining ~21% would show `$0`), and it is consistent with the independently
measured small-parcel surplus (6,146 units on 1–3 unit parcels, of which ~647
remain genuinely controlled — matching the ~835 gap between the multifamily
estimate and the headline). The robust, independently verified facts are: (1)
scraper over-count ≈ 0; (2) the surplus is concentrated on small parcels and
skews large; (3) the totals reconcile against the report's own exclusion counts.

## Recommendation: which number to publish

Publish **both**, with the definitional note:

- **Registry universe — 32,900 positive-MAR units** (+ 2,519 `$0-MAR`). This is
  what the City's tool exposes and what month-over-month diffing tracks. It is a
  *superset* of the RCB "controlled" definition.
- **RCB-comparable controlled — ~26,754** (positive-MAR units on 4+ unit
  parcels; persisted as `rcb_comparable=1` in `data/derived/unit_categories.csv`).
  A documented proxy that tracks the published headline within ~3% (a slight
  under-count, since the report counts ~647 small-parcel units as controlled).

Do **not** report 32,900 as "controlled units" unqualified — it would overstate
the RCB headline by ~19%. The `rcb_comparable` flag is a proxy with ~3% error,
not a per-unit exemption determination; treat the two numbers as bracketing the
true figure (26,754 ≤ 27,589 ≤ 32,900).

## Open / future

- Exemption status is not in the tool output. If exact per-unit reconciliation is
  ever needed, cross-walk APNs against the City/County assessor (use code,
  property type) or the rent control fee-waiver roster (1,865 SFD/condo waivers,
  1,817 owner-occupied — Fig. 5) to label decontrolled/exempt units directly.
- Re-run `npm run reconcile` after each monthly sweep; update `RCB_2025` in
  `scraper/src/analyze/reconcile.ts` with each new Annual Report's figures and
  add a dated constant so the bridge stays current.
- 115 controlled mobile-home-park spaces are tracked separately by the Board and
  are not expected in the lookup tool; immaterial to the bridge.
