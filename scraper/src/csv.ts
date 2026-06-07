import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { stringify } from "csv-stringify/sync";
import { parse } from "csv-parse/sync";

export type Row = Record<string, string>;

export function readCsv(path: string): Row[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  if (content.trim().length === 0) return [];
  return parse(content, { columns: true, skip_empty_lines: true }) as Row[];
}

/**
 * Write rows sorted by the given key columns. Deterministic output enables
 * meaningful `git diff` between monthly snapshots.
 */
export function writeCsvSorted(
  path: string,
  headers: string[],
  rows: Row[],
  sortKeys: string[],
): void {
  mkdirSync(dirname(path), { recursive: true });
  const sorted = [...rows].sort((a, b) => {
    for (const key of sortKeys) {
      const av = a[key] ?? "";
      const bv = b[key] ?? "";
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  });
  const out = stringify(sorted, {
    header: true,
    columns: headers,
    record_delimiter: "\n",
  });
  writeFileSync(path, out);
}

/**
 * Merge `incoming` into `existing` keyed by the given columns.
 * Existing rows are preserved (first_seen_at stays put); new rows are appended.
 */
export function mergeRows(
  existing: Row[],
  incoming: Row[],
  keyColumns: string[],
): Row[] {
  const keyOf = (r: Row) => keyColumns.map((c) => r[c] ?? "").join("");
  const have = new Map<string, Row>();
  for (const r of existing) have.set(keyOf(r), r);
  for (const r of incoming) {
    const k = keyOf(r);
    if (!have.has(k)) have.set(k, r);
  }
  return [...have.values()];
}
