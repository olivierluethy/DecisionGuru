// Core domain types shared between frontend and backend.

export type Currency = 'CHF' | 'USD' | 'EUR' | 'GBP' | (string & {});

export type InstrumentKind = 'stock' | 'etf';

export type TxAction = 'buy' | 'sell' | 'dividend';

/** A tradable instrument (stock or fund). */
export interface Instrument {
  id: number;
  symbol: string; // Yahoo symbol, e.g. AAPL, VWRL.SW
  isin?: string | null;
  name: string;
  kind: InstrumentKind;
  currency: Currency; // trading currency
  domicile?: string | null; // issuer/fund domicile ISO country (US, IE, CH...)
  exchange?: string | null;
  country?: string | null; // HQ / primary country for the globe
  sector?: string | null;
  /** Manual override of income (dividend) yield used for the tax drag, fraction e.g. 0.018 */
  incomeYieldOverride?: number | null;
  /** Manual JSON allocation override for globe/breakdown when market data is missing */
  allocationOverride?: AllocationBreakdown | null;
  /** How `symbol` was resolved: 'curated' | 'yahoo' | 'manual' | 'unresolved'. */
  resolutionSource?: string | null;
  /** True when we could not resolve a real ticker (symbol still equals the ISIN / a slug). */
  unresolved?: boolean | null;
  createdAt: string;
}

/** Per-instrument market-data health, surfaced as a badge in the UI. */
export interface InstrumentDataStatus {
  /** 'ok' | 'stale' | 'pricing' | 'unresolved' | 'no-data' */
  state: 'ok' | 'stale' | 'pricing' | 'unresolved' | 'no-data';
  resolutionSource?: string | null;
  quoteAsOf?: string | null;
  priceCoverageDays?: number | null;
  message?: string | null;
}

/** A single cash-flow event against an instrument. */
export interface Transaction {
  id: number;
  instrumentId: number;
  action: TxAction;
  date: string; // ISO yyyy-mm-dd
  quantity: number; // shares (buy/sell); for dividend, shares held is informational
  unitPrice: number; // price per share in tx currency (0 allowed for dividend rows)
  fees: number; // in tx currency
  currency: Currency; // transaction currency
  /** Gross cash amount in tx currency (for dividends: gross dividend). Optional; derivable. */
  grossAmount?: number | null;
  /** Net cash amount in tx currency after fees/withholding, if the broker gives it. */
  netAmount?: number | null;
  /** For dividends: withholding tax already deducted at source, tx currency. */
  withholding?: number | null;
  /** 'trade' for ordinary buys/sells, 'corporate_action' for swaps/delistings (excluded from P/L). */
  category?: TxCategory | null;
  note?: string | null;
  source?: string | null; // import batch / 'manual'
  createdAt: string;
}

export type TxCategory = 'trade' | 'corporate_action';

/** Derived holding for an instrument given its transactions. */
export interface Position {
  instrument: Instrument;
  openQuantity: number;
  /** Weighted average cost per share (tx currency) of the open lot. */
  avgCost: number;
  investedOriginal: number; // sum of buy cost (tx ccy) for still-open + closed basis
  investedCHF: number; // invested capital converted at historical FX
  currentPrice: number | null; // latest quote, tx ccy
  currentValueCHF: number | null;
  realizedCHF: number; // realized P/L from sells (CHF)
  unrealizedCHF: number | null;
  dividends: DividendSummary;
  metrics: PositionMetrics;
  priceAsOf?: string | null;
  stale?: boolean;
  dataStatus?: InstrumentDataStatus;
  /** Net dividends (CHF) for this holding — from the account statement when available. */
  netDividendsCHF?: number;
  /** Per-ISIN dividend detail from the account statement, when present. */
  accountDividends?: AccountDividend | null;
  /** Share of portfolio market value (0..1). */
  weight?: number;
}

export type RangeKey = '1D' | '30D' | '1M' | '2M' | '5M' | '6M' | '1Y' | '2Y' | '5Y' | 'MAX';

