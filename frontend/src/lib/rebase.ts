/** Rebasing + catch-up math shared by the price chart and the catch-up table. */

type Point = { date: string; close: number };

function toT(series: Point[]): { t: number; c: number }[] {
  return series
    .filter((p) => p && p.date && Number.isFinite(p.close))
    .map((p) => ({ t: new Date(p.date).getTime(), c: p.close }))
    .sort((a, b) => a.t - b.t);
}

function closeAtOrBefore(sorted: { t: number; c: number }[], ts: number): number {
  if (!sorted.length) return 0;
  let lo = 0, hi = sorted.length - 1, res = sorted[0].c;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].t <= ts) { res = sorted[mid].c; lo = mid + 1; } else hi = mid - 1;
  }
  return res;
}

export interface CatchUp {
  /** Price the stock would need TODAY to have matched this instrument since the anchor. */
  targetToday: number;
  stockToday: number;
  /** targetToday / stockToday − 1 → how far the stock must climb just to draw level. */
  catchUpPct: number;
  /** Date from which the (rebased) instrument has stayed ahead of the stock, if any. */
  behindSince: string | null;
}

/**
 * Rebase `other` onto `stock`'s price at the anchor, then measure how far the stock
 * trails today and since when it has been behind for good. The anchor is `anchorDate`
 * (typically the holding's entry date, so every comparison is measured over the SAME
 * period you actually held it) when both series cover it, else the first common date.
 */
export function catchUp(stock: Point[], other: Point[], anchorDate?: string | null): CatchUp | null {
  const s = toT(stock);
  const o = toT(other);
  if (s.length < 2 || o.length < 2) return null;
  const anchorT = anchorDate ? new Date(anchorDate).getTime() : 0;
  const firstT = Math.max(o[0].t, anchorT);
  const anchor = s.find((p) => p.t >= firstT);
  if (!anchor) return null;
  const oAtAnchor = closeAtOrBefore(o, anchor.t);
  if (!(oAtAnchor > 0)) return null;
  const scale = anchor.c / oAtAnchor;

  const last = s[s.length - 1];
  const targetToday = closeAtOrBefore(o, last.t) * scale;
  const stockToday = last.c;
  const catchUpPct = stockToday > 0 ? targetToday / stockToday - 1 : 0;

  let lastAhead = -1;
  const inRange = s.filter((p) => p.t >= firstT);
  for (let i = 0; i < inRange.length; i++) {
    const reb = closeAtOrBefore(o, inRange[i].t) * scale;
    if (inRange[i].c >= reb) lastAhead = i;
  }
  let behindSince: string | null = null;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  if (lastAhead < 0) behindSince = inRange.length ? iso(inRange[0].t) : null; // behind from the start
  else if (lastAhead < inRange.length - 1) behindSince = iso(inRange[lastAhead + 1].t);

  return { targetToday, stockToday, catchUpPct, behindSince };
}
