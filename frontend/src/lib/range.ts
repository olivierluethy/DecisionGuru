import type { RangeKey } from '@decisionguru/shared';

const DAYS: Record<RangeKey, number | null> = {
  '1D': 1, '30D': 30, '1M': 31, '2M': 62, '5M': 153, '6M': 183,
  '1Y': 365, '2Y': 730, '5Y': 1825, MAX: null,
};

/** ISO date `range` days before today, or null for MAX (no lower bound). */
export function rangeCutoffISO(range: RangeKey): string | null {
  const d = DAYS[range];
  if (d == null) return null;
  const t = new Date();
  t.setDate(t.getDate() - d);
  return t.toISOString().slice(0, 10);
}

/** Client-side slice of a dated series to a preset range (for charts already fetched whole). */
export function sliceByRange<T extends { date: string }>(points: T[], range: RangeKey): T[] {
  const cutoff = rangeCutoffISO(range);
  return cutoff ? points.filter((p) => p.date >= cutoff) : points;
}