export interface RangeStats {
  high: number;
  low: number;
  start: number;
  end: number;
  changeAbs: number;
  changePct: number | null;
}

/** A value-over-time series sliced to a range, with summary stats for the range. */
export interface RangeSeries {
  range: RangeKey;
  points: Array<{ date: string; value: number }>;
  stats: RangeStats | null;
}

/** Net dividend aggregation for one security, from the DEGIRO account statement. */
export interface AccountDividend {
  isin: string;
  name?: string | null;
  currency: string;
  grossOrig: number;
  taxOrig: number;
  grossCHF: number;
  taxCHF: number;
  netCHF: number;
  count: number;
}

export interface DividendSummary {
  grossCHF: number;
  swissWithholdingCHF: number;
  foreignWithholdingCHF: number;
  incomeTaxCHF: number;
  netAfterTaxCHF: number;
  count: number;
}

export interface PositionMetrics {
  absolutePLChf: number | null; // after-tax total P/L incl dividends
  absolutePLChfPreTax: number | null;
  percentPL: number | null;
  xirr: number | null; // money-weighted, after-tax
  cagr: number | null;
  currentYield: number | null; // trailing dividend yield fraction
  wealthTaxCHF: number;
}

/** Result of comparing an actual holding to a benchmark ETF. */
export interface CounterfactualResult {
  benchmarkSymbol: string;
  benchmarkName: string;
  actualValueCHF: number; // after-tax actual (market value + net divs - wealth tax)
  counterfactualValueCHF: number; // after-tax value had cash gone into the ETF
  deltaCHF: number; // actual - counterfactual  (negative = ETF would have won)
  deltaPct: number; // delta / counterfactual
  actualPreTaxCHF: number;
  counterfactualPreTaxCHF: number;
  actualXirr: number | null;
  benchmarkXirr: number | null;
  /** Aligned time series for the delta chart. */
  series: CounterfactualPoint[];
  /** Months for the ETF to recover the current shortfall vs holding, if applicable. */
  recoveryMonths: number | null;
}

export interface CounterfactualPoint {
  date: string;
  actualCHF: number; // value of actual holding over time (after-tax basis)
  benchmarkCHF: number; // value of counterfactual ETF over time
}

/** A time-series point for projections/curves. */
export interface ProjectionPoint {
  date: string;
  hold: number; // projected value holding the stock
  etf: number; // projected value if switched to ETF
}

export interface ProjectionResult {
  points: ProjectionPoint[];
  assumedStockCagr: number;
  assumedEtfCagr: number;
  years: number;
  /** Crossover month index where etf overtakes hold, if any. */
  crossoverMonth: number | null;
}

/** Hypothetical "sell this stock and reinvest the proceeds into an ETF" outcome. */
export interface WhatIfSaleResult {
  benchmark: string;
  benchmarkName: string;
  /** The hypothetical sale date (may be in the past or today). */
  saleDate: string;
  /** Instrument trading currency. */
  currency: string;
  /** Shares held on the sale date. */
  quantityHeld: number;
  /** Assumed per-share sale price, in the instrument currency. */
  salePrice: number;
  /** Net CHF proceeds implied by the sale price. */
  proceedsCHF: number;
  /** CHF actually put into the ETF (defaults to proceeds; user-adjustable). */
  reinvestAmountCHF: number;
  etfUnits: number;
  /** Value today of the reinvested-into-ETF path. */
  etfValueTodayCHF: number;
  /** Value today had you kept the shares. */
  holdValueTodayCHF: number;
  /** etfValueTodayCHF − holdValueTodayCHF (positive = selling would have won). */
  deltaCHF: number;
  deltaPct: number;
  /** Aligned hold-vs-ETF series from the sale date to today. */
  series: CounterfactualPoint[];
  /** Forward outlook compounding each path from its value today. */
  forward: ProjectionResult | null;
}

export interface BreakEvenResult {
  realizedLossCHF: number;
  etfCagr: number;
  monthsToRecover: number | null;
  targetValueCHF: number;
}

// ---- Tax settings ------------------------------------------------------

