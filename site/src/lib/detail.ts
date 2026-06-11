/** Render a parcel's detail (parcels/<apn>.json) into the side panel's inner
 *  HTML. Kept separate from the map island so it's easy to extend in PR5
 *  (MAR-history chart, change list, exits). */
import {
  formatCount,
  formatMarCents,
  formatSignedCents,
  formatPct,
  changeReasonLabel,
  sizeClassLabel,
  useClassLabel,
} from './format';
import type { ParcelChange, ParcelDetail, ParcelExit, UnitDetail } from './types';

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

  // County assessor use (raw description, classed label when they differ).
  // Guarded for older cached detail JSON without the field.
  let useLine = '';
  if (d.use_class && d.use_class !== 'unknown') {
    const raw = d.use_descrip || useClassLabel(d.use_class);
    const cls = useClassLabel(d.use_class);
    const suffix = raw !== cls ? ` <span class="muted">(${escapeHtml(cls)})</span>` : '';
    useLine = `<p class="useline muted">County use: ${escapeHtml(raw)}${suffix}</p>`;
  }

  const table =
    `<table class="units"><thead><tr>` +
    `<th>Unit</th><th class="num">BR</th><th class="num">MAR</th><th>Tenancy</th><th>Status</th>` +
    `</tr></thead><tbody>` +
    d.units.map(unitRow).join('') +
    `</tbody></table>`;

  // MAR-history chart goes here (hydrated by the island with Observable Plot).
  const chart =
    d.mar_history.length > 1
      ? `<section class="detail-section"><h2>MAR history</h2>` +
        `<div class="mar-chart" aria-label="MAR history chart"></div></section>`
      : '';

  return (
    `<header class="detail-head">` +
    addressBlock +
    `<p class="apn muted">APN ${escapeHtml(d.apn)}</p>` +
    useLine +
    `<p class="statline">${statline}</p>` +
    `</header>` +
    table +
    chart +
    renderChanges(d.changes) +
    renderExits(d.exited)
  );
}

function changeRow(c: ParcelChange): string {
  const unit = c.unit_label ? escapeHtml(c.unit_label) : '—';
  const up = c.delta_cents > 0;
  const down = c.delta_cents < 0;
  const arrow = up ? '▲' : down ? '▼' : '·';
  const deltaClass = up ? 'up' : down ? 'down' : 'flat';
  const from = c.old_mar_cents > 0 ? formatMarCents(c.old_mar_cents) : 'exempt';
  const to = c.new_mar_cents > 0 ? formatMarCents(c.new_mar_cents) : 'exempt';
  const delta =
    c.old_mar_cents > 0 && c.new_mar_cents > 0
      ? ` <span class="delta ${deltaClass}">${arrow} ${formatSignedCents(c.delta_cents)} (${formatPct(c.delta_pct)})</span>`
      : '';
  return (
    `<li>` +
    `<span class="when">${escapeHtml(c.observed_at)}</span>` +
    `<span class="what">Unit ${unit}: ${from} → ${to}${delta}</span>` +
    `<span class="why">${escapeHtml(changeReasonLabel(c.reason, c.mar_status_change))}</span>` +
    `</li>`
  );
}

function renderChanges(changes: ParcelChange[]): string {
  if (!changes.length) return '';
  return (
    `<section class="detail-section"><h2>Recent changes <span class="muted">(${changes.length})</span></h2>` +
    `<ul class="changes">${changes.map(changeRow).join('')}</ul></section>`
  );
}

function renderExits(exits: ParcelExit[]): string {
  if (!exits.length) return '';
  const rows = exits
    .map((e) => {
      const unit = e.unit_label ? escapeHtml(e.unit_label) : '—';
      const last = e.last_mar_cents > 0 ? formatMarCents(e.last_mar_cents) : 'exempt';
      return `<li>Unit ${unit} — last seen ${escapeHtml(e.last_seen_at)} at ${last}</li>`;
    })
    .join('');
  return (
    `<section class="detail-section"><h2>Exited units <span class="muted">(${exits.length})</span></h2>` +
    `<p class="muted exit-note">Gone from the latest sweep — possible demolition or full exemption.</p>` +
    `<ul class="exits">${rows}</ul></section>`
  );
}
