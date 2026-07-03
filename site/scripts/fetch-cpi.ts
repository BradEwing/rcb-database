/**
 * fetch-cpi — cache the U.S. CPI monthly index for the charts' constant-dollar
 * (inflation-adjusted) views.
 *
 * Occasional, NOT a per-build fetch (mirrors fetch-geometry / fetch-boundary):
 * the output is committed to data/external/cpi-us-monthly.csv. BLS publishes a
 * new month around mid-month; re-run every few months so the deflator base
 * stays near the present (build-data carries the last cached month forward for
 * any newer registry dates, so a stale cache degrades gracefully — recent
 * months just deflate by ~1).
 *
 * Series: CPIAUCSL via FRED's public bulk-CSV endpoint — "All items in U.S.
 * city average, all urban consumers, seasonally adjusted", the same series the
 * BLS publishes as CUSR0000SA0. One request, full history.
 *
 * Run: `npm run fetch-cpi`  (from the site/ directory)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CPI_CACHE } from "./lib/registry.ts";

const SOURCE_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL";
/** Earliest month kept in the cache. Chart deflation only reaches back as far
 *  as the registry's observation years (2012+); 2000 leaves headroom. */
const FROM_MONTH = "2000-01";
const USER_AGENT = "rcb-database cpi cache (https://github.com/BradEwing/rcb-database)";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchCsv(): Promise<string> {
  // Modest retry with backoff — same posture as the other cache fetchers.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(SOURCE_URL, { headers: { "User-Agent": USER_AGENT } });
      if (res.status === 429 || res.status === 503) {
        const wait = (attempt + 1) * 2000;
        process.stderr.write(`  ${res.status}; backing off ${wait}ms\n`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      await sleep((attempt + 1) * 1000);
    }
  }
  throw new Error(`Failed to fetch CPI series: ${String(lastErr)}`);
}

function main(rawCsv: string): void {
  const lines = rawCsv.trim().split("\n");
  const header = (lines[0] ?? "").trim();
  // FRED has served both header spellings over time; accept either.
  if (header !== "observation_date,CPIAUCSL" && header !== "DATE,CPIAUCSL") {
    throw new Error(`Unexpected FRED CSV header: "${header}" — endpoint changed?`);
  }

  const rows: Array<{ month: string; cpi: number }> = [];
  const missing: string[] = [];
  for (const line of lines.slice(1)) {
    const [date = "", value = ""] = line.split(",");
    const month = date.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new Error(`Unparseable observation date: "${date}"`);
    }
    if (month < FROM_MONTH) continue;
    // FRED serves missing observations as "." or empty — real gaps exist (e.g.
    // 2025-10, skipped during the fall-2025 government shutdown). Keep the cache
    // truthful by omitting the month; consumers carry the prior month forward.
    const trimmed = value.trim();
    if (trimmed === "" || trimmed === ".") {
      missing.push(month);
      continue;
    }
    const cpi = Number(trimmed);
    if (!Number.isFinite(cpi) || cpi <= 0) {
      throw new Error(`Non-numeric CPI value for ${month}: "${value}"`);
    }
    const prev = rows[rows.length - 1];
    if (prev && month <= prev.month) {
      throw new Error(`Months out of order at ${month} (after ${prev.month})`);
    }
    rows.push({ month, cpi });
  }
  if (missing.length > 2) {
    throw new Error(`${missing.length} missing months (${missing.join(", ")}) — series broken?`);
  }
  if (missing.length) {
    process.stderr.write(`  note: no published CPI for ${missing.join(", ")} (omitted)\n`);
  }

  if (rows.length < 200) {
    throw new Error(`Only ${rows.length} rows since ${FROM_MONTH} — series truncated?`);
  }
  // Freshness: BLS lags ~1 month; more than ~4 behind means a stalled series.
  const last = rows[rows.length - 1]!;
  const now = new Date();
  const monthsBehind =
    (now.getUTCFullYear() - Number(last.month.slice(0, 4))) * 12 +
    (now.getUTCMonth() + 1 - Number(last.month.slice(5, 7)));
  if (monthsBehind > 4) {
    throw new Error(`Latest CPI month is ${last.month} (${monthsBehind} months old) — stale source?`);
  }

  const csv =
    "month,cpi\n" + rows.map((r) => `${r.month},${r.cpi}`).join("\n") + "\n";
  mkdirSync(dirname(CPI_CACHE), { recursive: true });
  writeFileSync(CPI_CACHE, csv);
  process.stdout.write(
    `Wrote ${rows.length} months (${rows[0]!.month}…${last.month}) to ${CPI_CACHE}\n`,
  );
}

fetchCsv()
  .then(main)
  .catch((err) => {
    process.stderr.write(`fetch-cpi failed: ${String(err)}\n`);
    process.exit(1);
  });
