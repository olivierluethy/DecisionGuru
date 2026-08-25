import dayjs from 'dayjs';
import type { BreakEvenResult, ProjectionResult, ProjectionPoint } from '@decisionguru/shared';
import { getHistory } from './marketdata.js';
import { cagr } from './math.js';

/** Long-run CAGR of a benchmark from its own price history (nominal). */
export async function benchmarkCagr(symbol: string, lookbackYears = 10): Promise<number | null> {
  const from = dayjs().subtract(lookbackYears, 'year').format('YYYY-MM-DD');
  const hist = await getHistory(symbol, from);
  if (hist.length < 2) return null;
  const start = hist[0];
  const end = hist[hist.length - 1];
  const years = dayjs(end.date).diff(dayjs(start.date), 'day') / 365;
  return cagr(start.close, end.close, years);
}

/**
 * If you sold today and moved `currentValueCHF` into an ETF growing at `etfCagr`,
 * how long until it recovers `investedCHF` (i.e. erases the realized shortfall)?
 */
export function computeBreakEven(
  currentValueCHF: number,
  investedCHF: number,
  etfCagr: number,
): BreakEvenResult {
  const realizedLossCHF = investedCHF - currentValueCHF;
  const target = investedCHF;
  let monthsToRecover: number | null = null;
  if (currentValueCHF > 0 && target > currentValueCHF && etfCagr > 0) {
    const monthlyRate = Math.pow(1 + etfCagr, 1 / 12) - 1;
    monthsToRecover = Math.log(target / currentValueCHF) / Math.log(1 + monthlyRate);
  } else if (target <= currentValueCHF) {
    monthsToRecover = 0; // already at/above break-even
  }
  return {
    realizedLossCHF,
    etfCagr,
    monthsToRecover: monthsToRecover != null && Number.isFinite(monthsToRecover) ? monthsToRecover : null,
    targetValueCHF: target,
  };
}

/**
 * Forward projection: hold the stock vs. sell now and buy the ETF. Both start from
 * `currentValueCHF` today; hypothetical, CAGR-driven. Returns monthly points.
 */
export function projectHoldVsEtf(
  currentValueCHF: number,
  stockCagr: number,
  etfCagr: number,
  years: number,
): ProjectionResult {
  const months = Math.round(years * 12);
  const stockMonthly = Math.pow(1 + stockCagr, 1 / 12) - 1;
  const etfMonthly = Math.pow(1 + etfCagr, 1 / 12) - 1;
  const points: ProjectionPoint[] = [];
  let crossoverMonth: number | null = null;
  const start = dayjs();
  for (let m = 0; m <= months; m++) {
    const hold = currentValueCHF * Math.pow(1 + stockMonthly, m);
    const etf = currentValueCHF * Math.pow(1 + etfMonthly, m);
    if (crossoverMonth === null && m > 0 && etf >= hold) crossoverMonth = m;
    points.push({ date: start.add(m, 'month').format('YYYY-MM-DD'), hold, etf });
  }
  return { points, assumedStockCagr: stockCagr, assumedEtfCagr: etfCagr, years, crossoverMonth };
}
