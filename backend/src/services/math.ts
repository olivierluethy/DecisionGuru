import dayjs from 'dayjs';

export interface CashFlow {
  date: string; // ISO
  amount: number; // negative = outflow (investment), positive = inflow
}

/** Money-weighted return (XIRR) via Newton's method with a bisection fallback. */
export function xirr(flows: CashFlow[], guess = 0.1): number | null {
  const valid = flows.filter((f) => Number.isFinite(f.amount) && f.amount !== 0);
  if (valid.length < 2) return null;
  const hasPos = valid.some((f) => f.amount > 0);
  const hasNeg = valid.some((f) => f.amount < 0);
  if (!hasPos || !hasNeg) return null;

  const t0 = dayjs(valid[0].date);
  const years = valid.map((f) => dayjs(f.date).diff(t0, 'day') / 365);
  const amounts = valid.map((f) => f.amount);

  const npv = (r: number) => amounts.reduce((s, a, i) => s + a / Math.pow(1 + r, years[i]), 0);
  const dnpv = (r: number) =>
    amounts.reduce((s, a, i) => s - (years[i] * a) / Math.pow(1 + r, years[i] + 1), 0);

  // Newton
  let rate = guess;
  for (let i = 0; i < 100; i++) {
    const f = npv(rate);
    const d = dnpv(rate);
    if (Math.abs(d) < 1e-12) break;
    const next = rate - f / d;
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - rate) < 1e-8) return clampRate(next);
    rate = next;
  }

  // Bisection fallback on [-0.9999, 10]
  let lo = -0.9999;
  let hi = 10;
  let flo = npv(lo);
  let fhi = npv(hi);
  if (flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-7) return clampRate(mid);
    if (flo * fm < 0) {
      hi = mid;
      fhi = fm;
    } else {
      lo = mid;
      flo = fm;
    }
  }
  return clampRate((lo + hi) / 2);
}

function clampRate(r: number): number | null {
  if (!Number.isFinite(r)) return null;
  if (r < -0.9999 || r > 100) return null;
  return r;
}

/** Compound annual growth rate from start to end value over `years`. */
export function cagr(startValue: number, endValue: number, years: number): number | null {
  if (startValue <= 0 || years <= 0 || endValue <= 0) return null;
  return Math.pow(endValue / startValue, 1 / years) - 1;
}

export function yearsBetween(a: string, b: string): number {
  return Math.max(dayjs(b).diff(dayjs(a), 'day') / 365, 0);
}
