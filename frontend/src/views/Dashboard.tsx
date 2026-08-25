import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ArrowUpRight, ArrowDownRight, Wallet, PieChart, AlertTriangle } from 'lucide-react';
import type { RangeKey } from '@decisionguru/shared';
import { api } from '../lib/api';
import { useApp } from '../store';
import { fmtCHF, fmtCHFSigned, fmtPct, fmtPctSigned, fmtNum, plClass } from '../lib/format';
import { ValueChart } from '../components/ValueChart';
import { TimeRangeSelector } from '../components/TimeRangeSelector';
import { RangeStats } from '../components/RangeStats';
import { Segmented, Spinner, EmptyState, KindBadge, DataStatusBadge } from '../components/ui';
import { buildPortfolioExport } from '../lib/exporters';
import { downloadExport } from '../lib/api';

function timeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

export function Dashboard() {
  const { benchmark, preTax, setPreTax, selectInstrument, openModal, compareSelection, toggleCompare, clearCompare } =
    useApp();
  const queryClient = useQueryClient();
  const [range, setRange] = useState<RangeKey>('1Y');

  const { data, isLoading, error } = useQuery({
    queryKey: ['portfolio', benchmark, preTax],
    queryFn: () => api.portfolio(benchmark, preTax),
    refetchInterval: (query) => {
      const d = query.state.data;
      const pending = d?.refreshInProgress || d?.positions.some((p) => p.dataStatus?.state === 'pricing');
      return pending ? 2500 : false;
    },
  });

  const { data: series } = useQuery({
    queryKey: ['portfolio-series', range],
    queryFn: () => api.portfolioSeries(range),
    enabled: !!data?.hasPositions,
  });

  const retryResolve = async (id: number) => {
    await api.reresolveInstrument(id).catch(() => undefined);
    queryClient.invalidateQueries({ queryKey: ['portfolio'] });
  };

  if (isLoading) return <Spinner label="Loading your portfolio…" />;
  if (error) return <div className="text-loss p-6 text-sm">Failed to load: {(error as Error).message}</div>;

  const hasPositions = data?.hasPositions;
  const hasAccount = data?.hasAccount;

  // Nothing imported at all → invite the first action.
  if (!data || (!hasPositions && !hasAccount)) {
    return (
      <EmptyState
        title="No portfolio yet"
        hint="Import your DEGIRO account statement (Kontoauszug) for cash & dividends, and your Transactions export for holdings & valuation. DecisionGuru merges them on ISIN."
        action={
          <div className="flex gap-2">
            <button className="btn-primary" onClick={() => openModal({ kind: 'import' })}>
              Import data
            </button>
            <button className="btn-secondary" onClick={() => openModal({ kind: 'manual-add' })}>
              Add position
            </button>
          </div>
        }
      />
    );
  }

  const { totals, cash } = data;
  // "Today's P/L" = latest daily change on the equity curve (approx: last two points).
  const pts = series?.points ?? [];
  const todayDelta = pts.length >= 2 ? pts[pts.length - 1].value - pts[pts.length - 2].value : null;
  const todayPrev = pts.length >= 2 ? pts[pts.length - 2].value : null;
  const todayPct = todayDelta != null && todayPrev ? todayDelta / todayPrev : null;
  const totalGainPct = totals.investedCHF > 0 ? totals.totalGainCHF / totals.investedCHF : null;

  const doExport = async (kind: 'excel' | 'pdf') => {
    const payload = await buildPortfolioExport(data, kind);
    await downloadExport(kind, payload, `portfolio-${benchmark}`);
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <header className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <div className="eyebrow mb-1">Overview · Gesamtübersicht</div>
          <h1 className="font-display text-2xl font-semibold">Portfolio overview</h1>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-text-faint">
            {data.quotesUpdatedAt ? `Prices updated ${timeAgo(data.quotesUpdatedAt)}` : 'Fetching prices…'}
            {data.refreshInProgress && (
              <>
                <span className="text-text-faint/50">·</span>
                <span className="inline-flex items-center gap-1 text-azure">
                  <span className="w-1.5 h-1.5 rounded-full bg-azure animate-pulse" />
                  Refreshing…
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Segmented
            value={preTax ? 'pre' : 'after'}
            onChange={(v) => setPreTax(v === 'pre')}
            options={[
              { value: 'after', label: 'After-tax' },
              { value: 'pre', label: 'Pre-tax' },
            ]}
          />
          {hasPositions && (
            <div className="flex gap-1">
              <button className="btn-secondary" onClick={() => doExport('excel')} title="Export Excel">
                <Download size={15} /> XLS
              </button>
              <button className="btn-secondary" onClick={() => doExport('pdf')} title="Export PDF">
                <Download size={15} /> PDF
              </button>
            </div>
          )}
        </div>
      </header>

      {data.unknownEvents > 0 && (
        <div className="mb-4 flex items-center gap-2 text-warn text-sm bg-warn/10 border border-warn/30 rounded p-3">
          <AlertTriangle size={16} />
          {data.unknownEvents} account event{data.unknownEvents > 1 ? 's' : ''} had an unrecognised
          description and are shown as “unknown” — they aren’t counted in cash or dividends.
        </div>
      )}

      {/* Summary band — two color-separated pools + today's P/L + total gain */}
      <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        {/* Kontoguthaben (cash) — neutral/cool, distinct from the azure invested pool */}
        <button
          className="card text-left border-l-2 border-l-hairline-strong bg-surface hover:border-hairline-strong transition-colors"
          onClick={() => openModal({ kind: 'cash-detail' })}
        >
          <div className="flex items-center gap-1.5 eyebrow mb-2">
            <Wallet size={12} /> Kontoguthaben · cash · CHF
          </div>
          <div className="font-mono font-semibold text-2xl tnum">{fmtCHF(cash.totalCHF, true)}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {Object.entries(cash.byCurrency)
              .sort((a, b) => b[1].chf - a[1].chf)
              .map(([ccy, v]) => (
                <span key={ccy} className="chip !py-0 !px-2 font-mono">
                  {ccy} {fmtNum(v.amount)}
                </span>
              ))}
            {Object.keys(cash.byCurrency).length === 0 && (
              <span className="text-xs text-text-faint">Import account statement for cash</span>
            )}
          </div>
        </button>

        {/* Finanzrat Portfolio (invested) — azure, "you" */}
        <div className="card border-l-2 border-l-azure bg-azure/5">
          <div className="flex items-center gap-1.5 eyebrow mb-2 text-azure/80">
            <PieChart size={12} /> Finanzrat Portfolio · invested · CHF
          </div>
          <div className="font-mono font-semibold text-2xl tnum">{fmtCHF(totals.currentValueCHF, true)}</div>
          <div className="mt-2 text-xs text-text-muted">
            Invested {fmtCHF(totals.investedCHF)} · {data.positions.length} holdings
          </div>
        </div>

        {/* Today's P/L */}
        <div className="card">
          <div className="eyebrow mb-2">Today’s P/L · CHF</div>
          <div className={`font-mono font-semibold text-2xl tnum ${plClass(todayDelta)}`}>
            {todayDelta == null ? '—' : fmtCHFSigned(todayDelta)}
          </div>
          <div className={`mt-2 text-xs ${plClass(todayDelta)}`}>
            {todayPct == null ? 'Awaiting price history' : fmtPctSigned(todayPct)}
          </div>
        </div>

        {/* Total gain (Gesamtgewinn) */}
        <div className="card">
          <div className="eyebrow mb-2">Total gain · Gesamtgewinn · CHF</div>
          <div className={`font-mono font-semibold text-2xl tnum ${plClass(totals.totalGainCHF)}`}>
            {fmtCHFSigned(totals.totalGainCHF)}
          </div>
          <div className={`mt-2 flex items-center gap-1 text-xs ${plClass(totals.totalGainCHF)}`}>
            {totals.totalGainCHF >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
            {totalGainPct == null ? '—' : fmtPctSigned(totalGainPct)} · incl. {fmtCHF(totals.netDividendsCHF)} dividends
          </div>
        </div>
      </section>

      {/* Account-only (no Transactions export yet) → guide to complete the picture */}
      {!hasPositions && hasAccount && (
        <section className="card mb-6 border-l-2 border-l-warn">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-warn shrink-0 mt-0.5" />
            <div>
              <div className="font-medium text-text">Cash & dividends imported — holdings still missing</div>
              <p className="text-sm text-text-muted mt-1">
                Portfolio valuation and per-holding performance need the DEGIRO{' '}
                <span className="font-mono">Transactions</span> export too. Import it to merge on ISIN.
              </p>
              <button className="btn-primary mt-3" onClick={() => openModal({ kind: 'import' })}>
                Import Transactions
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Portfolio equity curve with time-range selector */}
      {hasPositions && (
        <section className="card mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div className="eyebrow">Portfolio value · CHF</div>
            <TimeRangeSelector value={range} onChange={setRange} />
          </div>
          <ValueChart series={series} height={280} />
          <div className="mt-4 pt-3 border-t border-hairline">
            <RangeStats stats={series?.stats ?? null} />
          </div>
        </section>
      )}

      {/* Holdings collection */}
      {hasPositions && (
        <section className="card !p-0 overflow-hidden">
          <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10">
                <tr>
                  <th className="th w-9"></th>
                  <th className="th">Instrument</th>
                  <th className="th text-right">Qty</th>
                  <th className="th text-right">Cost basis</th>
                  <th className="th text-right">Value</th>
                  <th className="th text-right">Unrealized P/L</th>
                  <th className="th text-right">Net div.</th>
                  <th className="th text-right">Weight</th>
                </tr>
              </thead>
              <tbody>
                {data.positions.map((p) => {
                  const costBasis =
                    p.currentValueCHF != null && p.unrealizedCHF != null
                      ? p.currentValueCHF - p.unrealizedCHF
                      : p.investedCHF;
                  return (
                    <tr
                      key={p.instrument.id}
                      className={`hover:bg-surface-2 cursor-pointer transition-colors ${
                        compareSelection.includes(p.instrument.id) ? 'bg-surface-2/60' : ''
                      }`}
                      onClick={() => selectInstrument(p.instrument.id)}
                    >
                      <td className="td text-center" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="accent-azure align-middle"
                          checked={compareSelection.includes(p.instrument.id)}
                          onChange={() => toggleCompare(p.instrument.id)}
                          aria-label={`Select ${p.instrument.symbol} for comparison`}
                        />
                      </td>
                      <td className="td">
                        <div className="flex items-center gap-2">
                          <KindBadge kind={p.instrument.kind} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-text">{p.instrument.symbol}</span>
                              <DataStatusBadge status={p.dataStatus} onRetry={() => retryResolve(p.instrument.id)} />
                            </div>
                            <div className="text-xs text-text-faint truncate max-w-[240px]">
                              {p.instrument.name}
                              {p.instrument.isin && <span className="ml-1.5 font-mono">· {p.instrument.isin}</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="td text-right font-mono tnum text-text-muted">{fmtNum(p.openQuantity)}</td>
                      <td className="td text-right font-mono tnum text-text-muted">{fmtCHF(costBasis)}</td>
                      <td className="td text-right font-mono tnum">{fmtCHF(p.currentValueCHF)}</td>
                      <td className={`td text-right font-mono tnum ${plClass(p.unrealizedCHF)}`}>
                        {fmtCHFSigned(p.unrealizedCHF)}
                      </td>
                      <td className="td text-right font-mono tnum text-gain">
                        {p.netDividendsCHF ? fmtCHF(p.netDividendsCHF) : '—'}
                      </td>
                      <td className="td text-right font-mono tnum text-text-muted">{fmtPct(p.weight)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Dividend history by security (works even in the account-only state) */}
      {data.accountDividends.length > 0 && (
        <section className="card !p-0 overflow-hidden mt-6">
          <div className="px-4 py-3 border-b border-hairline flex items-center justify-between">
            <div className="eyebrow">Dividends by security · net CHF</div>
            <div className="text-xs text-text-faint">from account statement</div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10">
                <tr>
                  <th className="th">Security</th>
                  <th className="th text-right">Gross</th>
                  <th className="th text-right">Tax</th>
                  <th className="th text-right">Net CHF</th>
                  <th className="th text-right">Payments</th>
                </tr>
              </thead>
              <tbody>
                {data.accountDividends.map((d) => (
                  <tr key={d.isin}>
                    <td className="td">
                      <div className="text-text truncate max-w-[280px]">{d.name ?? d.isin}</div>
                      <div className="font-mono text-[11px] text-text-faint">{d.isin}</div>
                    </td>
                    <td className="td text-right font-mono tnum text-text-muted">{fmtCHF(d.grossCHF)}</td>
                    <td className="td text-right font-mono tnum text-loss">{fmtCHF(d.taxCHF)}</td>
                    <td className="td text-right font-mono tnum text-gain">{fmtCHF(d.netCHF)}</td>
                    <td className="td text-right font-mono tnum text-text-muted">{d.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {compareSelection.length > 0 && (
        <div className="sticky bottom-4 mt-4 flex justify-center pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-3 bg-surface border border-hairline-strong rounded-lg shadow-modal px-4 py-2.5">
            <span className="text-sm text-text-muted">
              <span className="font-mono text-text">{compareSelection.length}</span> selected
            </span>
            <button
              className="btn-primary !h-8"
              onClick={() => openModal({ kind: 'compare', instrumentIds: compareSelection })}
            >
              Compare vs ETF
            </button>
            <button className="btn-ghost !h-8" onClick={clearCompare}>
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
