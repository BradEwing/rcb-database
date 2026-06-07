/** Render a parcel's detail (parcels/<apn>.json) into the side panel's inner
 *  HTML. Kept separate from the map island so it's easy to extend in PR5
 *  (MAR-history chart, change list, exits). */
import { formatCount, formatMarCents, sizeClassLabel } from './format';
import type { ParcelDetail, UnitDetail } from './types';

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}

function sizeClassFor(unitCount: number): string {
  if (unitCount <= 1) return 'single';
  if (unitCount <= 3) return 'small';
  return 'multifamily';
}

function unitRow(u: UnitDetail): string {
  const label = u.unit_label ? escapeHtml(u.unit_label) : '—';
  const br = u.bedrooms ? escapeHtml(u.bedrooms) : '—';
  const tenancy = u.tenancy_date ? escapeHtml(u.tenancy_date) : '—';
  const statusClass = u.mar_status === 'exempt' ? 'status-exempt' : 'status-controlled';
  const mar = u.mar_status === 'exempt' ? 'exempt' : formatMarCents(u.mar_cents);
  return (
    `<tr>` +
    `<td>${label}</td>` +
    `<td class="num">${br}</td>` +
    `<td class="num">${mar}</td>` +
    `<td>${tenancy}</td>` +
    `<td><span class="badge ${statusClass}">${u.mar_status}</span></td>` +
    `</tr>`
  );
}

export function renderParcelDetail(d: ParcelDetail): string {
  const s = d.summary;
  const addrPrimary = d.addresses[0] ?? `APN ${d.apn}`;
  const addrRest = d.addresses.slice(1);

  const addressBlock = addrRest.length
    ? `<details class="addresses"><summary>${escapeHtml(addrPrimary)} ` +
      `<span class="muted">+${addrRest.length} more</span></summary>` +
      `<ul>${d.addresses.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul></details>`
    : `<p class="single-address">${escapeHtml(addrPrimary)}</p>`;

  const statline =
    `${formatCount(s.unit_count)} units · ${sizeClassLabel(sizeClassFor(s.unit_count))}` +
    ` · ${formatCount(s.controlled)} controlled` +
    (s.exempt > 0 ? ` · ${formatCount(s.exempt)} exempt` : '') +
    ` · median MAR ${formatMarCents(s.median_mar_cents)}`;

  const table =
    `<table class="units"><thead><tr>` +
    `<th>Unit</th><th class="num">BR</th><th class="num">MAR</th><th>Tenancy</th><th>Status</th>` +
    `</tr></thead><tbody>` +
    d.units.map(unitRow).join('') +
    `</tbody></table>`;

  return (
    `<header class="detail-head">` +
    addressBlock +
    `<p class="apn muted">APN ${escapeHtml(d.apn)}</p>` +
    `<p class="statline">${statline}</p>` +
    `</header>` +
    table
  );
}
