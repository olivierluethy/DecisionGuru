import dayjs from 'dayjs';
import type {
  Instrument,
  Position,
  Transaction,
  TaxSettings,
  DividendSummary,
} from '@decisionguru/shared';
import { toCHF, getFxRate } from './fx.js';
import { getQuote } from './marketdata.js';
import { dividendTax, wealthTax } from './tax.js';
import { instrumentDataStatus } from './datastatus.js';
import { xirr, cagr, yearsBetween, type CashFlow } from './math.js';

export interface BuiltPosition {
  position: Position;
  /** cash flows (CHF) for xirr, after-tax variant */
  flowsAfterTax: CashFlow[];
  flowsPreTax: CashFlow[];
}

/**
 * Build a full Position (holding + metrics + dividends, after Swiss tax) from an
 * instrument and its transactions. All monetary outputs are in CHF.
 */
export async function buildPosition(
  instrument: Instrument,
  txs: Transaction[],
  tax: TaxSettings,
  preTax = false,
): Promise<BuiltPosition> {
  // Corporate actions (ISIN swaps, delistings) are tracked but excluded from P/L.
  const sorted = [...txs]
    .filter((t) => t.category !== 'corporate_action')
    .sort((a, b) => a.date.localeCompare(b.date));

  let openQty = 0;
  let openCostCHF = 0; // CHF basis of currently-open shares (avg cost)
  let openCostOrig = 0; // tx-ccy basis of open shares
  let totalBuyCHF = 0;
  let totalBuyOrig = 0;
  let realizedCHF = 0;
  let totalProceedsCHF = 0; // gross sell cash returned (CHF), for correct total-return math

  const flowsAfterTax: CashFlow[] = [];
  const flowsPreTax: CashFlow[] = [];

  const divSummary: DividendSummary = {
    grossCHF: 0,
    swissWithholdingCHF: 0,
    foreignWithholdingCHF: 0,
    incomeTaxCHF: 0,
    netAfterTaxCHF: 0,
    count: 0,
  };

  const firstDate = sorted.length ? sorted[0].date : dayjs().format('YYYY-MM-DD');

  for (const tx of sorted) {
    const ccy = tx.currency || instrument.currency;
    if (tx.action === 'buy') {
      const costOrig = tx.quantity * tx.unitPrice + (tx.fees ?? 0);
      const costCHF = await toCHF(costOrig, ccy, tx.date);
      openQty += tx.quantity;
      openCostOrig += costOrig;
      openCostCHF += costCHF;
      totalBuyCHF += costCHF;
      totalBuyOrig += costOrig;
      flowsAfterTax.push({ date: tx.date, amount: -costCHF });
      flowsPreTax.push({ date: tx.date, amount: -costCHF });
    } else if (tx.action === 'sell') {
      const q = Math.min(tx.quantity, openQty || tx.quantity);
      const fraction = openQty > 0 ? q / openQty : 0;
      const removedCHF = openCostCHF * fraction;
      const proceedsOrig = tx.quantity * tx.unitPrice - (tx.fees ?? 0);
      const proceedsCHF = await toCHF(proceedsOrig, ccy, tx.date);
      realizedCHF += proceedsCHF - removedCHF; // capital gain (tax-free for private investor)
      totalProceedsCHF += proceedsCHF;
      openCostCHF -= removedCHF;
      openCostOrig -= openCostOrig * fraction;
      openQty -= q;
      flowsAfterTax.push({ date: tx.date, amount: proceedsCHF });
      flowsPreTax.push({ date: tx.date, amount: proceedsCHF });
    } else if (tx.action === 'dividend') {
      const gross = tx.grossAmount != null ? tx.grossAmount : tx.quantity * tx.unitPrice;
      const grossCHF = await toCHF(gross, ccy, tx.date);
      const bd = dividendTax(grossCHF, instrument.domicile, tax);
      divSummary.grossCHF += grossCHF;
      divSummary.swissWithholdingCHF += bd.swissWithholdingCHF;
      divSummary.foreignWithholdingCHF += bd.foreignWithholdingCHF;
      divSummary.incomeTaxCHF += bd.incomeTaxCHF;
      divSummary.netAfterTaxCHF += bd.netAfterTaxCHF;
      divSummary.count += 1;
      flowsAfterTax.push({ date: tx.date, amount: bd.netAfterTaxCHF });
      flowsPreTax.push({ date: tx.date, amount: grossCHF });
    }
  }

  // Current valuation
  const quote = openQty > 0 ? await getQuote(instrument.symbol) : null;
  const today = dayjs().format('YYYY-MM-DD');
  let currentPrice: number | null = null;
  let currentValueCHF: number | null = null;
  let stale = false;
  if (openQty > 0 && quote) {
    currentPrice = quote.price;
    stale = quote.stale;
    const fx = await getFxRate(quote.currency || instrument.currency, 'CHF', today);
    currentValueCHF = openQty * currentPrice * fx;
  } else if (openQty <= 0) {
    currentValueCHF = 0;
  }

  const unrealizedCHF =
    currentValueCHF != null && openQty > 0 ? currentValueCHF - openCostCHF : openQty > 0 ? null : 0;

  const years = yearsBetween(firstDate, today);

  // Wealth tax over holding period on mean value (both legs bear it; docs §5)
  const meanValue = ((totalBuyCHF || 0) + (currentValueCHF ?? 0)) / 2;
  const wealthTaxCHF = wealthTax(meanValue, years, tax);

  // Total after-tax P/L = (open value + cash returned from sells + net dividends) - invested - wealth tax.
  // NB: use gross sell PROCEEDS here, not realized gain — realized already nets out the sold
  // lots' cost, so subtracting totalBuy on top would double-count that basis (the old bug that
  // made fully-closed winners like Barry Callebaut read as −invested).
  const netDiv = preTax ? divSummary.grossCHF : divSummary.netAfterTaxCHF;
  const absolutePLChf =
    currentValueCHF != null
      ? currentValueCHF + totalProceedsCHF + netDiv - totalBuyCHF - (preTax ? 0 : wealthTaxCHF)
      : null;
  const absolutePLChfPreTax =
    currentValueCHF != null
      ? currentValueCHF + totalProceedsCHF + divSummary.grossCHF - totalBuyCHF
      : null;
  const percentPL = totalBuyCHF > 0 && absolutePLChf != null ? absolutePLChf / totalBuyCHF : null;

  // XIRR: append terminal value (current open holding) as an inflow today
  const terminalFlows = (flows: CashFlow[]) =>
    currentValueCHF != null && openQty > 0
      ? [...flows, { date: today, amount: currentValueCHF - (preTax ? 0 : wealthTaxCHF) }]
      : flows;
  const xirrValue = xirr(terminalFlows(preTax ? flowsPreTax : flowsAfterTax));

  const endValueForCagr =
    (currentValueCHF ?? 0) + totalProceedsCHF + netDiv - (preTax ? 0 : wealthTaxCHF);
  const cagrValue = totalBuyCHF > 0 ? cagr(totalBuyCHF, endValueForCagr, years) : null;

  const currentYield =
    currentValueCHF && currentValueCHF > 0 && divSummary.count > 0
      ? divSummary.grossCHF / Math.max(years, 0.5) / currentValueCHF
      : instrument.incomeYieldOverride ?? null;

  const position: Position = {
    instrument,
    openQuantity: openQty,
    avgCost: openQty > 0 ? openCostOrig / openQty : 0,
    investedOriginal: totalBuyOrig,
    investedCHF: totalBuyCHF,
    currentPrice,
    currentValueCHF,
    realizedCHF,
    unrealizedCHF,
    dividends: divSummary,
    priceAsOf: quote?.time ?? null,
    stale,
    dataStatus: instrumentDataStatus(instrument, openQty),
    metrics: {
      absolutePLChf,
      absolutePLChfPreTax,
      percentPL,
      xirr: xirrValue,
      cagr: cagrValue,
      currentYield,
      wealthTaxCHF,
    },
  };

  return { position, flowsAfterTax, flowsPreTax };
}
