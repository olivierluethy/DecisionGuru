import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import {
  ArrowLeft,
  Download,
  Pencil,
  Plus,
  Trash2,
  Clock,
  TrendingDown,
} from 'lucide-react';
import { api, downloadExport } from '../lib/api';
import { useApp } from '../store';
import {
  fmtCHF,
  fmtCHFSigned,
  fmtPct,
  fmtPctSigned,
  fmtMonths,
  fmtDate,
  fmtMoney,
  plClass,
} from '../lib/format';
import { DeltaChart } from '../components/DeltaChart';
import { ProjectionChart } from '../components/ProjectionChart';
import { Globe } from '../components/Globe';
import { Segmented, Spinner, Stat, KindBadge, StaleDot, DataStatusBadge } from '../components/ui';
import { BenchmarkSelect } from '../components/BenchmarkSelect';
import { NotesPanel } from '../components/NotesPanel';
import { buildPositionExport } from '../lib/exporters';

export function PositionDetail() {
  const { selectedInstrumentId: id, benchmark, preTax, setPreTax, setView, openModal } = useApp();
  const qc = useQueryClient();

  const position = useQuery({
    queryKey: ['position', id, preTax],
    queryFn: () => api.position(id!, preTax),
    enabled: id != null,
  });
  const cf = useQuery({
    queryKey: ['cf', id, benchmark, preTax],
    queryFn: () => api.counterfactual(id!, benchmark, preTax),
    enabled: id != null,
  });
  const breakeven = useQuery({
    queryKey: ['breakeven', id, benchmark],
    queryFn: () => api.breakeven(id!, benchmark),
    enabled: id != null,
  });
  const txs = useQuery({
    queryKey: ['txs', id],
    queryFn: () => api.getTransactions(id!),
    enabled: id != null,
  });

  const removeTx = useMutation({
    mutationFn: (txId: number) => api.deleteTransaction(txId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['position', id] });
      qc.invalidateQueries({ queryKey: ['cf', id] });
      qc.invalidateQueries({ queryKey: ['txs', id] });
    },
  });

  if (id == null) return null;
  if (position.isLoading || cf.isLoading) return <Spinner label="Analysing position…" />;
  if (position.error) return <div className="p-6 text-loss text-sm">{(position.error as Error).message}</div>;

  const p = position.data!;
  const c = cf.data!;
  const inst = p.instrument;
  const delta = c.deltaCHF;
  const aheadOfEtf = delta >= 0;

  const doExport = async (kind: 'excel' | 'pdf') => {
    const notesList = await api.listNotes('instrument', id);
    const payload = await buildPositionExport(p, c, kind, notesList.map((n) => n.body));
    await downloadExport(kind, payload, `${inst.symbol}-vs-${c.benchmarkSymbol}`);
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <button className="btn-ghost !px-2 mb-3 -ml-2" onClick={() => setView('dashboard')}>
        <ArrowLeft size={15} /> Portfolio
      </button>

      <header className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <KindBadge kind={inst.kind} />
          <div>
            <h1 className="font-display text-2xl font-semibold flex items-center gap-2">
              {inst.symbol}
              {p.dataStatus && p.dataStatus.state !== 'ok' ? (
                <DataStatusBadge
                  status={p.dataStatus}
                  onRetry={async () => {
                    await api.reresolveInstrument(inst.id).catch(() => undefined);
                    qc.invalidateQueries();
                  }}
                />
              ) : (
                <StaleDot stale={p.stale} />
              )}
            </h1>
            <p className="text-sm text-text-muted">{inst.name}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <BenchmarkSelect />
          <Segmented
            value={preTax ? 'pre' : 'after'}
            onChange={(v) => setPreTax(v === 'pre')}
            options={[
              { value: 'after', label: 'After-tax' },
              { value: 'pre', label: 'Pre-tax' },
            ]}
          />
          <button className="btn-secondary" onClick={() => openModal({ kind: 'add-transaction', instrumentId: id })}>
            <Plus size={15} /> Transaction
          </button>
          <button className="btn-secondary" onClick={() => openModal({ kind: 'edit-instrument', instrumentId: id })}>
            <Pencil size={15} /> Edit
          </button>
          <button className="btn-secondary" onClick={() => doExport('pdf')}>
            <Download size={15} /> PDF
          </button>
          <button className="btn-secondary" onClick={() => doExport('excel')}>
            <Download size={15} /> XLS
          </button>
        </div>
      </header>

      {/* Decision panel — opportunity cost crown */}
      <section className={`card mb-6 border-l-2 ${aheadOfEtf ? 'border-l-gain' : 'border-l-loss'}`}>
        <div className="grid lg:grid-cols-[minmax(300px,1fr)_2fr] gap-6">
          <div className="flex flex-col justify-center">
            <div className="eyebrow mb-2">
              Opportunity cost vs {c.benchmarkSymbol} · {preTax ? 'pre-tax' : 'after-tax'} · CHF
            </div>
            <div className={`font-mono font-semibold text-display-xl tnum leading-none ${plClass(delta)}`}>
              {fmtCHFSigned(delta)}
            </div>
            <p className={`mt-3 text-sm ${aheadOfEtf ? 'text-gain' : 'text-loss'}`}>
              {aheadOfEtf
                ? `${inst.symbol} is ahead of ${c.benchmarkName} by ${fmtCHF(Math.abs(delta))} after tax.`
                : `You'd be ${fmtCHF(Math.abs(delta))} better off had this money gone into ${c.benchmarkSymbol}.`}
            </p>
            {!aheadOfEtf && breakeven.data?.monthsToRecover != null && (
              <p className="mt-2 flex items-center gap-1.5 text-sm text-text-muted">
                <Clock size={14} className="text-gold" />
                Sell now → {c.benchmarkSymbol} recovers your shortfall in{' '}
                <span className="text-text font-medium">{fmtMonths(breakeven.data.monthsToRecover)}</span>
                <span className="text-text-faint">
                  (@ {fmtPct(breakeven.data.etfCagr)} p.a.)
                </span>
              </p>
            )}

            <div className="grid grid-cols-2 gap-x-4 gap-y-3 mt-6">
              <Stat label="Invested" value={fmtCHF(p.investedCHF)} />
              <Stat label="Current value" value={fmtCHF(p.currentValueCHF)} />
              <Stat
                label="Unrealized P/L"
                value={fmtCHFSigned(p.unrealizedCHF)}
                valueClass={plClass(p.unrealizedCHF)}
              />
              <Stat
                label="Realized P/L"
                value={fmtCHFSigned(p.realizedCHF)}
                valueClass={plClass(p.realizedCHF)}
              />
              <Stat label="Net dividends" value={fmtCHF(p.dividends.netAfterTaxCHF)} sub={`${p.dividends.count} paid`} />
              <Stat label="Div. income tax" value={fmtCHF(p.dividends.incomeTaxCHF)} valueClass="text-loss" />
              <Stat label="XIRR" value={fmtPctSigned(p.metrics.xirr)} valueClass={plClass(p.metrics.xirr)} />
              <Stat label={`${c.benchmarkSymbol} XIRR`} value={fmtPctSigned(c.benchmarkXirr)} valueClass="text-gold" />
            </div>
          </div>
          <div id="position-chart">
            <div className="flex items-center gap-4 mb-2 text-[11px] text-text-muted">
              <span className="flex items-center gap-1.5">
                <span className="w-4 h-0.5 bg-azure inline-block" /> {inst.symbol} (actual)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-4 h-0 border-t-2 border-dashed border-gold inline-block" /> {c.benchmarkSymbol} (counterfactual)
              </span>
            </div>
            <DeltaChart series={c.series} benchmarkName={c.benchmarkSymbol} height={320} />
          </div>
        </div>
      </section>

      <div className="grid lg:grid-cols-2 gap-6">
        <ProjectionSection id={id} benchmark={benchmark} />
        <DividendShockSection id={id} />
      </div>

      <div className="grid lg:grid-cols-[1fr_360px] gap-6 mt-6">
        <TransactionsCard txs={txs.data ?? []} onDelete={(txId) => removeTx.mutate(txId)} currency={inst.currency} />
        <AllocationCard instrumentId={id} />
      </div>

      <section className="card mt-6">
        <h3 className="font-display text-base font-semibold mb-3">Notes</h3>
        <NotesPanel target="instrument" targetId={id} />
      </section>
    </div>
  );
}

