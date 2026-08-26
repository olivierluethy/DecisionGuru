import type {
  AppSettings,
  Instrument,
  Transaction,
  Position,
  CounterfactualResult,
  ProjectionResult,
  WhatIfSaleResult,
  BreakEvenResult,
  Scenario,
  ScenarioConfig,
  ScenarioResult,
  Note,
  NoteTarget,
  AllocationBreakdown,
  ParsedFile,
  ImportMapping,
  ImportPreviewRow,
  InstrumentDataStatus,
  RangeKey,
  RangeSeries,
  AccountDividend,
  AccountPreviewResponse,
  AccountCommitResponse,
  AdvisoryResponse,
} from '@decisionguru/shared';

const BASE = '/api';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = body.error ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // settings
  getSettings: () => req<AppSettings>('/settings'),
  saveSettings: (s: Partial<AppSettings>) =>
    req<AppSettings>('/settings', { method: 'PUT', body: JSON.stringify(s) }),
  resetSettings: () => req<AppSettings>('/settings/reset', { method: 'POST' }),

  // instruments
  listInstruments: () => req<Instrument[]>('/instruments'),
  getInstrument: (id: number) => req<Instrument>(`/instruments/${id}`),
  searchSymbol: (q: string) =>
    req<Array<{ symbol: string; name: string; exchange: string; kind: string; type: string }>>(
      `/instruments/search?q=${encodeURIComponent(q)}`,
    ),
  createInstrument: (body: Partial<Instrument>) =>
    req<Instrument>('/instruments', { method: 'POST', body: JSON.stringify(body) }),
  updateInstrument: (id: number, patch: Partial<Instrument>) =>
    req<Instrument>(`/instruments/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteInstrument: (id: number) => req<{ ok: true }>(`/instruments/${id}`, { method: 'DELETE' }),
  instrumentStatus: (id: number) => req<InstrumentDataStatus>(`/instruments/${id}/status`),
  reresolveInstrument: (id: number) =>
    req<Instrument>(`/instruments/${id}/reresolve`, { method: 'POST', body: JSON.stringify({}) }),
  reresolveAll: (offline = false) =>
    req<{ attempted: number; results: unknown[] }>('/instruments/reresolve-all', {
      method: 'POST',
      body: JSON.stringify({ offline }),
    }),
  getTransactions: (id: number) => req<Transaction[]>(`/instruments/${id}/transactions`),
  addManual: (body: Record<string, unknown>) =>
    req<{ instrument: Instrument; transaction: Transaction; derivedPrice: number }>('/instruments/manual', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // transactions
  addTransaction: (body: Partial<Transaction>) =>
    req<Transaction>('/transactions', { method: 'POST', body: JSON.stringify(body) }),
  deleteTransaction: (id: number) => req<{ ok: true }>(`/transactions/${id}`, { method: 'DELETE' }),

  // analysis
  position: (id: number, preTax = false) =>
    req<Position>(`/analysis/position/${id}?preTax=${preTax}`),
  counterfactual: (id: number, benchmark?: string, preTax = false) =>
    req<CounterfactualResult>(
      `/analysis/counterfactual/${id}?preTax=${preTax}${benchmark ? `&benchmark=${benchmark}` : ''}`,
    ),
  breakeven: (id: number, benchmark?: string) =>
    req<BreakEvenResult & { benchmark: string }>(
      `/analysis/breakeven/${id}${benchmark ? `?benchmark=${benchmark}` : ''}`,
    ),
  projection: (id: number, opts: { benchmark?: string; years?: number; stockCagr?: number; etfCagr?: number }) => {
    const p = new URLSearchParams();
    if (opts.benchmark) p.set('benchmark', opts.benchmark);
    if (opts.years != null) p.set('years', String(opts.years));
    if (opts.stockCagr != null) p.set('stockCagr', String(opts.stockCagr));
    if (opts.etfCagr != null) p.set('etfCagr', String(opts.etfCagr));
    return req<ProjectionResult & { benchmark: string }>(`/analysis/projection/${id}?${p}`);
  },
  whatifSale: (
    id: number,
    opts: {
      benchmark?: string;
      saleDate?: string;
      salePrice?: number;
      reinvestAmount?: number;
      preTax?: boolean;
      years?: number;
    },
  ) => {
    const p = new URLSearchParams();
    if (opts.benchmark) p.set('benchmark', opts.benchmark);
    if (opts.saleDate) p.set('saleDate', opts.saleDate);
    if (opts.salePrice != null) p.set('salePrice', String(opts.salePrice));
    if (opts.reinvestAmount != null) p.set('reinvestAmount', String(opts.reinvestAmount));
    if (opts.preTax != null) p.set('preTax', String(opts.preTax));
    if (opts.years != null) p.set('years', String(opts.years));
    return req<WhatIfSaleResult>(`/analysis/whatif/${id}?${p}`);
  },
  dividendShock: (id: number, cut: number) =>
    req<{
      currentAnnualGrossCHF: number;
      shockedAnnualGrossCHF: number;
      lostGrossCHF: number;
      lostNetAfterTaxCHF: number;
      cut: number;
    }>(`/analysis/dividend-shock/${id}?cut=${cut}`),
  portfolio: (benchmark?: string, preTax = false) =>
    req<PortfolioResponse>(
      `/analysis/portfolio?preTax=${preTax}${benchmark ? `&benchmark=${benchmark}` : ''}`,
    ),
  advisory: (includeHandled = false) =>
    req<AdvisoryResponse>(`/analysis/advisory?includeHandled=${includeHandled}`),
  setAdvisoryHandled: (id: number, handled: boolean) =>
    req<{ ok: true; handled: number[] }>(`/analysis/advisory/${id}/handled`, {
      method: 'POST',
      body: JSON.stringify({ handled }),
    }),
  portfolioSeries: (range: RangeKey = '1Y') =>
    req<RangeSeries>(`/analysis/portfolio/series?range=${range}`),
  timeline: () => req<TimelineResponse>('/analysis/timeline'),
  instrumentSeries: (id: number, range: RangeKey = '1Y') =>
    req<RangeSeries>(`/analysis/series/${id}?range=${range}`),
  compare: (instrumentIds: number[], benchmarks: string[], preTax = false) =>
    req<CompareResponse>('/analysis/compare', {
      method: 'POST',
      body: JSON.stringify({ instrumentIds, benchmarks, preTax }),
    }),

  // data management
  resetData: (keepResolutions = true) =>
    req<{ ok: true; cleared: string[]; keptResolutions: boolean }>('/data/reset', {
      method: 'POST',
      body: JSON.stringify({ keepResolutions }),
    }),

  // market
  allocation: (instrumentId: number) => req<AllocationBreakdown>(`/market/allocation/${instrumentId}`),
  quote: (symbol: string) => req<{ symbol: string; price: number; currency: string; name: string; stale: boolean }>(`/market/quote/${symbol}`),
  news: (symbol: string, limit = 12) => req<NewsResponse>(`/market/news/${encodeURIComponent(symbol)}?limit=${limit}`),
  marketHours: () => req<{ exchanges: ExchangeStatus[] }>('/market/hours'),
  marketHoursSymbol: (symbol: string) => req<ExchangeStatus>(`/market/hours/${encodeURIComponent(symbol)}`),
  movements: (symbol: string, from?: string) =>
    req<MovementsResponse>(`/market/movements/${encodeURIComponent(symbol)}${from ? `?from=${from}` : ''}`),
  marketHistory: (symbol: string, from?: string, to?: string) => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    const qs = p.toString();
    return req<Array<{ date: string; close: number }>>(
      `/market/history/${encodeURIComponent(symbol)}${qs ? `?${qs}` : ''}`,
    );
  },

  // decision engine
  recommendations: () => req<RecommendationsResponse>('/decisions/recommendations'),
  recovery: (id: number, horizon = 5, alternatives?: string[]) =>
    req<RecoveryResponse>(
      `/decisions/recovery/${id}?horizon=${horizon}${alternatives?.length ? `&alternatives=${alternatives.join(',')}` : ''}`,
    ),
  simulate: (body: { sellInstrumentIds: number[]; targets: ReinvestTarget[]; horizonYears?: number }) =>
    req<SimulateResponse>('/decisions/simulate', { method: 'POST', body: JSON.stringify(body) }),
  exposure: () => req<PortfolioExposure>('/decisions/exposure'),
  exposureCompare: (a: number, b: number) => req<ExposureComparison>(`/decisions/exposure/compare?a=${a}&b=${b}`),

  // decision plans
  listPlans: () => req<DecisionPlan[]>('/plans'),
  getPlan: (id: number) => req<DecisionPlan>(`/plans/${id}`),
  createPlan: (name: string, config: PlanConfig) =>
    req<DecisionPlan>('/plans', { method: 'POST', body: JSON.stringify({ name, config }) }),
  updatePlan: (id: number, patch: { name?: string; config?: PlanConfig; status?: string }) =>
    req<DecisionPlan>(`/plans/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deletePlan: (id: number) => req<{ ok: true }>(`/plans/${id}`, { method: 'DELETE' }),
  comparePlan: (id: number) => req<PlanComparison>(`/plans/${id}/compare`),

  // research
  researchAsset: (symbol: string, window = 5) =>
    req<ResearchAsset>(`/research/asset/${encodeURIComponent(symbol)}?window=${window}`),
  validateClaim: (symbol: string, claim: string | ClaimSpec) =>
    req<ClaimResult>('/research/claim', { method: 'POST', body: JSON.stringify({ symbol, claim }) }),
  universalCompare: (entities: CompareEntity[], windowYears = 5) =>
    req<UniversalCompareResponse>('/research/compare', {
      method: 'POST',
      body: JSON.stringify({ entities, windowYears }),
    }),

  // scenarios
  listScenarios: () => req<Scenario[]>('/scenarios'),
  runScenario: (config: ScenarioConfig) =>
    req<ScenarioResult>('/scenarios/run', { method: 'POST', body: JSON.stringify(config) }),
  createScenario: (name: string, config: ScenarioConfig) =>
    req<Scenario>('/scenarios', { method: 'POST', body: JSON.stringify({ name, config }) }),
  updateScenario: (id: number, name: string, config: ScenarioConfig) =>
    req<Scenario>(`/scenarios/${id}`, { method: 'PUT', body: JSON.stringify({ name, config }) }),
  deleteScenario: (id: number) => req<{ ok: true }>(`/scenarios/${id}`, { method: 'DELETE' }),

  // notes
  listNotes: (target: NoteTarget, targetId: number | null) =>
    req<Note[]>(`/notes?target=${target}${targetId != null ? `&targetId=${targetId}` : ''}`),
  addNote: (target: NoteTarget, targetId: number | null, body: string) =>
    req<Note>('/notes', { method: 'POST', body: JSON.stringify({ target, targetId, body }) }),
  updateNote: (id: number, body: string) =>
    req<Note>(`/notes/${id}`, { method: 'PATCH', body: JSON.stringify({ body }) }),
  deleteNote: (id: number) => req<{ ok: true }>(`/notes/${id}`, { method: 'DELETE' }),

  // import
  uploadFile: async (file: File): Promise<ParsedFile & { defaultActionMap: ImportMapping['actionMap'] }> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${BASE}/imports/upload`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Upload failed');
    return res.json();
  },
  previewImport: (mapping: ImportMapping) =>
    req<{ rows: ImportPreviewRow[]; okCount: number; total: number; trades: number; corporateActions: number }>(
      '/imports/preview',
      { method: 'POST', body: JSON.stringify(mapping) },
    ),
  commitImport: (mapping: ImportMapping) =>
    req<{ imported: number; skipped: number; corporateActions: number; instruments: number[] }>('/imports/commit', {
      method: 'POST',
      body: JSON.stringify(mapping),
    }),
  previewAccount: (mapping: ImportMapping) =>
    req<AccountPreviewResponse>('/imports/preview', { method: 'POST', body: JSON.stringify(mapping) }),
  commitAccount: (mapping: ImportMapping) =>
    req<AccountCommitResponse>('/imports/commit', { method: 'POST', body: JSON.stringify(mapping) }),

  // export
  exportUrl: (kind: 'excel' | 'pdf') => `${BASE}/export/${kind}`,
};

export interface PortfolioResponse {
  benchmark: string;
  preTax: boolean;
  positions: Position[];
  counterfactuals: Array<{ instrumentId: number; symbol: string; counterfactual: CounterfactualResult }>;
  aggregate: {
    actualValueCHF: number;
    counterfactualValueCHF: number;
    deltaCHF: number;
    deltaPct: number;
    series: CounterfactualResult['series'];
  };
  totals: {
    investedCHF: number;
    currentValueCHF: number;
    realizedCHF: number;
    unrealizedCHF: number;
    netDividendsCHF: number;
    absolutePLChf: number;
    /** Gesamtgewinn = realized + unrealized + net dividends. */
    totalGainCHF: number;
    depositsCHF: number;
    feesCHF: number;
  };
  /** Kontoguthaben — cash by currency and combined CHF headline. */
  cash: {
    totalCHF: number;
    byCurrency: Record<string, { amount: number; chf: number }>;
  };
  /** Net dividend history by security (from the account statement), richest first. */
  accountDividends: AccountDividend[];
  hasPositions: boolean;
  hasAccount: boolean;
  unknownEvents: number;
  /** ISO timestamp of the oldest quote among held positions ("prices as of"). */
  quotesUpdatedAt: string | null;
  /** True while the background pool is refreshing quotes/history. */
  refreshInProgress: boolean;
}

export type TimelineKind = 'deposit' | 'dividend' | 'fee' | 'buy' | 'sell';

export interface TimelineEvent {
  date: string;
  time: string | null;
  kind: TimelineKind;
  category: 'cash' | 'trade';
  title: string;
  instrumentName: string | null;
  isin: string | null;
  symbol: string | null;
  /** Signed CHF cash effect: + money in, − money out. */
  amountCHF: number;
  quantity: number | null;
}

export interface TimelineResponse {
  events: TimelineEvent[];
  count: number;
}

export interface CompareResponse {
  preTax: boolean;
  instrumentIds: number[];
  positions: Position[];
  comparisons: Array<{
    benchmark: string;
    benchmarkName: string;
    aggregate: {
      actualValueCHF: number;
      counterfactualValueCHF: number;
      deltaCHF: number;
      deltaPct: number;
      series: CounterfactualResult['series'];
    };
    perPosition: Array<{ instrumentId: number; symbol: string; name?: string; counterfactual: CounterfactualResult }>;
  }>;
}

// ---- News ----------------------------------------------------------------
export interface NewsItem {
  id: string;
  symbol: string;
  title: string;
  publisher: string | null;
  link: string | null;
  publishedAt: string | null;
  summary: string | null;
}
export interface NewsResponse {
  symbol: string;
  items: NewsItem[];
  stale: boolean;
  fetchedAt: number | null;
}

// ---- Market hours --------------------------------------------------------
export interface ExchangeStatus {
  code: string;
  name: string;
  country: string;
  tz: string;
  localTime: string;
  localDate: string;
  open: string;
  close: string;
  isOpen: boolean;
  nextChange: 'opens' | 'closes';
  minutesToNextChange: number;
  /** Whole seconds until the next open/close, at the moment the server replied. */
  secondsToNextChange: number;
  /** Absolute instant of the next state change (UTC ISO) — tick a live countdown against this. */
  nextChangeAt: string;
  /** Server clock at reply time (UTC ISO) — lets the client correct for clock skew. */
  serverNowUtc: string;
}

// ---- Movements -----------------------------------------------------------
export interface MovementLeg {
  kind: 'surge' | 'drop';
  from: string;
  to: string;
  startClose: number;
  endClose: number;
  changePct: number;
  days: number;
}
export interface StagnationWindow {
  kind: 'stagnation';
  from: string;
  to: string;
  changePct: number;
  days: number;
}
export interface MovementsResponse {
  legs: MovementLeg[];
  stagnation: StagnationWindow[];
  coverage: { from: string; to: string; points: number } | null;
}

// ---- Recommendations -----------------------------------------------------
export type RecAction = 'buy' | 'hold' | 'sell' | 'trim';
export interface ReinvestTarget {
  symbol: string;
  name: string;
  allocationPct: number;
  amountCHF: number;
}
export interface Recommendation {
  instrumentId: number;
  symbol: string;
  name: string;
  isin: string | null;
  kind: string | null;
  action: RecAction;
  conviction: 'high' | 'medium' | 'low';
  investedCHF: number;
  currentValueCHF: number;
  weight: number;
  holdingReturnPct: number | null;
  holdingCagr: number | null;
  holdingXirr: number | null;
  benchmarkSymbol: string;
  benchmarkName: string;
  benchmarkReturnPct: number | null;
  opportunityCostCHF: number;
  recoveryMonths: number | null;
  impactCHF: number;
  sinceDate: string;
  reason: string;
}
export interface CashSignal {
  action: 'buy';
  cashCHF: number;
  symbol: string;
  name: string;
  allocationPct: number;
  amountCHF: number;
  reason: string;
}
export interface RecommendationsResponse {
  recommendations: Recommendation[];
  cashSignal: CashSignal | null;
  summary: {
    counts: Record<RecAction, number>;
    reallocatableCHF: number;
    totalOpportunityCostCHF: number;
    portfolioValueCHF: number;
    idleCashCHF: number;
  };
}

// ---- Recovery / simulate -------------------------------------------------
export interface RecoveryAlternative {
  symbol: string;
  name: string;
  cagr: number | null;
  recoveryYears: number | null;
  expectedValueCHF: number;
}
export interface RecoveryCombo {
  targets: Array<{ symbol: string; name: string; cagr: number | null; allocationPct: number; amountCHF: number }>;
  recoveryYears: number | null;
  expectedValueCHF: number;
  blendedCagr: number;
}
export interface RecoveryResponse {
  instrumentId: number;
  symbol: string;
  name: string;
  investedCHF: number;
  currentValueCHF: number;
  proceedsCHF: number;
  targetCHF: number;
  horizonYears: number;
  holdCagr: number | null;
  holdReturnPct: number | null;
  holdExpectedValueCHF: number;
  alternatives: RecoveryAlternative[];
  fastest: RecoveryAlternative | null;
  singleBest: RecoveryAlternative | null;
  combinations: RecoveryCombo[];
}
export interface SimulateResponse {
  sold: Array<{ instrumentId: number; symbol: string; name: string; proceedsCHF: number; cagr: number | null }>;
  targets: Array<ReinvestTarget & { cagr: number | null; expectedValueCHF: number }>;
  proceedsCHF: number;
  investedCHF: number;
  horizonYears: number;
  reinvestExpectedValueCHF: number;
  holdValueNowCHF: number;
  holdExpectedValueCHF: number;
  deltaVsHoldCHF: number;
  recoveryYears: number | null;
  blendedCagr: number;
}

// ---- Exposure ------------------------------------------------------------
export interface ExposureSlice {
  key: string;
  label: string;
  weight: number;
  lat?: number;
  lng?: number;
}
export interface PortfolioExposure {
  totalValueCHF: number;
  countries: ExposureSlice[];
  sectors: ExposureSlice[];
  holdings: Array<{ instrumentId: number; symbol: string; name: string; valueCHF: number; weight: number }>;
  concentration: { country: number; sector: number; topHoldingWeight: number };
}
export interface ExposureSide {
  symbol: string;
  name: string;
  countries: ExposureSlice[];
  sectors: ExposureSlice[];
  concentration: { country: number; sector: number };
}
export interface ExposureComparison {
  a: ExposureSide;
  b: ExposureSide;
  overlap: { country: number; sector: number };
}

// ---- Decision plans ------------------------------------------------------
export interface PlanConfig {
  sellInstrumentIds: number[];
  targets: Array<{ symbol: string; name?: string; allocationPct: number }>;
  horizonYears?: number;
  intendedOutcome?: string;
}
export interface DecisionPlan {
  id: number;
  name: string;
  config: PlanConfig;
  baseline: Record<string, unknown> | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}
export interface PlanComparison {
  planId: number;
  name: string;
  status: string;
  createdDate: string;
  asOf: string;
  proceedsCHF: number;
  plan: {
    targets: Array<{ symbol: string; name: string | null; amountCHF: number; valueNowCHF: number; returnPct: number | null }>;
    valueNowCHF: number;
    returnPct: number | null;
  };
  hold: {
    holdings: Array<{ symbol: string; name: string | null; valueAtPlanCHF: number; valueNowCHF: number; returnPct: number | null }>;
    valueNowCHF: number;
    returnPct: number | null;
  };
  deltaCHF: number;
  intendedOutcome: string | null;
  intendedReinvestValueCHF: number;
  horizonYears: number;
}

// ---- Research / universal compare ----------------------------------------
export interface AssetMetrics {
  type: 'symbol' | 'instrument' | 'portfolio';
  symbol: string;
  name: string;
  kind: string | null;
  currency: string | null;
  currentPrice: number | null;
  trailingYield: number | null;
  cagr: number | null;
  totalReturnPct: number | null;
  annualizedVol: number | null;
  maxDrawdownPct: number | null;
  last1yPct: number | null;
  sharpe: number | null;
  from: string | null;
  to: string | null;
  points: number;
  investedCHF: number | null;
  currentValueCHF: number | null;
  xirr: number | null;
  instrumentId?: number;
  returnBasis?: string;
  rank?: number;
}
export interface ResearchAsset {
  symbol: string;
  name: string | null;
  kind: string;
  currency: string | null;
  currentPrice: number | null;
  metrics: AssetMetrics;
  allocation: AllocationBreakdown;
  movements: MovementsResponse;
  news: NewsItem[];
}
export interface ClaimSpec {
  metric: string;
  op: '>=' | '<=';
  value: number;
  years?: number | null;
}
export interface ClaimResult {
  symbol: string;
  claimText?: string | null;
  parsed: ClaimSpec | null;
  metric?: string;
  op?: string;
  threshold?: number;
  actual?: number | null;
  windowYears?: number;
  supported: boolean | null;
  explanation: string;
  from?: string | null;
  to?: string | null;
}
export type CompareEntity =
  | { type: 'portfolio' }
  | { type: 'instrument'; id: number }
  | { type: 'symbol'; symbol: string; name?: string; kind?: string };
export interface UniversalCompareResponse {
  windowYears: number;
  entities: AssetMetrics[];
}

/** POST a JSON body and stream the response as a file download. */
export async function downloadExport(kind: 'excel' | 'pdf', body: unknown, filename: string) {
  const res = await fetch(api.exportUrl(kind), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Export failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
