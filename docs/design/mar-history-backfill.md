# Design: deep MAR-history backfill from rentcontroldocs (OnBase portal)

**Status:** spike complete — **GO** (feasible; gated next step is a small, polite
crawler with OCR) · **Scope:** one-time + incremental backfill of pre-2023 per-unit
MAR history from the Rent Control document portal · **Proven on:** 854 9th St, APN
`4281032011` (10 units)

## TL;DR

The portal is the correct (and only) source for pre-2023 MAR history, and the spike
**closed the make-or-break question with a 10/10 match against our registry anchors.**

- The portal is **Hyland OnBase Public Access (OBPA)**, not Laserfiche. It exposes an
  **anonymous JSON REST API** — no scraping of ASP.NET ViewState needed.
- **One parcel search returns every document for that parcel across all years in a
  single request.** The feared "~8,500 APNs × ~20 years ≈ 170k searches" is wrong: it's
  **~8,500 searches total**, plus targeted PDF downloads only for the doc types we want.
- There is a **golden document type — `MAR REPORT / ANNUAL MAR REPORT`** — a yearly,
  per-unit table listing, for every unit on the parcel: the **tenancy-start date
  ("Market Rate Established"), the prior/adjusted MAR, that year's GA, and the new MAR.**
  For 854 9th St there are **13 of them, one per year 2013–2025.**
- Documents are **scanned image PDFs with no text layer → OCR is required.** But they are
  crisp, machine-generated reports with a rigid table template, so OCR accuracy will be
  high (this is not handwriting). Metadata (doc type + year) lets us filter *before*
  downloading, so OCR volume is bounded to the golden docs.