// ---- Projection with expected-return slider -----------------------------

function ProjectionSection({ id, benchmark }: { id: number; benchmark: string }) {
  const [years, setYears] = useState(5);
  const [stockCagr, setStockCagr] = useState<number | null>(null);
  const [etfCagr, setEtfCagr] = useState<number | null>(null);

  const proj = useQuery({
    queryKey: ['projection', id, benchmark, years, stockCagr, etfCagr],
    queryFn: () =>
      api.projection(id, {
        benchmark,
        years,
        stockCagr: stockCagr ?? undefined,
        etfCagr: etfCagr ?? undefined,
      }),
  });

  const data = proj.data;
  const sc = stockCagr ?? data?.assumedStockCagr ?? 0.06;
  const ec = etfCagr ?? data?.assumedEtfCagr ?? 0.06;

  return (
    <section className="card">
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-display text-base font-semibold">Forward projection</h3>
        <span className="chip">hypothetical</span>
      </div>
      <p className="text-xs text-text-muted mb-4">
        Hold the stock vs. sell now and buy {benchmark}. Both start from today's value.
      </p>
      {data ? <ProjectionChart points={data.points} crossoverMonth={data.crossoverMonth} /> : <Spinner />}
      <div className="grid grid-cols-3 gap-3 mt-4">
        <SliderField label={`Stock CAGR ${fmtPct(sc)}`} value={sc} min={-0.1} max={0.25} onChange={setStockCagr} color="azure" />
        <SliderField label={`ETF CAGR ${fmtPct(ec)}`} value={ec} min={-0.05} max={0.2} onChange={setEtfCagr} color="gold" />
        <div>
          <div className="eyebrow mb-2">Horizon {years}y</div>
          <input
            type="range"
            min={1}
            max={20}
            step={1}
            value={years}
            onChange={(e) => setYears(Number(e.target.value))}
            className="w-full accent-azure"
          />
        </div>
      </div>
    </section>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  onChange,
  color,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  color: 'azure' | 'gold';
}) {
  return (
    <div>
      <div className="eyebrow mb-2">{label}</div>
      <input
        type="range"
        min={min}
        max={max}
        step={0.005}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={color === 'azure' ? 'w-full accent-azure' : 'w-full accent-gold'}
      />
    </div>
  );
}

