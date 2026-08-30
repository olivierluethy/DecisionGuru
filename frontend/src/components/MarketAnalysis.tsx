import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { api, type MarketAnalysisResult, type MarketClassification } from '../lib/api';
import { Spinner, EmptyState } from './ui';
import { fmtPct, fmtPctSigned, fmtMoney, fmtDate } from '../lib/format';
import { useApp } from '../store';
import { ComparisonSelect } from './ComparisonSelect';

const RANGES = ['1M', '3M', '6M', '1Y', '3Y', '5Y'] as const;
type MarketRange = (typeof RANGES)[number];

const CLASS_META: Record<MarketClassification, { label: string; tone: string; blurb: string }> = {
  'market-wide-weakness': { label: 'Market-wide weakness', tone: 'text-warn',
    blurb: 'The whole sector is down — the weakness is largely the market, not the company alone.' },
  'company-specific-weakness': { label: 'Company-specific weakness', tone: 'text-loss',
    blurb: 'The sector is holding up while this company lags — the weakness looks specific to it.' },
  'outperforming-sector': { label: 'Outperforming its sector', tone: 'text-gain',
    blurb: 'Ahead of its sector benchmark over this horizon.' },
  'outperforming-peers': { label: 'Outperforming peers', tone: 'text-gain',
    blurb: 'Ahead of both its sector and the median competitor over this horizon.' },
  inline: { label: 'In line with its market', tone: 'text-text-muted',
    blurb: 'Tracking its sector and peers over this horizon.' },
};

// Distinct dark-legible line colours; azure is always the subject.
const LINE_COLORS = ['#4FD0E0', '#D9A94E', '#A98BFF', '#B6D94E', '#EC6DB0'];