export interface TaxSettings {
  professionalTrader: boolean;
  capitalGainsTaxable: boolean;
  marginalIncomeRate: number; // fraction, e.g. 0.30
  federalRate?: number | null;
  cantonalRate?: number | null;
  municipalMultiplier?: number | null;
  defaultEtfIncomeYield: number; // fraction
  swissWithholdingRate: number; // 0.35
  swissWithholdingReclaimed: boolean;
  reclaimDelayMonths: number;
  applyReclaimTimeValue: boolean;
  foreignWithholdingUS: number; // 0.15
  foreignReclaimFractionUS: number; // 1.0
  foreignWithholdingGeneric: number; // 0.15
  foreignReclaimFractionGeneric: number; // 0.0
  wealthTaxRate: number; // 0.003 per year
  stampDutyRate: number; // 0 default
  baseCurrency: Currency; // 'CHF'
}

export interface AppSettings {
  tax: TaxSettings;
  benchmarks: BenchmarkEtf[];
  defaultBenchmarkSymbol: string;
}

export interface BenchmarkEtf {
  symbol: string;
  name: string;
  currency: Currency;
  domicile: string;
  incomeYield: number; // fraction, income component for tax drag
  accumulating: boolean;
}

// ---- Globe / allocation ------------------------------------------------

export interface AllocationBreakdown {
  countries: AllocationSlice[];
  sectors: AllocationSlice[];
  topHoldings: HoldingSlice[];
  source: 'fund' | 'stock' | 'manual';
}

export interface AllocationSlice {
  key: string; // country code or sector name
  label: string;
  weight: number; // fraction 0..1
  lat?: number;
  lng?: number;
}

export interface HoldingSlice {
  symbol?: string;
  name: string;
  weight: number;
  country?: string;
  lat?: number;
  lng?: number;
}

// ---- Scenarios ---------------------------------------------------------

export interface Scenario {
  id: number;
  name: string;
  config: ScenarioConfig;
  createdAt: string;
  updatedAt: string;
}

export interface ScenarioConfig {
  includedInstrumentIds: number[];
  benchmarkSymbol: string;
  /** whole-portfolio "sell all -> ETF" mode */
  sellAllToEtf: boolean;
  expectedStockCagr?: number | null;
  expectedEtfCagr?: number | null;
  projectionYears?: number;
  preTax?: boolean;
  /** Only count transactions on/after this date (evaluate a chosen holding period). */
  fromDate?: string | null;
  /** Evaluate the basket as of this date instead of today. */
  asOf?: string | null;
}

export interface ScenarioResult {
  scenario: ScenarioConfig;
  perPosition: Array<{ instrumentId: number; symbol: string; counterfactual: CounterfactualResult }>;
  aggregate: {
    actualValueCHF: number;
    counterfactualValueCHF: number;
    deltaCHF: number;
    deltaPct: number;
    series: CounterfactualPoint[];
  };
}

// ---- Notes -------------------------------------------------------------

export type NoteTarget = 'instrument' | 'scenario' | 'portfolio';

