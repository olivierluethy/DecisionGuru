import dayjs from 'dayjs';
import type {
  AppSettings,
  BenchmarkEtf,
  CounterfactualPoint,
  CounterfactualResult,
  Instrument,
  Transaction,
} from '@decisionguru/shared';
import { countryFromSymbol } from '@decisionguru/shared';
import { getFxRate, ensureFxRange } from './fx.js';
import { getHistory, getDividends, getQuote, priceOn, ensureHistory } from './marketdata.js';
import { dividendTax, wealthTax, fundIncomeTaxDrag } from './tax.js';
import { xirr, cagr, yearsBetween, type CashFlow } from './math.js';

function resolveBenchmark(symbol: string, settings: AppSettings): BenchmarkEtf {
  const found = settings.benchmarks.find((b) => b.symbol === symbol);
  if (found) return found;
  return {
    symbol,
    name: symbol,
    currency: 'USD',
    domicile: countryFromSymbol(symbol) ?? 'US',
    incomeYield: settings.tax.defaultEtfIncomeYield,
    accumulating: false,
  };
}

interface PriceLookup {
  ccy: string;
  priceCHFOn: (date: string) => Promise<number>;
}

async function makeLookup(symbol: string, from: string, fallbackCcy: string): Promise<PriceLookup> {
  await ensureHistory(symbol, from);
  const q = await getQuote(symbol).catch(() => null);
  const ccy = q?.currency || fallbackCcy;
  return {
    ccy,
    priceCHFOn: async (date: string) => {
      const p = await priceOn(symbol, date);
      if (p == null) return 0;
      const fx = await getFxRate(ccy, 'CHF', date);
      return p * fx;
    },
  };
}

/**
 * Compare an actual holding to the counterfactual where every cash outflow into the
 * stock had instead bought the benchmark ETF on the same date. All CHF, after Swiss tax.
 * See docs/TAX-MODEL.md.
 */
