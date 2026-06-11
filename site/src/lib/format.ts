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

/** Human labels for the assessor use class (see `UseClass` in types.ts). The
 *  City layer can't split SFR from condo, so 'single' is labelled as both. */
const USE_CLASS_LABELS: Record<string, string> = {
  single: 'Single (SFR/condo)',
  two_three: '2–3 units',
  four: '4 units',
  five_plus: '5+ apartments',
  commercial: 'Commercial / mixed',
  other: 'Other use',
  unknown: 'Unknown use',
};

export function useClassLabel(useClass: string): string {
  return USE_CLASS_LABELS[useClass] ?? useClass;
}

/** Signed whole-dollar delta, e.g. -30900 → "−$309", 10900 → "+$109". */
export function formatSignedCents(cents: number): string {
  const sign = cents < 0 ? '−' : '+';
  return `${sign}${usd0.format(Math.abs(cents) / 100)}`;
}

/** Signed percentage, e.g. -9.4 → "−9.4%". */
export function formatPct(pct: number): string {
  const sign = pct < 0 ? '−' : '+';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

const REASON_LABELS: Record<string, string> = {
  new_tenancy: 'New tenancy',
  mar_adjustment: 'Adjustment',
};
const STATUS_LABELS: Record<string, string> = {
  became_exempt: 'Became exempt',
  reinstated: 'Reinstated',
};

/** Human label for a change row's attribution (status change takes precedence). */
export function changeReasonLabel(reason: string, statusChange: string): string {
  if (statusChange) return STATUS_LABELS[statusChange] ?? statusChange;
  return REASON_LABELS[reason] ?? reason ?? 'Change';
}
