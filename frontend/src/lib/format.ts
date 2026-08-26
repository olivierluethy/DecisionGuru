// Swiss-formatted number/currency/percent helpers.

const chf = new Intl.NumberFormat('de-CH', {
  style: 'currency',
  currency: 'CHF',
  maximumFractionDigits: 0,
});
const chf2 = new Intl.NumberFormat('de-CH', {
  style: 'currency',
  currency: 'CHF',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const num2 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num0 = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });

/** Collapse a value that rounds to zero at the display precision (incl. -0 and
 *  tiny negative float artefacts) to a clean 0, so nothing ever reads "CHF -0.00". */
function deneg(v: number, decimals: boolean): number {
  const rounded = Number(v.toFixed(decimals ? 2 : 0));
  return rounded === 0 ? 0 : v;
}

export function fmtCHF(v: number | null | undefined, decimals = false): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const vv = deneg(v, decimals);
  return decimals ? chf2.format(vv) : chf.format(vv);
}

export function fmtCHFSigned(v: number | null | undefined, decimals = false): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const vv = deneg(v, decimals);
  const s = fmtCHF(Math.abs(vv), decimals);
  if (vv === 0) return s;
  return vv < 0 ? `− ${s}` : `+ ${s}`;
}

export function fmtNum(v: number | null | undefined, decimals = true): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return decimals ? num2.format(v) : num0.format(v);
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export function fmtPctSigned(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${Math.abs(v * 100).toFixed(digits)}%`;
}

export function fmtMoney(v: number | null | undefined, currency: string, decimals = true): string {
  if (v == null || !Number.isFinite(v)) return '—';
  try {
    return new Intl.NumberFormat('de-CH', {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals ? 2 : 0,
      maximumFractionDigits: decimals ? 2 : 0,
    }).format(v);
  } catch {
    return `${currency} ${fmtNum(v, decimals)}`;
  }
}

export function fmtMonths(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return '—';
  if (m <= 0) return 'already ahead';
  if (m < 12) return `${Math.round(m)} mo`;
  const years = m / 12;
  return `${years.toFixed(1)} yr`;
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return d;
  return new Intl.DateTimeFormat('de-CH', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}

/** Tailwind text-colour class for a signed value. */
export function plClass(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v === 0) return 'text-text-muted';
  return v > 0 ? 'text-gain' : 'text-loss';
}
