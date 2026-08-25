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
  hasPositions: boolean;
  hasAccount: boolean;
  unknownEvents: number;
  /** ISO timestamp of the oldest quote among held positions ("prices as of"). */
  quotesUpdatedAt: string | null;
  /** True while the background pool is refreshing quotes/history. */
  refreshInProgress: boolean;
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
