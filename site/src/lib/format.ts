/** Display formatters shared across the map and (later) the detail panel. */

const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const num = new Intl.NumberFormat('en-US');

/** Cents → whole-dollar string, e.g. 299500 → "$2,995". 0 → "—" (exempt/none). */
export function formatMarCents(cents: number): string {
  if (!cents || cents <= 0) return '—';
  return usd0.format(cents / 100);
}

/** Thousands-separated integer, e.g. 35419 → "35,419". */
export function formatCount(n: number): string {
  return num.format(n);
}

const SIZE_LABELS: Record<string, string> = {
  single: '1 unit',
  small: '2–3 units',
  multifamily: '4+ units',
};

export function sizeClassLabel(sizeClass: string): string {
  return SIZE_LABELS[sizeClass] ?? sizeClass;
}
