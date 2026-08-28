// Short exchange code from a Yahoo ticker suffix — a zero-network hint of where a row's
// price trades (the full cross-listing recommendation lives in the opportunity modal).
// Mirrors the backend EXCHANGES map (services/markethours.py); "" = a bare US ticker.
const SUFFIX_EXCHANGE: Record<string, string> = {
  SW: 'SIX', VX: 'SIX', L: 'LSE', DE: 'XETRA', F: 'FRA', PA: 'PAR', AS: 'AMS',
  MI: 'MIL', MC: 'BME', T: 'TSE', HK: 'HKEX', TO: 'TSX', V: 'TSXV', AX: 'ASX', ST: 'STO',
};

/** Short exchange code for a ticker, or null when it can't be inferred from the suffix. */
export function exchangeTag(symbol: string | null | undefined): string | null {
  if (!symbol) return null;
  const parts = symbol.split('.');
  if (parts.length < 2) return 'US'; // bare ticker → US (NYSE/Nasdaq)
  return SUFFIX_EXCHANGE[parts[parts.length - 1].toUpperCase()] ?? null;
}
