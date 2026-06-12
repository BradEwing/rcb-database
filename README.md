# rcb-database

A registry of every Santa Monica unit with an established
[Maximum Allowable Rent (MAR)][mar], scraped monthly from the City's public
lookup tool. The total runs above the Rent Control Board's official
"controlled units" count by definition; see
[`docs/reconciliation-2025.md`](docs/reconciliation-2025.md).

History before the first 2026 scrape is backfilled from the Rent Control
Board's [document portal][portal] (OCR'd annual MAR reports back to 2012) and
the City's one-time 2023 open-data export; parcel geometry comes from City
GIS.

The data is committed, so each monthly `git diff` is a per-unit change
history. Browse it on the
[interactive map and charts](https://bradewing.github.io/rcb-database/)
(source in `site/`).

## Usage

The registry is already committed under `data/`; the scraper exists to
re-collect it. The scrape commands hit the City's servers, so mind the rate
limits in [`CLAUDE.md`](CLAUDE.md).

```sh
npm install
npm run scraper -- sweep-streets     # Phase A: street → parcel index
npm run scraper -- drill-properties  # Phase B: per-parcel units + MAR
```

## License

This repository is dual-licensed:

- **Code** (scraper, tooling, site) — [MIT](LICENSE).
- **Data** (`data/`) — [CC0 1.0](data/LICENSE), public domain. The underlying
  MARs and APNs are factual public records from the City's MAR tool, document
  portal, open-data export, and GIS.

[mar]: https://www.smgov.net/departments/rentcontrol/mar.aspx
[portal]: https://rentcontroldocs.santamonica.gov/
