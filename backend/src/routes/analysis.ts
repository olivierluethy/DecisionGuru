import { Router } from 'express';
import type { CounterfactualPoint } from '@decisionguru/shared';
import { getSettings } from '../db/index.js';
import { getInstrument, getTransactions, listInstruments } from '../services/repo.js';
import { buildPosition } from '../services/finance.js';
import { computeCounterfactual } from '../services/counterfactual.js';
import { benchmarkCagr, computeBreakEven, projectHoldVsEtf } from '../services/projection.js';

export const analysisRouter = Router();

function boolParam(v: unknown): boolean {
  return v === 'true' || v === '1' || v === true;
}

// Single position metrics
analysisRouter.get('/position/:id', async (req, res) => {
  const inst = getInstrument(Number(req.params.id));
  if (!inst) return res.status(404).json({ error: 'Instrument not found' });
  const settings = getSettings();
  const preTax = boolParam(req.query.preTax);
  const built = await buildPosition(inst, getTransactions(inst.id), settings.tax, preTax);
  res.json(built.position);
});

// Counterfactual vs a benchmark
analysisRouter.get('/counterfactual/:id', async (req, res) => {
  const inst = getInstrument(Number(req.params.id));
  if (!inst) return res.status(404).json({ error: 'Instrument not found' });
  const settings = getSettings();
  const benchmark = (req.query.benchmark as string) || settings.defaultBenchmarkSymbol;
  const preTax = boolParam(req.query.preTax);
  const result = await computeCounterfactual(inst, getTransactions(inst.id), benchmark, settings, preTax);
  res.json(result);
});

// Break-even: sell now -> ETF, months to recover invested capital
analysisRouter.get('/breakeven/:id', async (req, res) => {
  const inst = getInstrument(Number(req.params.id));
  if (!inst) return res.status(404).json({ error: 'Instrument not found' });
  const settings = getSettings();
  const benchmark = (req.query.benchmark as string) || settings.defaultBenchmarkSymbol;
  const built = await buildPosition(inst, getTransactions(inst.id), settings.tax);
  const etfCagr = (await benchmarkCagr(benchmark)) ?? 0.06;
  const result = computeBreakEven(built.position.currentValueCHF ?? 0, built.position.investedCHF, etfCagr);
  res.json({ ...result, benchmark });
});

// Forward projection: hold vs sell->ETF
analysisRouter.get('/projection/:id', async (req, res) => {
  const inst = getInstrument(Number(req.params.id));
  if (!inst) return res.status(404).json({ error: 'Instrument not found' });
  const settings = getSettings();
  const benchmark = (req.query.benchmark as string) || settings.defaultBenchmarkSymbol;
  const years = Number(req.query.years ?? 5);
  const built = await buildPosition(inst, getTransactions(inst.id), settings.tax);
  const etfCagr =
    req.query.etfCagr != null ? Number(req.query.etfCagr) : (await benchmarkCagr(benchmark)) ?? 0.06;
  const stockCagr =
    req.query.stockCagr != null ? Number(req.query.stockCagr) : built.position.metrics.cagr ?? etfCagr;
  const result = projectHoldVsEtf(built.position.currentValueCHF ?? 0, stockCagr, etfCagr, years);
  res.json({ ...result, benchmark });
});

// Dividend-shock: recompute annual income if the dividend is cut by a fraction
analysisRouter.get('/dividend-shock/:id', async (req, res) => {
  const inst = getInstrument(Number(req.params.id));
  if (!inst) return res.status(404).json({ error: 'Instrument not found' });
  const settings = getSettings();
  const cut = Math.min(Math.max(Number(req.query.cut ?? 1), 0), 1); // 1 = full elimination
  const built = await buildPosition(inst, getTransactions(inst.id), settings.tax);
  const p = built.position;
  const currentAnnualGross =
    p.metrics.currentYield && p.currentValueCHF ? p.metrics.currentYield * p.currentValueCHF : 0;
  const shockedGross = currentAnnualGross * (1 - cut);
  const marginal = settings.tax.marginalIncomeRate;
  res.json({
    currentAnnualGrossCHF: currentAnnualGross,
    shockedAnnualGrossCHF: shockedGross,
    lostGrossCHF: currentAnnualGross - shockedGross,
    lostNetAfterTaxCHF: (currentAnnualGross - shockedGross) * (1 - marginal),
    cut,
  });
});

