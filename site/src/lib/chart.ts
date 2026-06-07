/** MAR-history chart for the detail panel, via Observable Plot. Imported
 *  dynamically by the map island (only when a panel opens) so Plot/d3 stay out
 *  of the initial bundle. */
import * as Plot from '@observablehq/plot';
import type { MarHistoryPoint } from './types';

/**
 * Step lines of each unit's MAR over time. The registry's change log is sparse
 * (one point per change, carry-forward in between), so a step curve is the
 * faithful shape. Exempt ($0) points are dropped from the lines.
 */
export function marHistoryChart(history: MarHistoryPoint[], width: number): HTMLElement | SVGSVGElement {
  const data = history
    .filter((p) => p.mar_cents > 0)
    .map((p) => ({
      date: new Date(p.observed_at),
      mar: p.mar_cents / 100,
      unit: p.unit_label || '—',
    }));

  return Plot.plot({
    width: Math.max(260, width),
    height: 200,
    marginLeft: 52,
    marginBottom: 28,
    style: { background: 'transparent', fontSize: '10px' },
    x: { label: null, grid: false },
    y: { label: 'MAR ($)', grid: true, tickFormat: (d: number) => `$${(d / 1000).toFixed(1)}k` },
    color: { legend: false },
    marks: [
      Plot.lineY(data, {
        x: 'date',
        y: 'mar',
        z: 'unit',
        stroke: 'unit',
        curve: 'step-after',
        strokeWidth: 1.4,
      }),
      Plot.dot(data, { x: 'date', y: 'mar', fill: 'unit', r: 2.5 }),
    ],
  });
}
