import yahooFinance from 'yahoo-finance2';
import dayjs from 'dayjs';
import { db } from '../db/index.js';
import { CACHE_TTL_MS } from '../config.js';
import type { PricePoint, Quote } from '@decisionguru/shared';

yahooFinance.suppressNotices(['yahooSurvey']);

// ---- price history ------------------------------------------------------

const priceCoverage = db.prepare(
  'SELECT MIN(date) AS mn, MAX(date) AS mx, COUNT(*) AS c FROM price_cache WHERE symbol = ?',
);
const upsertPrice = db.prepare(
  'INSERT OR REPLACE INTO price_cache (symbol, date, close) VALUES (?, ?, ?)',
);
const upsertDiv = db.prepare(
  'INSERT OR REPLACE INTO dividend_cache (symbol, date, amount) VALUES (?, ?, ?)',
);

async function fetchChart(symbol: string, from: string) {
  const period1 = dayjs(from).subtract(10, 'day').toDate();
  const result = await yahooFinance.chart(symbol, {
    period1,
    interval: '1d',
    events: 'div',
  });
  const insertPrices = db.transaction((rows: PricePoint[]) => {
    for (const r of rows) upsertPrice.run(symbol, r.date, r.close);
  });
  const prices: PricePoint[] = (result.quotes ?? [])
    .filter((q) => q.close != null && q.date)
    .map((q) => ({ date: dayjs(q.date).format('YYYY-MM-DD'), close: q.close as number }));
  insertPrices(prices);

  const divEvents = (result.events?.dividends ?? []) as Array<{ amount: number; date: number | Date }>;
  const insertDivs = db.transaction((rows: Array<{ date: string; amount: number }>) => {
    for (const r of rows) upsertDiv.run(symbol, r.date, r.amount);
  });
  insertDivs(
    divEvents.map((d) => ({ date: dayjs(d.date).format('YYYY-MM-DD'), amount: d.amount })),
  );
}

/** Ensure price history covering `from`..today is cached. */
export async function ensureHistory(symbol: string, from: string): Promise<void> {
  const cov = priceCoverage.get(symbol) as { mn: string | null; mx: string | null; c: number };
  const today = dayjs().format('YYYY-MM-DD');
  const needsBackfill = !cov.c || !cov.mn || dayjs(from).isBefore(dayjs(cov.mn));
  const isStale = !cov.mx || dayjs(cov.mx).isBefore(dayjs(today).subtract(3, 'day'));
  if (needsBackfill || isStale) {
    const start = needsBackfill ? from : cov.mx ?? from;
    try {
      await fetchChart(symbol, start);
    } catch (err) {
      // leave whatever is cached; upstream flags staleness
      console.warn(`[marketdata] history fetch failed for ${symbol}:`, (err as Error).message);
    }
  }
}

export async function getHistory(symbol: string, from: string, to?: string): Promise<PricePoint[]> {
  await ensureHistory(symbol, from);
  const end = to ?? dayjs().format('YYYY-MM-DD');
  return db
    .prepare('SELECT date, close FROM price_cache WHERE symbol = ? AND date >= ? AND date <= ? ORDER BY date')
    .all(symbol, from, end) as PricePoint[];
}

/** Closing price on or immediately before `date`. */
export async function priceOn(symbol: string, date: string): Promise<number | null> {
  await ensureHistory(symbol, date);
  const row = db
    .prepare('SELECT close FROM price_cache WHERE symbol = ? AND date <= ? ORDER BY date DESC LIMIT 1')
    .get(symbol, date) as { close: number } | undefined;
  if (row) return row.close;
  const fallback = db
    .prepare('SELECT close FROM price_cache WHERE symbol = ? ORDER BY date ASC LIMIT 1')
    .get(symbol) as { close: number } | undefined;
  return fallback ? fallback.close : null;
}

export async function getDividends(symbol: string, from: string): Promise<PricePoint[]> {
  await ensureHistory(symbol, from);
  return db
    .prepare('SELECT date, amount AS close FROM dividend_cache WHERE symbol = ? AND date >= ? ORDER BY date')
    .all(symbol, from) as PricePoint[];
}

// ---- quote --------------------------------------------------------------

const getQuoteCache = db.prepare('SELECT * FROM quote_cache WHERE symbol = ?');
const putQuoteCache = db.prepare(
  'INSERT OR REPLACE INTO quote_cache (symbol, price, currency, name, fetchedAt) VALUES (?, ?, ?, ?, ?)',
);

export async function getQuote(symbol: string): Promise<Quote> {
  const cached = getQuoteCache.get(symbol) as
    | { symbol: string; price: number; currency: string; name: string; fetchedAt: number }
    | undefined;
  const fresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS.quote;
  if (cached && fresh) {
    return {
      symbol,
      price: cached.price,
      currency: cached.currency,
      name: cached.name,
      time: new Date(cached.fetchedAt).toISOString(),
      stale: false,
    };
  }
  try {
    const q = await yahooFinance.quote(symbol);
    const price = (q.regularMarketPrice ?? q.postMarketPrice ?? q.preMarketPrice ?? 0) as number;
    const currency = (q.currency ?? 'USD') as string;
    const name = (q.longName ?? q.shortName ?? symbol) as string;
    putQuoteCache.run(symbol, price, currency, name, Date.now());
    return { symbol, price, currency, name, time: new Date().toISOString(), stale: false };
  } catch (err) {
    console.warn(`[marketdata] quote failed for ${symbol}:`, (err as Error).message);
    if (cached) {
      return {
        symbol,
        price: cached.price,
        currency: cached.currency,
        name: cached.name,
        time: new Date(cached.fetchedAt).toISOString(),
        stale: true,
      };
    }
    return { symbol, price: 0, currency: 'USD', name: symbol, time: new Date().toISOString(), stale: true };
  }
}

// ---- fund / instrument profile -----------------------------------------

const getFundCache = db.prepare('SELECT payload, fetchedAt FROM fund_cache WHERE symbol = ?');
const putFundCache = db.prepare(
  'INSERT OR REPLACE INTO fund_cache (symbol, payload, fetchedAt) VALUES (?, ?, ?)',
);

export async function getFundSummary(symbol: string): Promise<any> {
  const cached = getFundCache.get(symbol) as { payload: string; fetchedAt: number } | undefined;
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS.fund) {
    return JSON.parse(cached.payload);
  }
  try {
    const summary = await yahooFinance.quoteSummary(symbol, {
      modules: ['topHoldings', 'fundProfile', 'assetProfile', 'summaryProfile', 'price', 'summaryDetail'],
    });
    putFundCache.run(symbol, JSON.stringify(summary), Date.now());
    return summary;
  } catch (err) {
    console.warn(`[marketdata] quoteSummary failed for ${symbol}:`, (err as Error).message);
    if (cached) return JSON.parse(cached.payload);
    return null;
  }
}

/** Search Yahoo for a symbol by name/isin/ticker (used by manual add + import resolve). */
export async function searchSymbol(query: string) {
  try {
    const res = await yahooFinance.search(query, { newsCount: 0, quotesCount: 8 });
    return (res.quotes ?? [])
      .filter((q: any) => q.symbol)
      .map((q: any) => ({
        symbol: q.symbol,
        name: q.longname ?? q.shortname ?? q.symbol,
        exchange: q.exchange,
        kind: q.quoteType === 'ETF' ? 'etf' : 'stock',
        type: q.quoteType,
      }));
  } catch (err) {
    console.warn(`[marketdata] search failed for ${query}:`, (err as Error).message);
    return [];
  }
}