// ---- Dividend shock -----------------------------------------------------

function DividendShockSection({ id }: { id: number }) {
  const [cut, setCut] = useState(1);
  const shock = useQuery({
    queryKey: ['shock', id, cut],
    queryFn: () => api.dividendShock(id, cut),
  });
  const s = shock.data;
  return (
    <section className="card">
      <div className="flex items-center gap-2 mb-1">
        <TrendingDown size={16} className="text-loss" />
        <h3 className="font-display text-base font-semibold">Dividend-shock scenario</h3>
      </div>
      <p className="text-xs text-text-muted mb-4">
        What if this stock cuts or eliminates its dividend? Annual income effect, after tax.
      </p>
      <div className="mb-4">
        <div className="eyebrow mb-2">Dividend cut: {(cut * 100).toFixed(0)}%</div>
        <input type="range" min={0} max={1} step={0.05} value={cut} onChange={(e) => setCut(Number(e.target.value))} className="w-full accent-loss" />
      </div>
      {s ? (
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Current annual gross" value={fmtCHF(s.currentAnnualGrossCHF)} />
          <Stat label="After cut" value={fmtCHF(s.shockedAnnualGrossCHF)} />
          <Stat label="Lost gross / yr" value={fmtCHFSigned(-s.lostGrossCHF)} valueClass="text-loss" />
          <Stat label="Lost net after tax / yr" value={fmtCHFSigned(-s.lostNetAfterTaxCHF)} valueClass="text-loss" />
        </div>
      ) : (
        <Spinner />
      )}
    </section>
  );
}

