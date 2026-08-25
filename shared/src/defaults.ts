import type { AppSettings, BenchmarkEtf, TaxSettings } from './types';

export const DEFAULT_TAX_SETTINGS: TaxSettings = {
  professionalTrader: false,
  capitalGainsTaxable: false,
  marginalIncomeRate: 0.3,
  federalRate: null,
  cantonalRate: null,
  municipalMultiplier: null,
  defaultEtfIncomeYield: 0.018,
  swissWithholdingRate: 0.35,
  swissWithholdingReclaimed: true,
  reclaimDelayMonths: 12,
  applyReclaimTimeValue: false,
  foreignWithholdingUS: 0.15,
  foreignReclaimFractionUS: 1.0,
  foreignWithholdingGeneric: 0.15,
  foreignReclaimFractionGeneric: 0.0,
  wealthTaxRate: 0.003,
  stampDutyRate: 0,
  baseCurrency: 'CHF',
};

/** Default, user-extensible benchmark ETFs (world & S&P class), CHF investor friendly. */
export const DEFAULT_BENCHMARKS: BenchmarkEtf[] = [
  { symbol: 'VWRL.SW', name: 'Vanguard FTSE All-World (dist, CHF-listed)', currency: 'CHF', domicile: 'IE', incomeYield: 0.019, accumulating: false },
  { symbol: 'VT', name: 'Vanguard Total World Stock', currency: 'USD', domicile: 'US', incomeYield: 0.02, accumulating: false },
  { symbol: 'CSPX.L', name: 'iShares Core S&P 500 (acc, UCITS)', currency: 'USD', domicile: 'IE', incomeYield: 0.013, accumulating: true },
  { symbol: 'VWRA.L', name: 'Vanguard FTSE All-World (acc, UCITS)', currency: 'USD', domicile: 'IE', incomeYield: 0.019, accumulating: true },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', currency: 'USD', domicile: 'US', incomeYield: 0.013, accumulating: false },
];

export const DEFAULT_SETTINGS: AppSettings = {
  tax: DEFAULT_TAX_SETTINGS,
  benchmarks: DEFAULT_BENCHMARKS,
  defaultBenchmarkSymbol: 'VWRL.SW',
};