// Flexible comparison: an arbitrary basket of instruments vs one or more benchmark ETFs.
// Body: { instrumentIds: number[], benchmarks?: string[], preTax?: boolean }
analysisRouter.post('/compare', async (req, res) => {
  const settings = getSettings();
  const preTax = boolParam(req.body?.preTax);
  const ids: number[] = Array.isArray(req.body?.instrumentIds) ? req.body.instrumentIds : [];
  const benchmarks: string[] =
    Array.isArray(req.body?.benchmarks) && req.body.benchmarks.length
      ? req.body.benchmarks
      : [settings.defaultBenchmarkSymbol];

  const instruments = (ids.length ? ids.map((id) => getInstrument(id)) : listInstruments())
    .filter((i): i is NonNullable<typeof i> => !!i);

  // Positions are benchmark-independent; compute once.
  const positions = [];
  const withTx: { inst: (typeof instruments)[number]; txs: ReturnType<typeof getTransactions> }[] = [];
  for (const inst of instruments) {
    const txs = getTransactions(inst.id);
    if (!txs.length) continue;
    withTx.push({ inst, txs });
    positions.push((await buildPosition(inst, txs, settings.tax, preTax)).position);
  }

  const comparisons = [];
  for (const benchmark of benchmarks) {
    const counterfactuals = [];
    for (const { inst, txs } of withTx) {
      const cf = await computeCounterfactual(inst, txs, benchmark, settings, preTax);
      counterfactuals.push({ instrumentId: inst.id, symbol: inst.symbol, name: inst.name, counterfactual: cf });
    }
    const aggregate = aggregateCounterfactuals(counterfactuals.map((c) => c.counterfactual));
    comparisons.push({
      benchmark,
      benchmarkName:
        settings.benchmarks.find((b: { symbol: string; name: string }) => b.symbol === benchmark)?.name ??
        benchmark,
      aggregate,
      perPosition: counterfactuals,
    });
  }

  res.json({
    preTax,
    instrumentIds: instruments.map((i) => i.id),
    positions,
    comparisons,
  });
});

// Whole portfolio: all positions + aggregate counterfactual
analysisRouter.get('/portfolio', async (req, res) => {
  const settings = getSettings();
  const preTax = boolParam(req.query.preTax);
  const benchmark = (req.query.benchmark as string) || settings.defaultBenchmarkSymbol;
  const instruments = listInstruments();

  const positions = [];
  const counterfactuals = [];
  for (const inst of instruments) {
    const txs = getTransactions(inst.id);
    if (!txs.length) continue;
    const built = await buildPosition(inst, txs, settings.tax, preTax);
    positions.push(built.position);
    const cf = await computeCounterfactual(inst, txs, benchmark, settings, preTax);
    counterfactuals.push({ instrumentId: inst.id, symbol: inst.symbol, counterfactual: cf });
  }

  const aggregate = aggregateCounterfactuals(counterfactuals.map((c) => c.counterfactual));
  const totals = {
    investedCHF: sum(positions.map((p) => p.investedCHF)),
    currentValueCHF: sum(positions.map((p) => p.currentValueCHF ?? 0)),
    realizedCHF: sum(positions.map((p) => p.realizedCHF)),
    netDividendsCHF: sum(positions.map((p) => p.dividends.netAfterTaxCHF)),
    absolutePLChf: sum(positions.map((p) => p.metrics.absolutePLChf ?? 0)),
  };

  res.json({ benchmark, preTax, positions, counterfactuals, aggregate, totals });
});

function sum(arr: number[]) {
  return arr.reduce((s, x) => s + x, 0);
}

/** Merge per-position counterfactual series into a portfolio-level series (sum by date). */
export function aggregateCounterfactuals(cfs: { series: CounterfactualPoint[]; actualValueCHF: number; counterfactualValueCHF: number }[]) {
  const dates = new Set<string>();
  cfs.forEach((cf) => cf.series.forEach((p) => dates.add(p.date)));
  const ordered = [...dates].sort();
  const series: CounterfactualPoint[] = ordered.map((date) => {
    let actual = 0;
    let benchmark = 0;
    for (const cf of cfs) {
      const point = lastAtOrBefore(cf.series, date);
      if (point) {
        actual += point.actualCHF;
        benchmark += point.benchmarkCHF;
      }
    }
    return { date, actualCHF: Math.round(actual * 100) / 100, benchmarkCHF: Math.round(benchmark * 100) / 100 };
  });
  const actualValueCHF = sum(cfs.map((c) => c.actualValueCHF));
  const counterfactualValueCHF = sum(cfs.map((c) => c.counterfactualValueCHF));
  const deltaCHF = actualValueCHF - counterfactualValueCHF;
  return {
    actualValueCHF,
    counterfactualValueCHF,
    deltaCHF,
    deltaPct: counterfactualValueCHF !== 0 ? deltaCHF / Math.abs(counterfactualValueCHF) : 0,
    series,
  };
}

function lastAtOrBefore(series: CounterfactualPoint[], date: string): CounterfactualPoint | null {
  let found: CounterfactualPoint | null = null;
  for (const p of series) {
    if (p.date <= date) found = p;
    else break;
  }
  return found;
}
