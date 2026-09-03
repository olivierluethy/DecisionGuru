import type { PortfolioResponse, PortfolioFit } from './api';
import { api } from './api';
import type { AppSettings, CounterfactualResult, Position, Transaction } from '@decisionguru/shared';
import { fmtCHF, fmtPct } from './format';
import { compactBlocks, tableBlock, type ExportDoc } from './exportDoc';

/** Wire shape for `/export/excel`: one sheet per table. Spreadsheets carry no layout, so
 *  they stay a separate payload from the paged `ExportDoc` rather than being forced into it. */
export interface SheetsPayload {
  title: string;
  sheets: { name: string; table: { headers: string[]; rows: (string | number)[][] } }[];
}

/** Serialise a rendered SVG chart to a PNG data URL for PDF embedding. */
export async function svgToPng(svg: SVGSVGElement, bg = '#0A0E15'): Promise<string | null> {
  try {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const w = rect.width || 600;
    const h = rect.height || 280;
    clone.setAttribute('width', String(w));
    clone.setAttribute('height', String(h));
    const xml = new XMLSerializer().serializeToString(clone);
    const svg64 = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
      img.src = svg64;
    });
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

async function captureChart(containerId: string): Promise<string | undefined> {
  const el = document.getElementById(containerId);
  const svg = el?.querySelector('svg.recharts-surface') as SVGSVGElement | null;
  if (!svg) return undefined;
  return (await svgToPng(svg)) ?? undefined;
}

const POSITION_HEADERS = [
  'Symbol', 'Name', 'Kind', 'Currency', 'Open qty', 'Invested CHF', 'Value CHF',
  'Unrealized CHF', 'Realized CHF', 'Net dividends CHF', 'Total P/L CHF', '% P/L',
  'Opp. cost vs ETF CHF', 'XIRR', 'ETF XIRR',
];

function positionRow(p: Position, cf?: CounterfactualResult) {
  return [
    p.instrument.symbol,
    p.instrument.name,
    p.instrument.kind,
    p.instrument.currency,
    round(p.openQuantity),
    round(p.investedCHF),
    round(p.currentValueCHF ?? 0),
    round(p.unrealizedCHF ?? 0),
    round(p.realizedCHF),
    round(p.dividends.netAfterTaxCHF),
    round(p.metrics.absolutePLChf ?? 0),
    pct(p.metrics.percentPL),
    round(cf?.deltaCHF ?? 0),
    pct(p.metrics.xirr),
    pct(cf?.benchmarkXirr ?? null),
  ];
}

const TX_HEADERS = ['Symbol', 'Date', 'Action', 'Category', 'Qty', 'Unit price', 'Currency', 'Fees', 'Note'];

function txRows(symbol: string, txs: Transaction[]) {
  return txs.map((t) => [
    symbol,
    t.date,
    t.action,
    t.category ?? 'trade',
    round(t.quantity),
    round(t.unitPrice),
    t.currency,
    round(t.fees),
    t.note ?? '',
  ]);
}

function taxRows(s: AppSettings): (string | number)[][] {
  const t = s.tax;
  return [
    ['Basis currency', t.baseCurrency],
    ['Marginal income rate', pct(t.marginalIncomeRate)],
    ['Capital gains taxable', t.capitalGainsTaxable ? 'yes' : 'no (private investor)'],
    ['Swiss withholding', pct(t.swissWithholdingRate)],
    ['Swiss withholding reclaimed', t.swissWithholdingReclaimed ? 'yes' : 'no'],
    ['US withholding', pct(t.foreignWithholdingUS)],
    ['US reclaim fraction', pct(t.foreignReclaimFractionUS)],
    ['Other foreign withholding', pct(t.foreignWithholdingGeneric)],
    ['Wealth tax p.a.', pct(t.wealthTaxRate)],
    ['Default ETF income yield', pct(t.defaultEtfIncomeYield)],
  ];
}

function recommendationRows(p: Position): (string | number)[][] {
  const v = p.verdict;
  if (!v) return [['Recommendation', 'Not available']];
  const rows: (string | number)[][] = [
    ['Recommendation', v.action?.label ?? v.label],
    ['Owned', v.action?.owned ? 'Yes' : 'No'],
    ['Confidence', v.confidence],
    ['Rationale', v.rationale],
  ];
  if (v.conflictNote) rows.push(['Note', v.conflictNote]);
  return rows;
}

