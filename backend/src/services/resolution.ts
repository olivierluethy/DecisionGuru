import type { Currency, InstrumentKind } from '@decisionguru/shared';
import { curatedResolve, countryFromIsin } from '@decisionguru/shared';
import { db } from '../db/index.js';
import { searchSymbol, type SymbolSearchHit } from './marketdata.js';

export interface ResolvedSymbol {
  symbol: string;
  currency: Currency;
  kind: InstrumentKind;
  country: string | null;
  name?: string | null;
  exchange?: string | null;
  source: 'curated' | 'yahoo' | 'manual' | 'unresolved';
  unresolved: boolean;
}

const getMap = db.prepare('SELECT * FROM symbol_map WHERE isin = ?');
const putMap = db.prepare(
  `INSERT OR REPLACE INTO symbol_map (isin, symbol, currency, kind, country, name, exchange, source, resolvedAt)
   VALUES (@isin, @symbol, @currency, @kind, @country, @name, @exchange, @source, @resolvedAt)`,
);

function persist(isin: string | undefined | null, r: ResolvedSymbol) {
  if (!isin || r.unresolved) return;
  putMap.run({
    isin,
    symbol: r.symbol,
    currency: r.currency,
    kind: r.kind,
    country: r.country,
    name: r.name ?? null,
    exchange: r.exchange ?? null,
    source: r.source,
    resolvedAt: Date.now(),
  });
}

/** An identifier looks like a real ticker (not just the raw ISIN or a slug of it). */
function looksLikeTicker(symbol: string | undefined, isin?: string | null): boolean {
  if (!symbol) return false;
  const s = symbol.trim().toUpperCase();
  if (!s) return false;
  if (isin && s === isin.toUpperCase()) return false;
  // ISIN shape: 12 chars, 2 letters + 9 alnum + check digit — reject as a ticker.
  if (/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(s)) return false;
  return true;
}

/** Currency implied by a Yahoo exchange-suffix, used to sanity-pick a search hit. */
const SUFFIX_CCY: Record<string, string> = {
  SW: 'CHF', VX: 'CHF', L: 'GBP', PA: 'EUR', DE: 'EUR', F: 'EUR', AS: 'EUR',
  MI: 'EUR', MC: 'EUR', BR: 'EUR', TO: 'CAD', V: 'CAD', HK: 'HKD', T: 'JPY',
};

function suffixOf(symbol: string): string | null {
  const parts = symbol.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : null;
}

/** Rank Yahoo hits by how well they match the identifiers/hints we already have. */
function pickBest(hits: SymbolSearchHit[], hint?: { country?: string | null }): SymbolSearchHit | null {
  if (!hits.length) return null;
  const scored = hits.map((h) => {
    let score = 0;
    const type = (h.type ?? '').toUpperCase();
    if (type === 'EQUITY' || type === 'ETF') score += 5;
    if (type === 'MUTUALFUND') score += 2;
    // Prefer a listing whose country matches the ISIN issuer country.
    const suf = suffixOf(h.symbol);
    if (hint?.country && suf) {
      const sufCcy = SUFFIX_CCY[suf];
      if (
        (hint.country === 'CH' && (suf === 'SW' || suf === 'VX')) ||
        (hint.country === 'GB' && suf === 'L') ||
        (hint.country === 'FR' && suf === 'PA') ||
        (hint.country === 'DE' && (suf === 'DE' || suf === 'F')) ||
        (hint.country === 'CA' && (suf === 'TO' || suf === 'V')) ||
        sufCcy
      ) {
        score += 2;
      }
    }
    // US listings (no suffix) are fine for US issuers and ADRs.
    if (!suf && (hint?.country === 'US' || !hint?.country)) score += 1;
    return { h, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].h;
}

/**
 * Resolve an instrument identifier to a canonical Yahoo symbol + metadata.
 * Tiers: explicit ticker → symbol_map cache → curated seed → Yahoo search → unresolved.
 */
export async function resolveSymbol(ident: {
  isin?: string | null;
  name?: string | null;
  symbol?: string | null;
}): Promise<ResolvedSymbol> {
  const isin = ident.isin?.toUpperCase() || null;
  const isinCountry = countryFromIsin(isin);

  // 0) An explicit, real ticker provided by the caller (manual add / good import symbol).
  if (looksLikeTicker(ident.symbol ?? undefined, isin)) {
    const r: ResolvedSymbol = {
      symbol: ident.symbol!.trim(),
      currency: 'USD',
      kind: 'stock',
      country: isinCountry,
      name: ident.name ?? null,
      source: 'manual',
      unresolved: false,
    };
    return r;
  }

  // 1) Permanent cache.
  if (isin) {
    const cached = getMap.get(isin) as any;
    if (cached) {
      return {
        symbol: cached.symbol,
        currency: (cached.currency ?? 'USD') as Currency,
        kind: (cached.kind ?? 'stock') as InstrumentKind,
        country: cached.country ?? isinCountry,
        name: cached.name ?? ident.name ?? null,
        exchange: cached.exchange ?? null,
        source: cached.source ?? 'yahoo',
        unresolved: false,
      };
    }
  }

  // 2) Curated seed (offline, deterministic).
  const curated = curatedResolve(isin);
  if (curated) {
    const r: ResolvedSymbol = {
      symbol: curated.symbol,
      currency: curated.currency,
      kind: curated.kind,
      country: curated.country ?? isinCountry,
      name: ident.name ?? null,
      source: 'curated',
      unresolved: false,
    };
    persist(isin, r);
    return r;
  }

  // 3) Yahoo search (rate-limited, cached once resolved).
  const query = isin || ident.name || ident.symbol || '';
  let hits = await searchSymbol(query);
  if (!hits.length && ident.name && ident.name !== query) {
    hits = await searchSymbol(ident.name);
  }
  const best = pickBest(hits, { country: isinCountry });
  if (best) {
    const suf = suffixOf(best.symbol);
    const r: ResolvedSymbol = {
      symbol: best.symbol,
      currency: (best.currency ?? (suf ? SUFFIX_CCY[suf] : undefined) ?? 'USD') as Currency,
      kind: best.kind,
      country: isinCountry,
      name: best.name ?? ident.name ?? null,
      exchange: best.exchange ?? null,
      source: 'yahoo',
      unresolved: false,
    };
    persist(isin, r);
    return r;
  }

  // 4) Unresolved: keep a slug so the row is creatable, but flag it so the UI shows a
  //    "no live data" badge and a later re-resolve pass can retry.
  const slug = (isin || ident.name || ident.symbol || 'UNKNOWN')
    .replace(/\s+/g, '-')
    .toUpperCase()
    .slice(0, 24);
  return {
    symbol: slug,
    currency: 'USD',
    kind: 'stock',
    country: isinCountry,
    name: ident.name ?? null,
    source: 'unresolved',
    unresolved: true,
  };
}
