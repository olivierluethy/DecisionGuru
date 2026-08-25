import dayjs from 'dayjs';
import type { Instrument, InstrumentDataStatus } from '@decisionguru/shared';
import { db } from '../db/index.js';

const quoteStmt = db.prepare('SELECT price, fetchedAt FROM quote_cache WHERE symbol = ?');
const coverageStmt = db.prepare(
  'SELECT COUNT(*) AS c, MAX(date) AS mx FROM price_cache WHERE symbol = ?',
);

/**
 * Market-data health for one instrument, used to render a per-instrument badge so the UI
 * never silently shows a 0 as if it were a real value.
 */
export function instrumentDataStatus(
  inst: Instrument,
  openQuantity?: number,
): InstrumentDataStatus {
  if (inst.unresolved || (inst.isin && inst.symbol === inst.isin)) {
    return {
      state: 'unresolved',
      resolutionSource: inst.resolutionSource ?? 'unresolved',
      message: 'No ticker resolved — value & charts unavailable. Edit the symbol or retry resolve.',
    };
  }
  // A fully-closed position has a definitive value of 0 — that is not "missing data".
  if (openQuantity != null && openQuantity <= 0) {
    return { state: 'ok', resolutionSource: inst.resolutionSource ?? null, message: 'Position closed.' };
  }
  const quote = quoteStmt.get(inst.symbol) as { price: number; fetchedAt: number } | undefined;
  const cov = coverageStmt.get(inst.symbol) as { c: number; mx: string | null };
  const hasQuote = !!quote && quote.price > 0;
  const coverageDays = cov.c ?? 0;

  if (!hasQuote && !coverageDays) {
    return {
      state: 'no-data',
      resolutionSource: inst.resolutionSource ?? null,
      priceCoverageDays: 0,
      message: 'No market data yet (provider may be rate-limiting) — try again shortly.',
    };
  }

  const quoteAsOf = quote ? new Date(quote.fetchedAt).toISOString() : null;
  const stale =
    (!quote || dayjs().diff(dayjs(quote.fetchedAt), 'hour') >= 24) &&
    (!cov.mx || dayjs().diff(dayjs(cov.mx), 'day') > 4);

  return {
    state: stale ? 'stale' : 'ok',
    resolutionSource: inst.resolutionSource ?? null,
    quoteAsOf,
    priceCoverageDays: coverageDays,
    message: stale ? 'Prices may be a few days old (cached).' : null,
  };
}