function fitRows(fit: PortfolioFit | null): (string | number)[][] {
  if (!fit) return [['Portfolio fit', 'Unavailable']];
  const ind = fit.indirect.available ? pct(fit.indirect.weight) : 'unavailable';
  const rows: (string | number)[][] = [
    ['Owned', fit.owned ? 'Yes' : 'No'],
    ['Direct exposure', fit.owned ? pct(fit.directWeight) : '0%'],
    ['Indirect ETF exposure', ind],
    ['Effective exposure', fit.effectiveExposure != null ? pct(fit.effectiveExposure) : '—'],
    ['Diversification', fit.diversification.note],
  ];
  if (fit.concentrationNote) rows.push(['Concentration', fit.concentrationNote]);
  return rows;
}

/** Rows shared by the portfolio's spreadsheet and its document. */
async function portfolioParts(data: PortfolioResponse) {
  const cfById = new Map(data.counterfactuals.map((c) => [c.instrumentId, c.counterfactual]));
  const rows = data.positions.map((p) => positionRow(p, cfById.get(p.instrument.id)));

  // Full transaction history + tax assumptions for a complete, auditable export.
  const [settings, ...txLists] = await Promise.all([
    api.getSettings().catch(() => null),
    ...data.positions.map((p) => api.getTransactions(p.instrument.id).catch(() => [] as Transaction[])),
  ]);
  const allTxRows = data.positions.flatMap((p, i) => txRows(p.instrument.symbol, txLists[i] ?? []));

  const summaryRows: (string | number)[][] = [
    ['Benchmark', data.benchmark],
    ['Basis', data.preTax ? 'Pre-tax' : 'After-tax'],
    ['Invested CHF', round(data.totals.investedCHF)],
    ['Current value CHF', round(data.totals.currentValueCHF)],
    ['Realized P/L CHF', round(data.totals.realizedCHF)],
    ['Net dividends CHF', round(data.totals.netDividendsCHF)],
    ['Total P/L CHF', round(data.totals.absolutePLChf)],
    ['Opportunity cost vs ETF CHF', round(data.aggregate.deltaCHF)],
    ['Opportunity cost %', pct(data.aggregate.deltaPct)],
  ];

  return { rows, allTxRows, summaryRows, settings };
}

/** Spreadsheet payload — one sheet per table, no page layout to preview. */
export async function buildPortfolioSheets(data: PortfolioResponse): Promise<SheetsPayload> {
  const { rows, allTxRows, summaryRows, settings } = await portfolioParts(data);
  const sheets = [
    { name: 'Summary', table: { headers: ['Metric', 'Value'], rows: summaryRows } },
    { name: 'Positions', table: { headers: POSITION_HEADERS, rows } },
    { name: 'Transactions', table: { headers: TX_HEADERS, rows: allTxRows } },
  ];
  if (settings) sheets.push({ name: 'Tax assumptions', table: { headers: ['Assumption', 'Value'], rows: taxRows(settings) } });
  return { title: `DecisionGuru portfolio vs ${data.benchmark}`, sheets };
}

/** The same analysis as a document — rendered to PDF or Word by the preview. */
export async function buildPortfolioDoc(data: PortfolioResponse): Promise<ExportDoc> {
  const { rows, allTxRows, summaryRows, settings } = await portfolioParts(data);
  const chartImage = await captureChart('export-chart');
  const doc: ExportDoc = {
    title: `DecisionGuru portfolio vs ${data.benchmark}`,
    subtitle: `${data.preTax ? 'Pre-tax' : 'After-tax'} · opportunity cost ${fmtCHF(data.aggregate.deltaCHF)} · ${fmtPct(data.aggregate.deltaPct)}`,
    filename: `portfolio-vs-${data.benchmark}`,
    meta: [
      { label: 'As of', value: new Date().toISOString().slice(0, 10) },
      { label: 'Benchmark', value: data.benchmark },
      { label: 'Basis', value: data.preTax ? 'Pre-tax' : 'After-tax' },
    ],
    blocks: compactBlocks([
      chartImage ? { id: 'chart', kind: 'chart', title: 'Portfolio vs benchmark', image: chartImage } : null,
      tableBlock('summary', 'Summary', ['Metric', 'Value'], summaryRows),
      tableBlock('positions', 'Positions', POSITION_HEADERS, rows),
      tableBlock('transactions', 'Transactions', TX_HEADERS, allTxRows),
      settings ? tableBlock('tax', 'Tax assumptions', ['Assumption', 'Value'], taxRows(settings)) : null,
    ]),
  };
  return doc;
}

