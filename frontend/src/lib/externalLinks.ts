/** Outbound research links. Returns null when a reliable URL can't be built, so the caller
 *  hides that destination rather than emit a broken link. */

// Yahoo uses the same suffixed symbol we already store (e.g. NESN.SW, SSAC.L).
export function yahooUrl(symbol?: string | null): string | null {
  if (!symbol) return null;
  return `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;
}

// Google Finance needs TICKER:EXCHANGE. Map the Yahoo suffix → Google exchange code; a
// plain (US) symbol defaults to NASDAQ. Unknown suffix → null (hide the button).
const GOOGLE_EXCHANGE: Record<string, string> = {
  SW: 'SWX', L: 'LON', DE: 'ETR', PA: 'EPA', MI: 'BIT', AS: 'AMS', MC: 'BME',
  TO: 'TSE', T: 'TYO', HK: 'HKG', AX: 'ASX', SS: 'SHA', SZ: 'SHE', KS: 'KRX',
};

export function googleUrl(symbol?: string | null): string | null {
  if (!symbol) return null;
  const dot = symbol.lastIndexOf('.');
  if (dot === -1) return `https://www.google.com/finance/quote/${encodeURIComponent(symbol)}:NASDAQ`;
  const base = symbol.slice(0, dot);
  const suffix = symbol.slice(dot + 1).toUpperCase();
  const exch = GOOGLE_EXCHANGE[suffix];
  if (!base || !exch) return null;
  return `https://www.google.com/finance/quote/${encodeURIComponent(base)}:${exch}`;
}
