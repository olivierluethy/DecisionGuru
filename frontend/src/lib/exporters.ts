import type { PortfolioResponse } from './api';
import type { CounterfactualResult, Position } from '@decisionguru/shared';
import { fmtCHF, fmtPct } from './format';

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

export async function buildPortfolioExport(data: PortfolioResponse, kind: 'excel' | 'pdf') {
  const cfById = new Map(data.counterfactuals.map((c) => [c.instrumentId, c.counterfactual]));
  const headers = ['Symbol', 'Name', 'Kind', 'Invested CHF', 'Value CHF', 'P/L CHF', 'Opp. cost vs ETF', 'XIRR', 'ETF XIRR'];
  const rows = data.positions.map((p) => {
    const cf = cfById.get(p.instrument.id);
    return [
      p.instrument.symbol,
      p.instrument.name,
      p.instrument.kind,
      round(p.investedCHF),
      round(p.currentValueCHF ?? 0),
      round(p.metrics.absolutePLChf ?? 0),
      round(cf?.deltaCHF ?? 0),
      pct(p.metrics.xirr),
      pct(cf?.benchmarkXirr ?? null),
    ];
  });

  if (kind === 'excel') {
    return {
      title: `DecisionGuru portfolio vs ${data.benchmark}`,
      sheets: [
        { name: 'Positions', table: { headers, rows } },
        {
          name: 'Summary',
          table: {
            headers: ['Metric', 'Value'],
            rows: [
              ['Benchmark', data.benchmark],
              ['Basis', data.preTax ? 'Pre-tax' : 'After-tax'],
              ['Invested CHF', round(data.totals.investedCHF)],
              ['Current value CHF', round(data.totals.currentValueCHF)],
              ['Net dividends CHF', round(data.totals.netDividendsCHF)],
              ['Total P/L CHF', round(data.totals.absolutePLChf)],
              ['Opportunity cost vs ETF CHF', round(data.aggregate.deltaCHF)],
            ],
          },
        },
      ],
    };
  }

  const chartImage = await captureChart('export-chart');
  return {
    title: `DecisionGuru portfolio vs ${data.benchmark}`,
    subtitle: `${data.preTax ? 'Pre-tax' : 'After-tax'} · opportunity cost ${fmtCHF(data.aggregate.deltaCHF)} · ${fmtPct(data.aggregate.deltaPct)}`,
    chartImage,
    tables: [{ title: 'Positions', headers, rows }],
  };
}

export async function buildPositionExport(
  position: Position,
  cf: CounterfactualResult,
  kind: 'excel' | 'pdf',
  notes: string[] = [],
) {
  const p = position;
  const summaryRows: (string | number)[][] = [
    ['Symbol', p.instrument.symbol],
    ['Name', p.instrument.name],
    ['Invested CHF', round(p.investedCHF)],
    ['Current value CHF', round(p.currentValueCHF ?? 0)],
    ['Unrealized P/L CHF', round(p.unrealizedCHF ?? 0)],
    ['Net dividends (after tax) CHF', round(p.dividends.netAfterTaxCHF)],
    ['XIRR', pct(p.metrics.xirr)],
    [`Counterfactual (${cf.benchmarkSymbol}) value CHF`, round(cf.counterfactualValueCHF)],
    ['Opportunity cost vs ETF CHF', round(cf.deltaCHF)],
    ['ETF XIRR', pct(cf.benchmarkXirr)],
  ];

  if (kind === 'excel') {
    return {
      title: `${p.instrument.symbol} vs ${cf.benchmarkSymbol}`,
      sheets: [{ name: 'Analysis', table: { headers: ['Metric', 'Value'], rows: summaryRows } }],
    };
  }
  const chartImage = await captureChart('position-chart');
  return {
    title: `${p.instrument.symbol} — ${p.instrument.name}`,
    subtitle: `vs ${cf.benchmarkName} · opportunity cost ${fmtCHF(cf.deltaCHF)}`,
    chartImage,
    tables: [{ title: 'Analysis', headers: ['Metric', 'Value'], rows: summaryRows }],
    notes,
  };
}

function round(n: number) {
  return Math.round((n ?? 0) * 100) / 100;
}
function pct(n: number | null | undefined) {
  return n == null ? '—' : `${(n * 100).toFixed(2)}%`;
}