export async function computeCounterfactual(
  instrument: Instrument,
  txs: Transaction[],
  benchmarkSymbol: string,
  settings: AppSettings,
  preTax = false,
  opts: { asOf?: string | null } = {},
): Promise<CounterfactualResult> {
  const tax = settings.tax;
  const bench = resolveBenchmark(benchmarkSymbol, settings);
  // 'asOf' evaluates the basket as of a chosen date instead of today (scenario date control).
  const today = opts.asOf || dayjs().format('YYYY-MM-DD');
  // Exclude corporate actions (swaps/delistings) from the counterfactual cash-flow mirror.
  const sorted = [...txs]
    .filter((t) => t.category !== 'corporate_action' && t.date <= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  const buys = sorted.filter((t) => t.action === 'buy');
  const sells = sorted.filter((t) => t.action === 'sell');

  if (!buys.length) {
    return emptyResult(bench);
  }

  const firstDate = sorted[0].date;
  // Fully closed if all bought quantity has been sold.
  const boughtQty = buys.reduce((s, t) => s + t.quantity, 0);
  const soldQty = sells.reduce((s, t) => s + t.quantity, 0);
  const fullyClosed = soldQty >= boughtQty - 1e-9 && sells.length > 0;
  let endDate = fullyClosed ? sells[sells.length - 1].date : today;
  if (dayjs(endDate).isAfter(dayjs(today))) endDate = today;

  // Pre-fetch FX series for the currencies involved to keep sampling fast.
  const currencies = new Set<string>(['CHF', instrument.currency, bench.currency]);
  txs.forEach((t) => currencies.add(t.currency));
  await ensureFxRange([...currencies], firstDate, endDate);

  const stockLook = await makeLookup(instrument.symbol, firstDate, instrument.currency);
  const etfLook = await makeLookup(bench.symbol, firstDate, bench.currency);

  // --- Build ETF counterfactual units by mirroring each buy's CHF outflow ---
  interface UnitEvent {
    date: string;
    units: number;
    cashCHF: number;
  }
  const etfEvents: UnitEvent[] = [];
  const etfFlowsAfterTax: CashFlow[] = [];
  for (const b of buys) {
    const costOrig = b.quantity * b.unitPrice + (b.fees ?? 0);
    const fxBuy = await getFxRate(b.currency || instrument.currency, 'CHF', b.date);
    const cashCHF = costOrig * fxBuy;
    const etfPriceCHF = await etfLook.priceCHFOn(b.date);
    const units = etfPriceCHF > 0 ? cashCHF / etfPriceCHF : 0;
    etfEvents.push({ date: b.date, units, cashCHF });
    etfFlowsAfterTax.push({ date: b.date, amount: -cashCHF });
  }
  const totalInvestedCHF = etfEvents.reduce((s, e) => s + e.cashCHF, 0);

  const unitsHeldAt = (date: string) =>
    etfEvents.filter((e) => e.date <= date).reduce((s, e) => s + e.units, 0);
  const totalEtfUnits = unitsHeldAt(endDate);

  // ETF distributions received over the hold (distributing funds), taxed as income.
  const etfDivs = await getDividends(bench.symbol, firstDate);
  let etfNetDistCHF = 0;
  let etfGrossDistCHF = 0;
  for (const d of etfDivs) {
    if (d.date < firstDate || d.date > endDate) continue;
    const units = unitsHeldAt(d.date);
    if (units <= 0) continue;
    const fx = await getFxRate(bench.currency, 'CHF', d.date);
    const grossCHF = units * d.close * fx;
    etfGrossDistCHF += grossCHF;
    const bd = dividendTax(grossCHF, bench.domicile, tax);
    etfNetDistCHF += preTax ? grossCHF : bd.netAfterTaxCHF;
    etfFlowsAfterTax.push({ date: d.date, amount: preTax ? grossCHF : bd.netAfterTaxCHF });
  }

  const etfPriceValueEnd = totalEtfUnits * (await etfLook.priceCHFOn(endDate));
  const years = yearsBetween(firstDate, endDate);
  const etfMeanValue = (totalInvestedCHF + etfPriceValueEnd) / 2;
  // Accumulating funds: income reinvested into price but still taxed (docs §3).
  const etfIncomeDrag =
    preTax || !bench.accumulating
      ? 0
      : fundIncomeTaxDrag(etfMeanValue, bench.incomeYield, years, bench.domicile, tax);
  const etfWealthTax = preTax ? 0 : wealthTax(etfMeanValue, years, tax);

  const counterfactualValueCHF =
    etfPriceValueEnd + etfNetDistCHF - etfIncomeDrag - etfWealthTax;

  const etfTerminalFlows: CashFlow[] = [
    ...etfFlowsAfterTax,
    { date: endDate, amount: etfPriceValueEnd - etfIncomeDrag - etfWealthTax },
  ];
  const benchmarkXirr = xirr(etfTerminalFlows);

  // --- Actual holding value at endDate (after tax) ---
  const actual = await actualValueSeries(instrument, sorted, stockLook, tax, preTax, endDate);
  const actualValueCHF = actual.endValueCHF;

  const deltaCHF = actualValueCHF - counterfactualValueCHF;
  const deltaPct = counterfactualValueCHF !== 0 ? deltaCHF / Math.abs(counterfactualValueCHF) : 0;

  // --- Aligned monthly series for the delta chart ---
  const series = await buildSeries(
    firstDate,
    endDate,
    (date) => actual.valueAt(date),
    async (date) => {
      const units = unitsHeldAt(date);
      const price = await etfLook.priceCHFOn(date);
      const distSoFar = await etfDistToDate(etfDivs, etfEvents, bench, tax, preTax, firstDate, date);
      return units * price + distSoFar;
    },
  );

  // Recovery months: if actual ahead, how long for ETF (at its CAGR) to catch actual.
  let recoveryMonths: number | null = null;
  const etfCagr = cagr(totalInvestedCHF, counterfactualValueCHF, years) ?? bench.incomeYield;
  if (deltaCHF > 0 && counterfactualValueCHF > 0 && etfCagr && etfCagr > 0) {
    const monthlyRate = Math.pow(1 + etfCagr, 1 / 12) - 1;
    if (monthlyRate > 0) {
      recoveryMonths = Math.log(actualValueCHF / counterfactualValueCHF) / Math.log(1 + monthlyRate);
    }
  }

  return {
    benchmarkSymbol: bench.symbol,
    benchmarkName: bench.name,
    actualValueCHF,
    counterfactualValueCHF,
    deltaCHF,
    deltaPct,
    actualPreTaxCHF: actual.endValuePreTaxCHF,
    counterfactualPreTaxCHF: etfPriceValueEnd + etfGrossDistCHF,
    actualXirr: actual.xirr,
    benchmarkXirr,
    series,
    recoveryMonths: recoveryMonths && Number.isFinite(recoveryMonths) ? recoveryMonths : null,
  };
}

async function etfDistToDate(
  etfDivs: { date: string; close: number }[],
  etfEvents: { date: string; units: number }[],
  bench: BenchmarkEtf,
  tax: AppSettings['tax'],
  preTax: boolean,
  from: string,
  to: string,
): Promise<number> {
  let sum = 0;
  for (const d of etfDivs) {
    if (d.date < from || d.date > to) continue;
    const units = etfEvents.filter((e) => e.date <= d.date).reduce((s, e) => s + e.units, 0);
    if (units <= 0) continue;
    const fx = await getFxRate(bench.currency, 'CHF', d.date);
    const grossCHF = units * d.close * fx;
    sum += preTax ? grossCHF : dividendTax(grossCHF, bench.domicile, tax).netAfterTaxCHF;
  }
  return sum;
}

interface ActualSeries {
  endValueCHF: number;
  endValuePreTaxCHF: number;
  xirr: number | null;
  valueAt: (date: string) => Promise<number>;
}

async function actualValueSeries(
  instrument: Instrument,
  sorted: Transaction[],
  stockLook: PriceLookup,
  tax: AppSettings['tax'],
  preTax: boolean,
  endDate: string,
): Promise<ActualSeries> {
  // Running units and cumulative after-tax dividends as a function of date.
  const buysSells = sorted.filter((t) => t.action !== 'dividend');
  const divs = sorted.filter((t) => t.action === 'dividend');
  const flows: CashFlow[] = [];

  const unitsAt = (date: string) =>
    buysSells
      .filter((t) => t.date <= date)
      .reduce((s, t) => s + (t.action === 'buy' ? t.quantity : -t.quantity), 0);

  // Cash returned by sells up to `date` (CHF, historical FX). Without this a fully-closed
  // position would look like it vanished to ~0 instead of the cash the sells realised.
  const proceedsToDate = async (date: string) => {
    let sum = 0;
    for (const t of buysSells) {
      if (t.action !== 'sell' || t.date > date) continue;
      const orig = t.quantity * t.unitPrice - (t.fees ?? 0);
      const fx = await getFxRate(t.currency || instrument.currency, 'CHF', t.date);
      sum += orig * fx;
    }
    return sum;
  };

  const divToDate = async (date: string) => {
    let sum = 0;
    for (const d of divs) {
      if (d.date > date) continue;
      const gross = d.grossAmount != null ? d.grossAmount : d.quantity * d.unitPrice;
      const fx = await getFxRate(d.currency || instrument.currency, 'CHF', d.date);
      const grossCHF = gross * fx;
      sum += preTax ? grossCHF : dividendTax(grossCHF, instrument.domicile, tax).netAfterTaxCHF;
    }
    return sum;
  };

  // Cash flows for xirr
  for (const t of buysSells) {
    const orig = t.quantity * t.unitPrice + (t.action === 'buy' ? t.fees ?? 0 : -(t.fees ?? 0));
    const fx = await getFxRate(t.currency || instrument.currency, 'CHF', t.date);
    flows.push({ date: t.date, amount: (t.action === 'buy' ? -1 : 1) * orig * fx });
  }
  for (const d of divs) {
    const gross = d.grossAmount != null ? d.grossAmount : d.quantity * d.unitPrice;
    const fx = await getFxRate(d.currency || instrument.currency, 'CHF', d.date);
    const grossCHF = gross * fx;
    flows.push({
      date: d.date,
      amount: preTax ? grossCHF : dividendTax(grossCHF, instrument.domicile, tax).netAfterTaxCHF,
    });
  }

  const valueAt = async (date: string) => {
    const units = unitsAt(date);
    const priceCHF = units > 0 ? await stockLook.priceCHFOn(date) : 0;
    const div = await divToDate(date);
    const proceeds = await proceedsToDate(date);
    return units * priceCHF + div + proceeds;
  };

  const endUnits = unitsAt(endDate);
  const endPriceCHF = endUnits > 0 ? await stockLook.priceCHFOn(endDate) : 0;
  const endValueCHF = await valueAt(endDate);
  const endValuePreTaxCHF =
    endUnits * endPriceCHF + (await divToDate(endDate)) + (await proceedsToDate(endDate));

  const terminal: CashFlow[] =
    endUnits > 0 ? [...flows, { date: endDate, amount: endUnits * endPriceCHF }] : flows;

  return { endValueCHF, endValuePreTaxCHF, xirr: xirr(terminal), valueAt };
}

async function buildSeries(
  from: string,
  to: string,
  actualAt: (date: string) => Promise<number>,
  benchAt: (date: string) => Promise<number>,
): Promise<CounterfactualPoint[]> {
  const points: CounterfactualPoint[] = [];
  let cursor = dayjs(from).startOf('month');
  const end = dayjs(to);
  const step = end.diff(dayjs(from), 'month') > 120 ? 3 : 1; // coarser for very long histories
  while (cursor.isBefore(end) || cursor.isSame(end, 'month')) {
    const d = cursor.format('YYYY-MM-DD');
    points.push({
      date: d,
      actualCHF: round2(await actualAt(d)),
      benchmarkCHF: round2(await benchAt(d)),
    });
    cursor = cursor.add(step, 'month');
  }
  const last = dayjs(to).format('YYYY-MM-DD');
  points.push({ date: last, actualCHF: round2(await actualAt(last)), benchmarkCHF: round2(await benchAt(last)) });
  return points;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function emptyResult(bench: BenchmarkEtf): CounterfactualResult {
  return {
    benchmarkSymbol: bench.symbol,
    benchmarkName: bench.name,
    actualValueCHF: 0,
    counterfactualValueCHF: 0,
    deltaCHF: 0,
    deltaPct: 0,
    actualPreTaxCHF: 0,
    counterfactualPreTaxCHF: 0,
    actualXirr: null,
    benchmarkXirr: null,
    series: [],
    recoveryMonths: null,
  };
}