- **Validation:** the 2023 Annual MAR Report's per-unit table matched **all 10 units** of
  854 9th St exactly — both the MAR and the Market Rate Established date — against our
  `2023-07-19` registry anchors (incl. unit 6's blank/long-term tenancy). See evidence
  below.

**Recommendation: GO**, behind a separate, rate-limited crawler PR. Risk is concentrated
in OCR quality and WAF tolerance at scale, not in access or data availability.

## Evidence artifacts (committed)

`data/external/mar-history-spike/`:
- `parcel-4281032011-customquery-125.json` — raw API response: the 68-document list for
  the target parcel.
- `annual-mar-report-2023-handle1410032.pdf` — the fetched 2023 Annual MAR Report (2pp,
  image-only).
- `annual-mar-report-2023-page2.png` — page 2 rendered to PNG: the per-unit MAR table
  used for the anchor validation.

## Portal architecture (as discovered)

Base host `https://rentcontroldocs.santamonica.gov`. The user-facing page at `/PAVPortal/`
is an ASP.NET WebForms shell whose only job is to collect inputs and load an `<iframe>`.
The real work is an **OnBase Public Access (OBPA)** Angular app under `/Client24/`, which
talks to an OnBase REST API.

- **WAF:** the host sits behind **Imperva/Incapsula** (injected `_Incapsula_Resource`
  script). It did **not** challenge any plain request during the spike — every call below
  returned `200` with a custom `User-Agent` and no JS execution.
- **robots.txt:** none. `GET /robots.txt` returns the IIS 404 page, so there are no
  published crawl rules. (The portal is an intentionally public service; honor the repo's
  politeness convention regardless — see "Operational plan".)
- **Date range:** content is **2005–present** (older only at City Hall). The form's year
  dropdown lists folders 1979→2041, but document availability starts ~2005.
- **Result cap:** the UI documents a 2,000-record limit per search; our `QueryLimit:0`
  (= no limit) call returned all 68 with `Truncated:false`. No parcel will approach 2,000.

### The REST API (anonymous, JSON)

Config at `…/Client24/!samples/sample-cq/obpa-config.json` sets `api.url = "../../api"`,
i.e. base **`https://rentcontroldocs.santamonica.gov/Client24/api`**.

1. **List custom queries** — `GET /api/CustomQuery`
   → `125` = *Portal - Parcel Number*, `128` = *Portal - Address*, `134` = *Portal -
   Parcel Number Search*.

2. **Search by parcel** — `POST /api/CustomQuery/KeywordSearch`, `Content-Type:
   application/json`, body:
   ```json
   {"QueryID":"125","Keywords":[{"id":106,"value":"4281032011","Operator":0}],
    "FromDate":null,"ToDate":null,"QueryLimit":0}
   ```
   (`106` is the OnBase keyword-type number for Parcel Number, from the form's
   `OBKey__106_1` field. Address search = `QueryID:"128"` with keyword `216` = street name
   and `215` = street number; optional year is keyword `107`.)

   Returns `{"Data":[…], "DisplayColumns":[…], "Truncated":bool}`. Each document carries:
   - `ID` — an **encrypted/opaque document token** (URL-encode it; it is *not* the handle).
   - `Name` — `PA - <APN> - <unit> - <year> - <date> - <DOCTYPE> - <subtype> - <case#> - <handle>`.
   - `DisplayColumnValues` aligned to `DisplayColumns`:
     `Address, Street, Unit ID, Document Type, Document Detail, Document Year, Case Number,
     Document Handle`.
   - `DisplayType` — `OleActivePage` for all 68 (OnBase image documents).

3. **Fetch a document** — `GET /api/Document/<urlencoded ID>/?ViewerMode=PDF`
   → `application/pdf`. `ViewerMode` enum: `PDF=0`, `Native=1`, `NativeOptional=2`.

This is the same one-request-per-query, token-replay shape as the existing `MarClient`,
but simpler — JSON in/out, anonymous, no ViewState.

## Document catalogue for 854 9th St (68 docs, 2004–2025)

By type (from the search metadata, no downloads needed to classify):

| count | Document Type |
|------:|---------------|
| 26 | `UPDATES - X FORMS` |
| **13** | **`MAR REPORT - ANNUAL MAR REPORT`** ← golden |
| 6 | `TENANCY REGISTRATION` (per-unit move-in: literal starting rent + date) |
| 6 | `UPDATES - OWNERSHIP OR ADDRESS CHANGE` |
| 3 | `OWNERSHIP REGISTRATION` |
| 3 | `ANNUAL BILLING` |
| 2 | `REG 13002 - REGULATIONS CORR` |
| 2 | `UPDATES - CORRESPONDENCE` |
| 1 each | `MAR REPORT - AGA 2023`, `FINAL RENT PRINTOUT`, `CORRESPONDENCE`, `CHANGE OF MAILING ADDRESS`, `UPDATES - {X FORMS CORR, LATE PAYMENT LETTER, REGISTRATION FORMS}` |

Years present: 2004–2025 with near-annual coverage. **`ANNUAL MAR REPORT` exists for
2013, 2014, …, 2025** (13 years) — this single type yields an annual per-unit MAR series
back to 2013 for this parcel.

### The golden doc: `ANNUAL MAR REPORT`

A 2-page mailing the Board sends each year (page 1 = cover letter, page 2 = the table).
Page 2 is a per-unit grid keyed by **`Parcel #`** and **`Infor ID`** with columns:

`Unit ID | Market Rate Established | Adjusted MAR (or current MAR if new tenancy) | <year> GA | New MAR as of Sep 1`

— i.e. **per-unit MAR with an effective/tenancy date, plus the year's GA delta and the
post-GA ceiling.** This is precisely the deep-history field we lacked.

Two useful wrinkles:
- A report is mailed **per owner and can bundle multiple parcels** (854 9th St's 2023
  report also tabled `1143 LINCOLN BLVD`, parcel `4281035013` — same owner). So a parcel
  query may return reports containing *other* parcels' rows. **Key extracted rows off the
  in-table `Parcel #` header, not the queried APN**, and dedup by `(parcel, unit, report-year)`.
- `TENANCY REGISTRATION` documents (2005+) should carry the **literal move-in rent** for
  each new tenancy, filling the pre-2013 gap and giving true reset values rather than
  carried-forward ceilings. (Not opened in this spike — recommended in the next probe.)

## Make-or-break validation (10/10)

2023 Annual MAR Report (handle `1410032`), page 2, parcel `4281032011`, vs our registry's
`2023-07-19` anchors. The doc's "Adjusted/current MAR" column = our snapshot MAR, and
"Market Rate Established" = our tenancy date, for **every unit**:

| unit | doc: Market Rate Established | doc: MAR | anchor tenancy | anchor 2023 MAR | match |
|---|---|---|---|---|---|
| 1 | 11/20/2000 | $2,750 | 2000-11-20 | $2,750 | ✓ |
| 2 | 08/01/2020 | $3,109 | 2020-08-01 | $3,109 | ✓ |
| 3 | 07/31/2022 | $3,050 | 2022-07-31 | $3,050 | ✓ |
| 4 | 06/01/2010 | $2,377 | 2010-06-01 | $2,377 | ✓ |
| 5 | 05/28/2021 | $2,318 | 2021-05-28 | $2,318 | ✓ |
| 6 | (blank) | $1,638 | (none) | $1,638 | ✓ |
| 7 | 04/01/2017 | $2,645 | 2017-04-01 | $2,645 | ✓ |
| 8 | 01/01/2010 | $2,324 | 2010-01-01 | $2,324 | ✓ |
| 9 | 05/01/2021 | $2,470 | 2021-05-01 | $2,470 | ✓ |
| 10 | 11/01/2013 | $2,140 | 2013-11-01 | $2,140 | ✓ |

The report's "New MAR as of Sep 1, 2023" column (e.g. unit 1 → $2,817) is the post-GA
ceiling that our later `2026-06-07` sweep then evolved from — so consecutive annual
reports also let us *attribute* each change (GA vs new-tenancy reset) exactly as our
forward change-log does, but backwards in time.

## OCR reality

All sampled PDFs are **image-only, zero text layer** (`pdffonts` empty; `pdftotext`
yields nothing; producer = "Ephesoft", a scan/capture tool). So **OCR is mandatory.**
Mitigants that make this cheap and accurate:
- Targets are **machine-generated, high-contrast, fixed-template** reports — not
  handwriting. Off-the-shelf OCR (Tesseract, or a cloud OCR API) will do well; the
  rigid grid even allows zonal/template extraction of page 2.
- We **filter on metadata before downloading**, so we only OCR `ANNUAL MAR REPORT`
  (≈13/parcel) and selected `TENANCY REGISTRATION`/`FINAL RENT PRINTOUT` — not all 68.
- Each Annual MAR Report is 2 pages and we only need page 2's table.
- Built-in QA: the most recent report's column must reconcile to our existing
  `2023-07-19`/sweep anchors (as demonstrated), giving a per-parcel OCR correctness gate.

## Recommended full-backfill design (next PR — do NOT build yet)

A new scraper subcommand family, mirroring the existing two-phase, polite-client pattern:

1. **`history-index`** — for each distinct APN in `parcels.csv`, `POST KeywordSearch`
   (query 125) once; persist the document list to `data/history/doc_index.csv`
   (`apn, doc_type, doc_year, case_number, handle, doc_id, name`). ~8,500 requests total,
   resumable/idempotent (skip APNs already indexed), one row per document.
2. **`history-fetch`** — download only the wanted doc types (`ANNUAL MAR REPORT`,
   `TENANCY REGISTRATION`, `FINAL RENT PRINTOUT`) as PDF into `data/raw/history/`
   (gitignored), keyed by handle; skip already-fetched.
3. **`history-ocr`** — OCR + template-parse page 2 of each MAR report into
   `data/history/mar_history.csv` (`parcel, infor_id, unit_id, report_year,
   market_rate_established, mar_cents, ga_cents, new_mar_cents, source_handle`), keying
   units off the in-table `Parcel #`/unit label and deduping by
   `(parcel, unit, report_year)`. **Fail loud** on rows that don't parse or whose latest
   year disagrees with the existing registry anchor.
4. **Merge** — fold the OCR'd history into the event-sourced `mar_observations.csv` as
   additional (earlier) change rows, so the existing read side (last-write-wins +
   carry-forward) and the `/charts` over-time reconstruction deepen automatically back to
   ~2013 with no schema change. Tag provenance so portal-derived observations are
   distinguishable from MAR-tool sweeps.

### Operational plan / politeness

- Reuse the `MarClient` ethos: identifying `User-Agent`, single-digit concurrency, a
  per-request delay (start ~250–500 ms; this is a heavier backend than `mar.aspx`), and
  honor `429/503` + `Retry-After` with exponential back-off.
- Watch for **Incapsula** escalation (a sudden `403`/JS-challenge HTML instead of JSON).
  If it appears, slow down and/or reuse a warmed session cookie; do **not** try to defeat
  the WAF. No `robots.txt` exists, but treat the portal as a public courtesy resource.
- Run the index phase first and cheaply (metadata only); gate the (larger) fetch+OCR
  phase on a second look once index volume/quality is known.

### Scope notes / open questions for the next probe

- Confirm `TENANCY REGISTRATION` carries the literal starting rent + date (expected; not
  opened here) — this is the path to pre-2013 reset values.
- Spot-check OCR accuracy on a handful of older (2013–2016) reports, which may be lower-DPI
  scans than 2023.
- Decide whether to also capture `AGA 20xx` / `FINAL RENT PRINTOUT` for cross-validation.

---

*Out of scope for this spike (noted separately): parcel-enrichment increment #1 — pull
`usetype`/`usedescrip` in the existing `fetch-geometry` call. See
`docs/design/parcel-enrichment.md`.*
