# rcb-database

A self-hosted registry of Santa Monica rent-controlled units, scraped monthly
from the City's public [Maximum Allowable Rent (MAR) lookup tool][mar]. The
registry is the source of truth for tracking MAR changes over time — new
tenancies, the annual general adjustment, capital-improvement pass-throughs —
for every rent-controlled parcel in the city.

The data is committed to the repo so each monthly snapshot is a line-level
`git diff`: a free, per-unit change history.

## Snapshot (2026-06-07)

- 147 streets · 10,714 address-parcels (~8,500 distinct APNs)
- 35,419 units — 32,900 with a positive MAR, 2,519 currently exempt (`$0`)
- The registry total is a *superset* of the RCB Annual Report's 27,589
  "controlled" headline; the ~19% gap is definitional, not a scraper defect
  (see [`docs/reconciliation-2025.md`](docs/reconciliation-2025.md)).

## Layout

- `scraper/` — TS/Node scraper (`tsx`, `undici`, `cheerio`, `zod`).
- `data/` — the registry, one CSV per table (`streets`, `parcels`, `units`,
  `mar_observations`) plus regenerable `data/derived/` analysis artifacts.
- `.github/workflows/monthly-snapshot.yml` — monthly cron that drills every
  parcel, reconciles, and commits the new snapshot.

## Usage

```sh
npm install
npm run typecheck
npm run test
npm run scraper -- <probe-one|refresh-streets|sweep-streets|drill-properties>
npm run reconcile
```

See [`CLAUDE.md`](CLAUDE.md) for the full design, form behavior, and run cadence.

## License

This repository is dual-licensed to reflect that it contains both software and
public data:

- **Code** (scraper, tooling, site) — [MIT](LICENSE).
- **Data** (`data/`) — [CC0 1.0](data/LICENSE), public domain. The underlying
  MARs and APNs are factual public records compiled from the City's MAR tool.

[mar]: https://www.smgov.net/departments/rentcontrol/mar.aspx