/** Rows shared by a position's spreadsheet and its document. */
async function positionParts(position: Position, cf: CounterfactualResult) {
  const p = position;
  const summaryRows: (string | number)[][] = [
    ['Symbol', p.instrument.symbol],
    ['Name', p.instrument.name],
    ['ISIN', p.instrument.isin ?? '—'],
    ['Open quantity', round(p.openQuantity)],
    ['Invested CHF', round(p.investedCHF)],
    ['Current value CHF', round(p.currentValueCHF ?? 0)],
    ['Unrealized P/L CHF', round(p.unrealizedCHF ?? 0)],
    ['Realized P/L CHF', round(p.realizedCHF)],
    ['Net dividends (after tax) CHF', round(p.dividends.netAfterTaxCHF)],
    ['Total P/L CHF', round(p.metrics.absolutePLChf ?? 0)],
    ['% P/L', pct(p.metrics.percentPL)],
    ['XIRR', pct(p.metrics.xirr)],
    [`Counterfactual (${cf.benchmarkSymbol}) value CHF`, round(cf.counterfactualValueCHF)],
    ['Opportunity cost vs ETF CHF', round(cf.deltaCHF)],
    ['ETF XIRR', pct(cf.benchmarkXirr)],
  ];

  const [settings, transactions, fit] = await Promise.all([
    api.getSettings().catch(() => null),
    api.getTransactions(p.instrument.id).catch(() => [] as Transaction[]),
    api.fit(p.instrument.symbol).catch(() => null),
  ]);
  const txTable = { headers: TX_HEADERS, rows: txRows(p.instrument.symbol, transactions) };

  return { summaryRows, txTable, settings, fit };
}

export async function buildPositionSheets(
  position: Position, cf: CounterfactualResult,
): Promise<SheetsPayload> {
  const p = position;
  const { summaryRows, txTable, settings, fit } = await positionParts(position, cf);
  const sheets = [
    { name: 'Analysis', table: { headers: ['Metric', 'Value'], rows: summaryRows } },
    { name: 'Recommendation', table: { headers: ['Field', 'Value'], rows: recommendationRows(p) } },
    { name: 'Portfolio fit', table: { headers: ['Field', 'Value'], rows: fitRows(fit) } },
    { name: 'Transactions', table: txTable },
  ];
  if (settings) sheets.push({ name: 'Tax assumptions', table: { headers: ['Assumption', 'Value'], rows: taxRows(settings) } });
  return { title: `${p.instrument.symbol} vs ${cf.benchmarkSymbol}`, sheets };
}

export async function buildPositionDoc(
  position: Position, cf: CounterfactualResult, notes: string[] = [],
): Promise<ExportDoc> {
  const p = position;
  const { summaryRows, txTable, settings, fit } = await positionParts(position, cf);
  const chartImage = await captureChart('position-chart');
  const doc: ExportDoc = {
    title: `${p.instrument.symbol} — ${p.instrument.name}`,
    subtitle: `vs ${cf.benchmarkName} · opportunity cost ${fmtCHF(cf.deltaCHF)}`,
    filename: `${p.instrument.symbol}-vs-${cf.benchmarkSymbol}`,
    meta: [
      { label: 'As of', value: new Date().toISOString().slice(0, 10) },
      { label: 'Benchmark', value: cf.benchmarkSymbol },
      { label: 'ISIN', value: p.instrument.isin ?? '—' },
    ],
    blocks: compactBlocks([
      chartImage ? { id: 'chart', kind: 'chart', title: 'This holding vs the benchmark', image: chartImage } : null,
      tableBlock('analysis', 'Analysis', ['Metric', 'Value'], summaryRows),
      tableBlock('recommendation', 'Recommendation', ['Field', 'Value'], recommendationRows(p)),
      tableBlock('fit', 'Portfolio fit', ['Field', 'Value'], fitRows(fit)),
      tableBlock('transactions', 'Transactions', TX_HEADERS, txTable.rows),
      settings ? tableBlock('tax', 'Tax assumptions', ['Assumption', 'Value'], taxRows(settings)) : null,
      notes.length ? { id: 'notes', kind: 'notes', title: 'Notes', items: notes } : null,
    ]),
  };
  return doc;
}

function round(n: number) {
  return Math.round((n ?? 0) * 100) / 100;
}
function pct(n: number | null | undefined) {
  return n == null ? '—' : `${(n * 100).toFixed(2)}%`;
}
