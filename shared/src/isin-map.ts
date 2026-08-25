import type { Currency, InstrumentKind } from './types';

/**
 * Curated ISIN → Yahoo symbol seed. This is the tier-1 resolver: it maps ISINs to
 * their canonical Yahoo ticker deterministically, without a network call, so the
 * portfolio reconciles even when Yahoo's search endpoint is rate-limiting.
 *
 * `country` overrides the ISIN-prefix domicile only where the listing country differs
 * from the operating company's country (e.g. a US-listed ADR of a French company).
 * Entries are best-effort and always user-correctable via the instrument editor.
 */
export interface CuratedInstrument {
  symbol: string;
  currency: Currency;
  kind: InstrumentKind;
  country?: string; // globe/HQ country override (else derived from ISIN prefix)
}

export const CURATED_ISIN_MAP: Record<string, CuratedInstrument> = {
  // --- Swiss blue chips (SIX, CHF) ---
  CH0038863350: { symbol: 'NESN.SW', currency: 'CHF', kind: 'stock' }, // Nestlé
  CH0012005267: { symbol: 'NOVN.SW', currency: 'CHF', kind: 'stock' }, // Novartis
  CH0012032048: { symbol: 'ROG.SW', currency: 'CHF', kind: 'stock' }, // Roche
  CH0002178181: { symbol: 'SRAIL.SW', currency: 'CHF', kind: 'stock' }, // Stadler Rail
  CH0012255144: { symbol: 'UHR.SW', currency: 'CHF', kind: 'stock' }, // Swatch
  CH0009002962: { symbol: 'BARN.SW', currency: 'CHF', kind: 'stock' }, // Barry Callebaut

  // --- US large caps (bare Yahoo symbols, USD) ---
  US0846707026: { symbol: 'BRK-B', currency: 'USD', kind: 'stock' }, // Berkshire B
  US6541061031: { symbol: 'NKE', currency: 'USD', kind: 'stock' }, // Nike B
  US22041X1028: { symbol: 'CRSR', currency: 'USD', kind: 'stock' }, // Corsair
  US0079031078: { symbol: 'AMD', currency: 'USD', kind: 'stock' }, // AMD
  US04342Y1047: { symbol: 'ASAN', currency: 'USD', kind: 'stock' }, // Asana
  US30303M1027: { symbol: 'META', currency: 'USD', kind: 'stock' }, // Meta
  US67066G1040: { symbol: 'NVDA', currency: 'USD', kind: 'stock' }, // Nvidia
  US7170811035: { symbol: 'PFE', currency: 'USD', kind: 'stock' }, // Pfizer
  US4592001014: { symbol: 'IBM', currency: 'USD', kind: 'stock' }, // IBM
  US8740541094: { symbol: 'TTWO', currency: 'USD', kind: 'stock' }, // Take-Two
  US87612E1064: { symbol: 'TGT', currency: 'USD', kind: 'stock' }, // Target
  US9113121068: { symbol: 'UPS', currency: 'USD', kind: 'stock' }, // UPS B
  US91324P1021: { symbol: 'UNH', currency: 'USD', kind: 'stock' }, // UnitedHealth
  US26817Q8868: { symbol: 'DX', currency: 'USD', kind: 'stock' }, // Dynex Capital
  US80105N1054: { symbol: 'SNY', currency: 'USD', kind: 'stock', country: 'FR' }, // Sanofi ADR

  // --- European listings ---
  FR0000120578: { symbol: 'SAN.PA', currency: 'EUR', kind: 'stock' }, // Sanofi (Paris)
  FR0000120172: { symbol: 'CA.PA', currency: 'EUR', kind: 'stock' }, // Carrefour
  DE0008232125: { symbol: 'LHA.DE', currency: 'EUR', kind: 'stock' }, // Lufthansa
  DE000A1ML7J1: { symbol: 'VNA.DE', currency: 'EUR', kind: 'stock' }, // Vonovia
  CA21037X1006: { symbol: 'CSU.TO', currency: 'CAD', kind: 'stock' }, // Constellation Software
  CA38210L1094: { symbol: 'GDNP.V', currency: 'CAD', kind: 'stock' }, // Good Natured Products

  // --- Else Nutrition (multi-ISIN corporate actions all resolve to the live line) ---
  CA2902576099: { symbol: 'BABY.V', currency: 'CAD', kind: 'stock' },
  CA2902575000: { symbol: 'BABY.V', currency: 'CAD', kind: 'stock' },
  CA2902571041: { symbol: 'BABY.V', currency: 'CAD', kind: 'stock' },

  // --- UCITS ETFs (Irish domicile, London USD lines) ---
  IE00BFMXXD54: { symbol: 'VUAA.L', currency: 'USD', kind: 'etf' }, // Vanguard S&P 500 acc
  IE00BK5BQT80: { symbol: 'VWRA.L', currency: 'USD', kind: 'etf' }, // Vanguard FTSE All-World acc
  IE00B53SZB19: { symbol: 'CNDX.L', currency: 'USD', kind: 'etf' }, // iShares Nasdaq 100 acc
  IE00B6R52259: { symbol: 'SSAC.L', currency: 'USD', kind: 'etf' }, // iShares MSCI ACWI acc
  CH0017142719: { symbol: 'SMMCHA.SW', currency: 'CHF', kind: 'etf' }, // UBS ETF SMI (best-effort)

  // Delisted / liquidated instruments are intentionally omitted so they surface as
  // "no live data" rather than resolving to a wrong ticker:
  //   KYG7397A1067 Razer (privatised), KYG825141032 / KYG8251L1059 Social Capital SPACs
  //   (liquidated), US87663X1028 Tattooed Chef (bankrupt).
};

export function curatedResolve(isin: string | null | undefined): CuratedInstrument | null {
  if (!isin) return null;
  return CURATED_ISIN_MAP[isin.toUpperCase()] ?? null;
}