export interface Note {
  id: number;
  target: NoteTarget;
  targetId: number | null; // instrumentId or scenarioId; null for portfolio
  body: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Import ------------------------------------------------------------

export type CanonicalField =
  | 'date'
  | 'action'
  | 'symbol'
  | 'isin'
  | 'name'
  | 'quantity'
  | 'unitPrice'
  | 'fees'
  | 'currency'
  | 'grossAmount'
  | 'netAmount'
  | 'withholding'
  | 'ignore';

/** A recognised broker whose layout is auto-mapped. */
export type DetectedBroker = 'degiro';

/** Which DEGIRO export a parsed file matched. */
export type DetectedKind = 'transactions' | 'account';

/** Normalized DEGIRO account-statement event type. */
export type AccountEventType =
  | 'deposit'
  | 'cash_sweep'
  | 'fx_conversion'
  | 'dividend'
  | 'withholding_tax'
  | 'corp_action_fee'
  | 'connectivity_fee'
  | 'unknown';

export interface AccountEvent {
  date: string | null;
  time?: string;
  valueDate?: string | null;
  name?: string | null;
  isin?: string | null;
  description?: string;
  type: AccountEventType;
  fx?: number | null;
  currency?: string | null;
  amount: number;
  balanceCurrency?: string | null;
  balance?: number | null;
  orderId?: string | null;
  reversed?: boolean;
  dedupeKey?: string;
}

export interface AccountPreviewRow {
  ok: boolean;
  errors: string[];
  type: AccountEventType;
  label: string;
  event: AccountEvent;
}

export interface AccountPreviewResponse {
  kind: 'account';
  rows: AccountPreviewRow[];
  okCount: number;
  total: number;
  byType: Partial<Record<AccountEventType, number>>;
  unknownCount: number;
  reversedCount: number;
}

export interface AccountCommitResponse {
  kind: 'account';
  importedEvents: number;
  skipped: number;
  linked: number;
  dividends: number;
  summary: {
    counts: Partial<Record<AccountEventType, number>>;
    unknown: AccountEvent[];
    unknownCount: number;
    reversedCount: number;
    total: number;
  };
}

export interface BrokerMappingRow {
  header: string; // the broker's own column header (may be '(currency)' for the empty ones)
  field: string; // canonical field it binds to
  note?: string;
}

export interface ParsedFile {
  fileId: string;
  filename: string;
  sheets: ParsedSheet[];
  /** Non-null when the file's header matches a known broker signature. */
  detectedBroker?: DetectedBroker | null;
  /** Which DEGIRO export this file matched, when recognised. */
  detectedKind?: DetectedKind | null;
  brokerName?: string; // display label, e.g. "DeGiro — Transactions export"
  brokerMapping?: BrokerMappingRow[]; // read-only mapping to show immediately
  encoding?: string; // 'utf-8' | 'windows-1252'
}

export interface ParsedSheet {
  name: string;
  headers: string[]; // display headers (empty ones renamed)
  rawHeaders: string[]; // original headers, empty positions preserved
  rows: string[][]; // raw cell strings
  suggestedMapping: Record<string, CanonicalField>; // header -> field
}

export interface ImportMapping {
  fileId: string;
  sheetName: string;
  headerRowIndex: number;
  mapping: Record<string, CanonicalField>; // header -> canonical field
  /** value strings that denote each action, lowercased */
  actionMap: {
    buy: string[];
    sell: string[];
    dividend: string[];
  };
  dateFormat?: string; // hint, optional
  defaultCurrency?: Currency;
  /** When set, the backend uses the broker's hardcoded parser instead of `mapping`. */
  broker?: DetectedBroker;
  /** When 'account', the backend runs the account-statement transform. */
  kind?: DetectedKind;
}

/** Extra display/derivation fields carried alongside a preview row's tx. */
export interface PreviewTx extends Partial<Transaction> {
  symbol?: string;
  isin?: string;
  name?: string;
  nativePrice?: number | null;
  priceCurrency?: string;
  localCurrency?: string;
  valueCHF?: number | null;
  totalCHF?: number | null;
  referenceExchange?: string;
  executionVenue?: string;
  orderId?: string;
  time?: string;
}

export interface ImportPreviewRow {
  ok: boolean;
  errors: string[];
  category?: TxCategory;
  /** Human label: 'Buy' | 'Sell' | 'ISIN change' | 'Delisting' | 'Class swap' */
  label?: string;
  tx: PreviewTx;
}

export interface ImportPreset {
  id: number;
  name: string;
  mapping: Omit<ImportMapping, 'fileId' | 'sheetName'>;
  createdAt: string;
}

// ---- Market data -------------------------------------------------------

export interface PricePoint {
  date: string; // yyyy-mm-dd
  close: number;
}

export interface Quote {
  symbol: string;
  price: number;
  currency: Currency;
  name?: string;
  time: string;
  stale: boolean;
}

export interface FxRate {
  date: string;
  base: Currency;
  quote: Currency;
  rate: number; // 1 base = rate quote
}

export interface DataStatus {
  source: string;
  asOf: string | null;
  stale: boolean;
}
