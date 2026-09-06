import type { ValuationSnapshot } from './api';

export type MergedRow = {
  date: string;
  close: number;
  fairValue: number | null;
  entryTarget: number | null;
  overvaluedAt: number | null;
  sellZoneAt: number | null;
};

/** Latest snapshot whose effective date is on/before `dateISO`, else null. Assumes `snaps`
 *  is sorted ascending by `asOf` (the backend guarantees this). */
export function snapshotAt(snaps: ValuationSnapshot[], dateISO: string): ValuationSnapshot | null {
  let found: ValuationSnapshot | null = null;
  for (const s of snaps) {
    if (s.asOf <= dateISO) found = s;
    else break;
  }
  return found;
}

/** Merge daily prices with the stepped snapshot series. Points before the first snapshot
 *  carry null valuation fields (the pre-coverage region). `k` is the FX scalar applied to
 *  every monetary valuation figure so the chart matches the CHF headline. */
export function mergePriceWithSnapshots(
  prices: { date: string; close: number }[],
  snaps: ValuationSnapshot[],
  k: number,
): MergedRow[] {
  let idx = -1; // index of the currently-applicable snapshot
  return prices.map((p) => {
    while (idx + 1 < snaps.length && snaps[idx + 1].asOf <= p.date) idx += 1;
    const s = idx >= 0 ? snaps[idx] : null;
    return {
      date: p.date,
      close: p.close,
      fairValue: s ? s.fairValue * k : null,
      entryTarget: s ? s.entryTarget * k : null,
      overvaluedAt: s ? s.overvaluedAt * k : null,
      sellZoneAt: s ? s.sellZoneAt * k : null,
    };
  });
}

export function pctLabel(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const pct = v * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}