// ---- Transactions -------------------------------------------------------

function TransactionsCard({
  txs,
  onDelete,
  currency,
}: {
  txs: import('@decisionguru/shared').Transaction[];
  onDelete: (id: number) => void;
  currency: string;
}) {
  return (
    <section className="card !p-0 overflow-hidden">
      <h3 className="font-display text-base font-semibold px-5 pt-4 pb-3">Transactions</h3>
      <div className="overflow-x-auto max-h-[360px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0">
            <tr>
              <th className="th">Date</th>
              <th className="th">Action</th>
              <th className="th text-right">Qty</th>
              <th className="th text-right">Price</th>
              <th className="th text-right">Fees</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {txs.map((t) => (
              <tr key={t.id} className="group hover:bg-surface-2">
                <td className="td font-mono tnum text-text-muted">{fmtDate(t.date)}</td>
                <td className="td">
                  <span
                    className={
                      t.action === 'buy'
                        ? 'text-azure'
                        : t.action === 'sell'
                        ? 'text-gold'
                        : 'text-gain'
                    }
                  >
                    {t.action}
                  </span>
                </td>
                <td className="td text-right font-mono tnum">{t.quantity || '—'}</td>
                <td className="td text-right font-mono tnum">{fmtMoney(t.unitPrice, t.currency || currency)}</td>
                <td className="td text-right font-mono tnum text-text-faint">{t.fees || '—'}</td>
                <td className="td text-right">
                  <button
                    className="text-text-faint hover:text-loss opacity-0 group-hover:opacity-100"
                    onClick={() => onDelete(t.id)}
                    aria-label="Delete transaction"
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
            {!txs.length && (
              <tr>
                <td className="td text-text-faint" colSpan={6}>
                  No transactions.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---- Allocation + globe -------------------------------------------------

function AllocationCard({ instrumentId }: { instrumentId: number }) {
  const alloc = useQuery({ queryKey: ['allocation', instrumentId], queryFn: () => api.allocation(instrumentId) });
  const a = alloc.data;
  return (
    <section className="card flex flex-col items-center">
      <h3 className="font-display text-base font-semibold self-start mb-1">Geographic exposure</h3>
      <p className="text-xs text-text-muted self-start mb-3">
        {a ? `Source: ${a.source}` : 'Loading allocation…'}
      </p>
      {a ? (
        <>
          <Globe allocation={a} size={260} />
          <div className="w-full mt-4 space-y-3">
            <AllocList title="Countries" items={a.countries.slice(0, 6).map((c) => ({ label: c.label, weight: c.weight }))} />
            {a.sectors.length > 0 && (
              <AllocList title="Sectors" items={a.sectors.slice(0, 6).map((s) => ({ label: s.label, weight: s.weight }))} />
            )}
            {a.topHoldings.length > 1 && (
              <AllocList title="Top holdings" items={a.topHoldings.slice(0, 6).map((h) => ({ label: h.name, weight: h.weight }))} />
            )}
          </div>
        </>
      ) : (
        <Spinner />
      )}
    </section>
  );
}

function AllocList({ title, items }: { title: string; items: { label: string; weight: number }[] }) {
  const max = Math.max(...items.map((i) => i.weight), 0.0001);
  return (
    <div>
      <div className="eyebrow mb-2">{title}</div>
      <div className="space-y-1.5">
        {items.map((i, idx) => (
          <div key={idx} className="flex items-center gap-2 text-xs">
            <span className="w-28 truncate text-text-muted" title={i.label}>
              {i.label}
            </span>
            <div className="flex-1 h-1.5 bg-surface-2 rounded-full overflow-hidden">
              <div className="h-full bg-gold/70 rounded-full" style={{ width: `${(i.weight / max) * 100}%` }} />
            </div>
            <span className="font-mono tnum text-text-muted w-12 text-right">{fmtPct(i.weight)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
