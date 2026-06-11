import { readCsv } from "../csv.ts";
import { slug } from "../normalize.ts";

/**
 * Resolve an OCR'd report unit (the parcel APN + the raw "Unit ID" cell text) to
 * the registry's canonical `unit_id`, using units.csv as the authority.
 *
 * The APN is the reliable join key (it OCRs cleanly as a 10-digit run), but the
 * unit label is written inconsistently across report eras: newer reports print
 * the full "854 9TH ST 1", older ones a bare "1", and exempt single-units the
 * bare street number "933". Registry unit_ids are `slug("<address> <label>")`, so
 * we match with a small ladder of strategies against the parcel's registry units.
 */
export type UnitResolver = (apn: string, rawLabel: string) => string | null;

type ApnIndex = {
  ids: Set<string>;
  byLabel: Map<string, Set<string>>; // normalized unit_label → unit_ids
  byNum: Map<string, Set<string>>; // leading street number of address → unit_ids
  all: string[];
};

const norm = (s: string): string => s.trim().toUpperCase();

function add(map: Map<string, Set<string>>, key: string, id: string): void {
  if (!key) return;
  const set = map.get(key) ?? new Set<string>();
  set.add(id);
  map.set(key, set);
}

function uniq(map: Map<string, Set<string>>, key: string): string | null {
  const set = map.get(key);
  return set && set.size === 1 ? [...set][0]! : null;
}

export function buildUnitResolver(unitsCsvPath: string): UnitResolver {
  const byApn = new Map<string, ApnIndex>();
  for (const u of readCsv(unitsCsvPath)) {
    const apn = (u.apn ?? "").trim();
    const id = u.unit_id ?? "";
    if (!apn || !id) continue;
    let idx = byApn.get(apn);
    if (!idx) {
      idx = { ids: new Set(), byLabel: new Map(), byNum: new Map(), all: [] };
      byApn.set(apn, idx);
    }
    idx.ids.add(id);
    idx.all.push(id);
    add(idx.byLabel, norm(u.unit_label ?? ""), id);
    add(idx.byNum, norm((u.address ?? "").split(/\s+/)[0] ?? ""), id);
  }

  return (apn, rawLabel) => {
    const idx = byApn.get(apn);
    if (!idx) return null;
    // (a) Newer reports / exempt fulls: the raw cell slugs straight to a unit_id.
    const sr = slug(rawLabel);
    if (idx.ids.has(sr)) return sr;
    const tokens = rawLabel.trim().split(/\s+/).filter(Boolean);
    // (b) Older numbered reports: the trailing token is the unit label ("1", "10").
    const last = norm(tokens[tokens.length - 1] ?? "");
    const byLabel = uniq(idx.byLabel, last);
    if (byLabel) return byLabel;
    // (c) Exempt singles in older reports: the leading street number ("933").
    const byNum = uniq(idx.byNum, norm(tokens[0] ?? ""));
    if (byNum) return byNum;
    // (d) Last resort: the parcel has exactly one registry unit.
    if (idx.all.length === 1) return idx.all[0]!;
    return null;
  };
}
