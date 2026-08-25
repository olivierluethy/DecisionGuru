import { db } from '../db/index.js';
import dayjs from 'dayjs';

// frankfurter.app: ECB reference rates. 1 `from` = rate `to`.
const BASE_URL = 'https://api.frankfurter.app';

const getStmt = db.prepare(
  'SELECT rate FROM fx_cache WHERE base = ? AND quote = ? AND date = ?',
);
const putStmt = db.prepare(
  'INSERT OR REPLACE INTO fx_cache (base, quote, date, rate) VALUES (?, ?, ?, ?)',
);

const nearestStmt = db.prepare(
  `SELECT rate FROM fx_cache WHERE base = ? AND quote = ? AND date <= ? AND date >= ?
   ORDER BY date DESC LIMIT 1`,
);

function cacheGet(base: string, quote: string, date: string): number | null {
  const row = getStmt.get(base, quote, date) as { rate: number } | undefined;
  return row ? row.rate : null;
}

/** Nearest cached business-day rate on/before `date`, within a small window. */
function cacheGetNearest(base: string, quote: string, date: string): number | null {
  const floor = dayjs(date).subtract(6, 'day').format('YYYY-MM-DD');
  const row = nearestStmt.get(base, quote, date, floor) as { rate: number } | undefined;
  return row ? row.rate : null;
}

/** Pre-populate fx_cache with the full ECB business-day series for a range. */
export async function ensureFxRange(
  currencies: string[],
  from: string,
  to: string,
): Promise<void> {
  const start = dayjs(from).subtract(7, 'day').format('YYYY-MM-DD');
  const end = dayjs(to).format('YYYY-MM-DD');
  for (const cur of currencies) {
    if (cur === 'CHF') continue;
    // Skip if we already have decent coverage in this range.
    const cov = db
      .prepare('SELECT COUNT(*) AS c FROM fx_cache WHERE base = ? AND quote = ? AND date >= ? AND date <= ?')
      .get(cur, 'CHF', start, end) as { c: number };
    const businessDays = dayjs(end).diff(dayjs(start), 'day') * (5 / 7);
    if (cov.c > businessDays * 0.6) continue;
    try {
      const res = await fetch(`${BASE_URL}/${start}..${end}?from=${cur}&to=CHF`);
      if (!res.ok) continue;
      const data = (await res.json()) as { rates?: Record<string, Record<string, number>> };
      const rows = Object.entries(data.rates ?? {});
      const tx = db.transaction((entries: Array<[string, Record<string, number>]>) => {
        for (const [d, r] of entries) {
          if (typeof r.CHF === 'number') putStmt.run(cur, 'CHF', d, r.CHF);
        }
      });
      tx(rows);
    } catch {
      /* ignore; per-date fallback still works */
    }
  }
}

/**
 * Rate to convert 1 unit of `from` into `to` on (or just before) `date`.
 * Falls back over a small window for weekends/holidays. Same currency -> 1.
 */
export async function getFxRate(from: string, to: string, date: string): Promise<number> {
  if (from === to) return 1;
  const iso = dayjs(date).format('YYYY-MM-DD');
  const cached = cacheGet(from, to, iso);
  if (cached != null) return cached;
  const near = cacheGetNearest(from, to, iso);
  if (near != null) {
    putStmt.run(from, to, iso, near); // memoize under requested date
    return near;
  }

  // Query a short range ending at the target date and take the most recent point.
  const start = dayjs(iso).subtract(7, 'day').format('YYYY-MM-DD');
  try {
    const url = `${BASE_URL}/${start}..${iso}?from=${from}&to=${to}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = (await res.json()) as { rates?: Record<string, Record<string, number>> };
      const dates = Object.keys(data.rates ?? {}).sort();
      if (dates.length) {
        const last = dates[dates.length - 1];
        const rate = data.rates![last][to];
        if (typeof rate === 'number') {
          putStmt.run(from, to, iso, rate); // cache under requested date
          return rate;
        }
      }
    }
  } catch {
    /* fall through */
  }

  // Last resort: try latest.
  try {
    const res = await fetch(`${BASE_URL}/latest?from=${from}&to=${to}`);
    if (res.ok) {
      const data = (await res.json()) as { rates?: Record<string, number> };
      const rate = data.rates?.[to];
      if (typeof rate === 'number') {
        putStmt.run(from, to, iso, rate);
        return rate;
      }
    }
  } catch {
    /* ignore */
  }
  // Unknown FX: return 1 so the app degrades gracefully (flagged as stale upstream).
  return 1;
}

export async function toCHF(amount: number, currency: string, date: string): Promise<number> {
  if (!amount) return 0;
  const rate = await getFxRate(currency, 'CHF', date);
  return amount * rate;
}

export async function latestFxToCHF(currency: string): Promise<number> {
  return getFxRate(currency, 'CHF', dayjs().format('YYYY-MM-DD'));
}