export function MarketAnalysis({ symbol }: { symbol: string }) {
  const [range, setRange] = useState<MarketRange>('1Y');
  const researchSymbolView = useApp((s) => s.researchSymbolView);
  const defaultBenchmark = useApp((s) => s.benchmark);
  // Comparison lines are user-selectable: seed with the global benchmark (e.g. VWRL.SW), then
  // freely add/remove ETFs or companies — even from another market — via the selector below.
  const [compare, setCompare] = useState<string[]>(defaultBenchmark ? [defaultBenchmark] : []);
  const compareColorOf = (sym: string) => {
    const i = compare.indexOf(sym);
    return i >= 0 ? LINE_COLORS[(i + 1) % LINE_COLORS.length] : '#5F6E82';
  };
  const { data, isLoading, isError } = useQuery({
    queryKey: ['market-analysis', symbol, range, compare.join(',')],
    queryFn: () => api.marketAnalysis(symbol, range, compare),
    staleTime: 60 * 60_000,
    retry: 1,
    // Keep the prior chart on screen while a changed comparison set reloads, so the selector
    // never flashes back to a spinner mid-edit.
    placeholderData: keepPreviousData,
    // Peer price history is warmed in the background on first open; poll until peer returns
    // land (or give up after a bounded number of tries) so the table fills in on its own.
    refetchInterval: (query) => {
      const d = query.state.data as MarketAnalysisResult | undefined;
      if (!d) return false;
      const peers = d.competitors.filter((c) => !c.isSubject);
      const incomplete = peers.length > 0 && peers.some((c) => c.returns[d.range] == null);
      return incomplete && query.state.dataUpdateCount < 12 ? 4000 : false;
    },
  });

  if (isLoading) return <Spinner label="Reading the market…" />;
  if (isError || !data) return <EmptyState title="Market analysis unavailable" hint="Try again shortly." />;

  const cls = data.classification ? CLASS_META[data.classification] : null;

  // Build a merged {date → {subject, sp500, world, sector}} for the multi-line chart.
  const lines: { key: string; label: string; color: string; series: { date: string; value: number }[] }[] = [];
  lines.push({ key: 'subject', label: data.symbol, color: '#4FD0E0', series: data.subject.series });
  data.benchmarks.forEach((b, i) => {
    if (b.series.length > 1) lines.push({ key: b.key, label: b.symbol, color: LINE_COLORS[(i + 1) % LINE_COLORS.length], series: b.series });
  });
  if (data.sectorLine.kind === 'etf' && data.sectorLine.series.length > 1) {
    lines.push({ key: 'sector', label: data.sectorLine.label, color: '#B6D94E', series: data.sectorLine.series });
  }
  const byDate = new Map<string, Record<string, number | string>>();
  for (const ln of lines) for (const p of ln.series) {
    const row = byDate.get(p.date) ?? { date: p.date };
    row[ln.key] = p.value;
    byDate.set(p.date, row);
  }
  const chartData = [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));

  return (
    <div className="space-y-5">
      {/* Comparison selector — subject vs. any benchmark ETFs and/or companies (any market). */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow mr-1">Compare</span>
        <ComparisonSelect subject={data.symbol} selected={compare} onChange={setCompare} colorOf={compareColorOf} />
      </div>

      {/* Company context */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div><span className="eyebrow mr-2">Company</span><span className="text-text">{data.name}</span></div>
        <div><span className="eyebrow mr-2">Sector</span><span className="text-text">{data.sector ?? 'unavailable'}</span></div>
        <div><span className="eyebrow mr-2">Industry</span><span className="text-text">{data.industry ?? 'unavailable'}</span></div>
      </div>

      {/* Range selector */}
      <div className="flex flex-wrap gap-1.5">
        {RANGES.map((r) => (
          <button key={r} onClick={() => setRange(r)}
            className={`chip cursor-pointer ${range === r ? '!border-azure/50 !text-text' : 'opacity-50'}`}>{r}</button>
        ))}
      </div>

      {/* Market-vs-company headline */}
      {cls && (
        <div className={`card !p-4 border-l-2 ${cls.tone === 'text-loss' ? 'border-l-loss' : cls.tone === 'text-gain' ? 'border-l-gain' : 'border-l-warn'}`}>
          <div className={`font-semibold ${cls.tone}`}>{cls.label}</div>
          <p className="text-sm text-text-muted mt-1">{cls.blurb}</p>
          <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-[12px]">
            <span><span className="eyebrow mr-1">This stock</span><span className={data.subject.returnPct == null ? 'text-text-faint' : data.subject.returnPct < 0 ? 'text-loss' : 'text-gain'}>{fmtPctSigned(data.subject.returnPct)}</span></span>
            <span><span className="eyebrow mr-1">Sector</span>{fmtPctSigned(data.sectorLine.returnPct)} <span className="text-text-faint">({data.sectorLine.kind === 'peer-median' ? 'peer median' : data.sectorLine.kind === 'etf' ? data.sectorLine.symbol : 'n/a'})</span></span>
            <span><span className="eyebrow mr-1">Peer median</span>{fmtPctSigned(data.peerMedianReturnPct)}</span>
            {data.benchmarks.map((b) => (
              <span key={b.key}><span className="eyebrow mr-1">{b.symbol}</span>{fmtPctSigned(b.returnPct)}</span>
            ))}
          </div>
        </div>
      )}

      {/* Rebased performance chart */}
      {chartData.length > 1 ? (
        <div style={{ width: '100%', height: 240 }}>
          <ResponsiveContainer>
            <LineChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#243040" strokeDasharray="2 4" strokeOpacity={0.5} vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#5F6E82' }} minTickGap={48}
                tickFormatter={(d) => fmtDate(d).replace(/ \d{4}$/, '')} stroke="#243040" />
              <YAxis tick={{ fontSize: 10, fill: '#5F6E82' }} width={40} stroke="#243040"
                tickFormatter={(v) => `${v}`} />
              <Tooltip contentStyle={{ background: '#1A2331', border: '1px solid #243040', borderRadius: 6, fontSize: 12 }}
                labelFormatter={(d) => fmtDate(d as string)} formatter={(v: number) => [`${Number(v).toFixed(1)}`, '']} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {lines.map((ln) => (
                <Line key={ln.key} type="monotone" dataKey={ln.key} name={ln.label} stroke={ln.color}
                  strokeWidth={ln.key === 'subject' ? 2.4 : 1.5} dot={false} isAnimationActive={false} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <p className="text-[11px] text-text-faint mt-1">Rebased to 100 at the start of the window · price return (currency-neutral).</p>
        </div>
      ) : (
        <p className="text-[12px] text-text-faint">Not enough cached price history to chart this window yet — it fills in shortly.</p>
      )}

      {/* Competitor table */}
      <div>
        <div className="eyebrow mb-2">Comparable companies · same market, ranked by market cap (CHF)</div>
        {data.competitors.length === 0 ? (
          <p className="text-sm text-text-faint">No comparable companies with cached data yet. Open a few same-industry names in Research/Discover to build the peer set.</p>
        ) : (
          <div className="border border-hairline rounded overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="th">Company</th>
                    <th className="th text-right">Mkt cap</th>
                    <th className="th text-right">P/E</th>
                    <th className="th text-right">Net margin</th>
                    <th className="th text-right">{range} return</th>
                    <th className="th text-right">vs this stock</th>
                  </tr>
                </thead>
                <tbody>
                  {data.competitors.map((c) => (
                    <tr key={c.symbol} className={c.isSubject ? 'bg-surface-2' : ''}>
                      <td className="td">
                        <button
                          type="button"
                          onClick={() => researchSymbolView(c.symbol)}
                          title={`Open ${c.symbol} in Research`}
                          className="group inline-flex items-center gap-2 text-left cursor-pointer"
                        >
                          <span className="font-mono text-text group-hover:text-azure underline-offset-2 group-hover:underline">{c.symbol}</span>
                          {c.isSubject && <span className="text-[10px] uppercase text-azure">this</span>}
                          {c.name && <span className="text-text-faint truncate group-hover:text-text-muted">{c.name}</span>}
                        </button>
                      </td>
                      <td className="td text-right font-mono tnum">
                        {c.marketCapCHF != null
                          ? fmtMoney(c.marketCapCHF, 'CHF', false)
                          : c.marketCap != null
                            ? fmtMoney(c.marketCap, c.currency ?? 'USD', false)
                            : '—'}
                      </td>
                      <td className="td text-right font-mono tnum">{c.trailingPE != null ? c.trailingPE.toFixed(1) : '—'}</td>
                      <td className="td text-right font-mono tnum">{fmtPct(c.profitMargins, 1)}</td>
                      <td className={`td text-right font-mono tnum ${c.returns[range] == null ? 'text-text-faint' : c.returns[range]! < 0 ? 'text-loss' : 'text-gain'}`}>{fmtPctSigned(c.returns[range] ?? null)}</td>
                      <td className={`td text-right font-mono tnum ${c.relativeToSubjectPct == null ? 'text-text-faint' : c.relativeToSubjectPct < 0 ? 'text-loss' : 'text-gain'}`}>{c.isSubject ? '—' : fmtPctSigned(c.relativeToSubjectPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <p className="text-[11px] text-text-faint mt-1">Peers share the same market (sector + industry) and have cached data; ranked by market cap converted to CHF (omitted when no FX rate).</p>
      </div>

      {/* Opportunity-cost / valuation tie-in */}
      {data.valuation && data.valuation.band && (
        <div className="card !p-4">
          <div className="eyebrow mb-1">Opportunity cost · valuation</div>
          <p className="text-sm text-text-muted">
            Valuation reads <span className="text-text">{data.valuation.band.band.replace(/-/g, ' ')}</span>
            {data.valuation.marginOfSafety != null && (
              <> · margin of safety <span className={data.valuation.marginOfSafety < 0 ? 'text-loss' : 'text-gain'}>{fmtPctSigned(data.valuation.marginOfSafety)}</span></>
            )}. Read this together with the relative performance above: a name that is both expensive and lagging its market carries a higher opportunity cost than one that is merely lagging a strong sector.
          </p>
        </div>
      )}
    </div>
  );
}
