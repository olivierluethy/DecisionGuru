import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../store';
import { fmtCHF, fmtCHFSigned, fmtPct, fmtPctSigned, plClass } from '../lib/format';
import { DeltaChart } from '../components/DeltaChart';
import { Segmented, Spinner, EmptyState, KindBadge, Stat, DataStatusBadge } from '../components/ui';
import { BenchmarkSelect } from '../components/BenchmarkSelect';
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

  const { data, isLoading, error } = useQuery({
    queryKey: ['portfolio', benchmark, preTax],
    queryFn: () => api.portfolio(benchmark, preTax),
    // Poll while the background pool is refreshing prices, until they land.
    refetchInterval: (query) => {
      const d = query.state.data;
      const pending = d?.refreshInProgress || d?.positions.some((p) => p.dataStatus?.state === 'pricing');
      return pending ? 2500 : false;
    },
  });

  const retryResolve = async (id: number) => {
    await api.reresolveInstrument(id).catch(() => undefined);
    queryClient.invalidateQueries({ queryKey: ['portfolio'] });
  };

  if (isLoading) return <Spinner label="Computing after-tax counterfactuals…" />;
  if (error) return <div className="text-loss p-6 text-sm">Failed to load: {(error as Error).message}</div>;
  if (!data || data.positions.length === 0) {
    return (
      <EmptyState
        title="No positions yet"
        hint="Import a broker history (XLS/CSV/PDF) or add a single position to begin. DecisionGuru will show, after Swiss tax, how each holding compares to the same money in an ETF."
        action={
          <div className="flex gap-2">
            <button className="btn-primary" onClick={() => openModal({ kind: 'import' })}>
              Import history
            </button>
            <button className="btn-secondary" onClick={() => openModal({ kind: 'manual-add' })}>
              Add position
            </button>
          </div>
        }
      />
    );
  }

  const { aggregate, totals } = data;
  const delta = aggregate.deltaCHF;
  const aheadOfEtf = delta >= 0;
  const cfById = new Map(data.counterfactuals.map((c) => [c.instrumentId, c.counterfactual]));

  const doExport = async (kind: 'excel' | 'pdf') => {
    const payload = await buildPortfolioExport(data, kind);
    await downloadExport(kind, payload, `portfolio-vs-${benchmark}`);
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <header className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <div className="eyebrow mb-1">Portfolio</div>
          <h1 className="font-display text-2xl font-semibold">Actual vs. ETF counterfactual</h1>
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
          <BenchmarkSelect />
          <Segmented
            value={preTax ? 'pre' : 'after'}
            onChange={(v) => setPreTax(v === 'pre')}
            options={[
              { value: 'after', label: 'After-tax' },
              { value: 'pre', label: 'Pre-tax' },
            ]}
          />
          <div className="flex gap-1">
            <button className="btn-secondary" onClick={() => doExport('excel')} title="Export Excel">
              <Download size={15} /> XLS
            </button>
            <button className="btn-secondary" onClick={() => doExport('pdf')} title="Export PDF">
              <Download size={15} /> PDF
            </button>
          </div>
        </div>
      </header>

      {/* Hero — the opportunity cost, unmissable */}
      <section
        className={`card mb-6 border-l-2 ${aheadOfEtf ? 'border-l-gain' : 'border-l-loss'}`}
      >
        <div className="grid lg:grid-cols-[minmax(280px,1fr)_2fr] gap-6">
          <div className="flex flex-col justify-center">
            <div className="eyebrow mb-2">
              Opportunity cost vs {data.benchmark} · {preTax ? 'pre-tax' : 'after-tax'} · CHF
            </div>
            <div className={`font-mono font-semibold text-display-xl tnum leading-none ${plClass(delta)}`}>
              {fmtCHFSigned(delta)}
            </div>
            <div className={`mt-2 flex items-center gap-1.5 text-sm ${plClass(delta)}`}>
              {aheadOfEtf ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}
              {aheadOfEtf
                ? `Your picks are ahead of ${data.benchmark} by ${fmtPct(Math.abs(aggregate.deltaPct))}`
                : `You'd have ${fmtPct(Math.abs(aggregate.deltaPct))} more in ${data.benchmark}`}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 mt-6">
              <Stat label="Invested" value={fmtCHF(totals.investedCHF)} />
              <Stat label="Current value" value={fmtCHF(totals.currentValueCHF)} />
              <Stat label="Net dividends" value={fmtCHF(totals.netDividendsCHF)} />
              <Stat label="Total P/L" value={fmtCHFSigned(totals.absolutePLChf)} valueClass={plClass(totals.absolutePLChf)} />
            </div>
          </div>
          <div id="export-chart">
            <div className="flex items-center gap-4 mb-2 text-[11px] text-text-muted">
              <span className="flex items-center gap-1.5">
                <span className="w-4 h-0.5 bg-azure inline-block" /> Actual portfolio
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-4 h-0 border-t-2 border-dashed border-gold inline-block" /> {data.benchmark}
              </span>
            </div>
            <DeltaChart series={aggregate.series} benchmarkName={data.benchmark} height={280} />
          </div>
        </div>
      </section>

      {/* Positions table */}
      <section className="card !p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="th w-9"></th>
                <th className="th">Instrument</th>
                <th className="th text-right">Invested</th>
                <th className="th text-right">Value</th>
                <th className="th text-right">P/L</th>
                <th className="th text-right">Opp. cost vs ETF</th>
                <th className="th text-right">XIRR</th>
                <th className="th text-right">ETF XIRR</th>
              </tr>
            </thead>
            <tbody>
              {data.positions.map((p) => {
                const cf = cfById.get(p.instrument.id);
                const oc = cf?.deltaCHF ?? null;
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
                          <div className="text-xs text-text-faint truncate max-w-[240px]">{p.instrument.name}</div>
                        </div>
                      </div>
                    </td>
                    <td className="td text-right font-mono tnum">{fmtCHF(p.investedCHF)}</td>
                    <td className="td text-right font-mono tnum">{fmtCHF(p.currentValueCHF)}</td>
                    <td className={`td text-right font-mono tnum ${plClass(p.metrics.absolutePLChf)}`}>
                      {fmtCHFSigned(p.metrics.absolutePLChf)}
                    </td>
                    <td className={`td text-right font-mono tnum font-medium ${plClass(oc)}`}>
                      {oc == null ? '—' : fmtCHFSigned(oc)}
                    </td>
                    <td className={`td text-right font-mono tnum ${plClass(p.metrics.xirr)}`}>
                      {fmtPctSigned(p.metrics.xirr)}
                    </td>
                    <td className="td text-right font-mono tnum text-gold">
                      {fmtPctSigned(cf?.benchmarkXirr)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

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
