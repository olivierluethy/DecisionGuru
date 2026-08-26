import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowRight, Wallet, TrendingDown, ShieldCheck, Scissors, Activity } from 'lucide-react';
import { api, type Recommendation, type RecAction } from '../lib/api';
import { Stat, Spinner, EmptyState } from '../components/ui';
import { ExposureBars } from '../components/ExposureBars';
import { fmtCHF, fmtCHFSigned, fmtPct, fmtPctSigned, fmtMonths, plClass } from '../lib/format';
import { useApp } from '../store';

const ACTION_META: Record<RecAction, { label: string; cls: string; border: string; Icon: typeof Scissors }> = {
  sell: { label: 'Sell', cls: 'text-loss', border: 'border-l-loss', Icon: TrendingDown },
  trim: { label: 'Trim', cls: 'text-warn', border: 'border-l-warn', Icon: Scissors },
  hold: { label: 'Hold', cls: 'text-text-muted', border: 'border-l-hairline-strong', Icon: ShieldCheck },
  buy: { label: 'Buy', cls: 'text-gain', border: 'border-l-gain', Icon: Wallet },
};

function RecCard({ rec }: { rec: Recommendation }) {
  const { selectInstrument, openModal } = useApp();
  const meta = ACTION_META[rec.action];
  const actionable = rec.action === 'sell' || rec.action === 'trim';
  const target = rec.action === 'sell' || rec.action === 'trim';

  return (
    <div className={clsx('card border-l-2', meta.border)}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={clsx('chip !py-0.5', meta.cls)}>
              <meta.Icon size={12} /> {meta.label}
            </span>
            <button
              onClick={() => selectInstrument(rec.instrumentId)}
              className="font-mono text-sm text-azure hover:text-azure-bright"
            >
              {rec.symbol}
            </button>
            <span className="text-sm text-text-muted truncate">{rec.name}</span>
            <span className="text-[11px] text-text-faint uppercase tracking-wide">{rec.conviction} conviction</span>
          </div>
          <p className="text-[13px] text-text-muted mt-2 leading-relaxed max-w-3xl">{rec.reason}</p>
        </div>
        <div className="text-right shrink-0">
          <div className="eyebrow mb-1">{actionable ? 'Capital at stake' : 'Vs benchmark'}</div>
          <div className={clsx('font-mono text-xl font-semibold tnum', actionable ? 'text-warn' : plClass(-rec.opportunityCostCHF))}>
            {actionable ? fmtCHF(rec.impactCHF) : fmtCHFSigned(-rec.opportunityCostCHF)}
          </div>
          {rec.recoveryMonths != null && (
            <div className="text-[11px] text-text-faint mt-0.5">recover in {fmtMonths(rec.recoveryMonths)}</div>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Stat label="Invested" value={fmtCHF(rec.investedCHF)} />
        <Stat label="Current value" value={fmtCHF(rec.currentValueCHF)} sub={`${fmtPct(rec.weight)} of book`} />
        <Stat label="Your return" value={fmtPctSigned(rec.holdingReturnPct)} valueClass={plClass(rec.holdingReturnPct)} />
        <Stat
          label={`${rec.benchmarkSymbol}`}
          value={fmtPctSigned(rec.benchmarkReturnPct)}
          valueClass="text-gold"
        />
      </div>

      {target && (
        <div className="mt-4 pt-3 border-t border-hairline flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="text-text-faint">Reinvest into</span>
            <ArrowRight size={13} className="text-text-faint" />
            <span className="font-mono text-gold">{rec.benchmarkSymbol}</span>
            <span className="text-text-muted">{rec.benchmarkName}</span>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn-secondary h-8" onClick={() => openModal({ kind: 'recovery', instrumentId: rec.instrumentId })}>
              <Activity size={14} /> Analyze recovery
            </button>
            <button
              className="btn-primary h-8"
              onClick={() =>
                openModal({
                  kind: 'create-plan',
                  sellInstrumentIds: [rec.instrumentId],
                  targets: [{ symbol: rec.benchmarkSymbol, name: rec.benchmarkName, allocationPct: 1 }],
                })
              }
            >
              Add to plan
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Decisions() {
  const { data, isLoading } = useQuery({ queryKey: ['recommendations'], queryFn: api.recommendations });
  const { data: exposure } = useQuery({ queryKey: ['exposure'], queryFn: api.exposure });
  const { openModal } = useApp();

  if (isLoading) return <div className="p-6"><Spinner label="Analyzing your portfolio…" /></div>;
  if (!data) return null;

  const recs = data.recommendations;
  const actionable = recs.filter((r) => r.action === 'sell' || r.action === 'trim');
  const holds = recs.filter((r) => r.action === 'hold');
  const { summary, cashSignal } = data;

  if (!recs.length && !cashSignal) {
    return (
      <div className="p-6 max-w-[1100px] mx-auto">
        <EmptyState
          title="No holdings to advise on yet"
          hint="Import your transactions and account statement — the decision engine ranks every holding Buy, Hold or Sell with the money at stake behind each call."
        />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      <header className="mb-6">
        <div className="eyebrow mb-1">Strategy assistant</div>
        <h1 className="font-display text-2xl font-semibold">Decisions</h1>
        <p className="text-sm text-text-muted mt-1 max-w-2xl">
          Every holding ranked by the capital at stake — each call names the reason, the CHF impact,
          and exactly what to buy instead. Not financial advice; figures are model estimates after Swiss tax.
        </p>
      </header>

      {/* Summary band */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="card">
          <div className="eyebrow mb-1">To reallocate</div>
          <div className="font-mono text-2xl font-semibold tnum text-warn">{fmtCHF(summary.reallocatableCHF)}</div>
          <div className="text-xs text-text-muted mt-0.5">{summary.counts.sell} sell · {summary.counts.trim} trim</div>
        </div>
        <div className="card">
          <div className="eyebrow mb-1">Opportunity cost</div>
          <div className="font-mono text-2xl font-semibold tnum text-loss">{fmtCHF(summary.totalOpportunityCostCHF)}</div>
          <div className="text-xs text-text-muted mt-0.5">behind the benchmark, flagged holdings</div>
        </div>
        <div className="card">
          <div className="eyebrow mb-1">Holding steady</div>
          <div className="font-mono text-2xl font-semibold tnum text-text">{summary.counts.hold}</div>
          <div className="text-xs text-text-muted mt-0.5">tracking or ahead — no action</div>
        </div>
        <div className="card border-l-2 border-l-azure bg-azure/5">
          <div className="eyebrow mb-1">Idle cash</div>
          <div className="font-mono text-2xl font-semibold tnum text-azure">{fmtCHF(summary.idleCashCHF)}</div>
          <div className="text-xs text-text-muted mt-0.5">not yet invested</div>
        </div>
      </div>

      {/* Cash deploy signal */}
      {cashSignal && (
        <div className="card border-l-2 border-l-gain mb-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2">
                <span className="chip !py-0.5 text-gain"><Wallet size={12} /> Buy</span>
                <span className="font-mono text-sm text-gold">{cashSignal.symbol}</span>
                <span className="text-sm text-text-muted">{cashSignal.name}</span>
              </div>
              <p className="text-[13px] text-text-muted mt-2 max-w-3xl leading-relaxed">{cashSignal.reason}</p>
            </div>
            <button
              className="btn-primary h-8"
              onClick={() =>
                openModal({
                  kind: 'create-plan',
                  sellInstrumentIds: [],
                  targets: [{ symbol: cashSignal.symbol, name: cashSignal.name, allocationPct: 1 }],
                })
              }
            >
              Plan deployment
            </button>
          </div>
        </div>
      )}

      {/* Actionable recommendations */}
      {actionable.length > 0 && (
        <section className="mb-8">
          <div className="eyebrow mb-3">Act on these · ranked by money at stake</div>
          <div className="flex flex-col gap-4">
            {actionable.map((r) => <RecCard key={r.instrumentId} rec={r} />)}
          </div>
        </section>
      )}

      {/* Portfolio exposure / concentration */}
      {exposure && (exposure.countries.length > 0 || exposure.sectors.length > 0) && (
        <section className="mb-8">
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <div className="eyebrow">Portfolio exposure</div>
              <div className="text-[11px] text-text-faint">
                top holding {fmtPct(exposure.concentration.topHoldingWeight)} · concentration {(exposure.concentration.country * 100).toFixed(0)}
              </div>
            </div>
            <ExposureBars countries={exposure.countries} sectors={exposure.sectors} />
          </div>
        </section>
      )}

      {/* Holds (secondary) */}
      {holds.length > 0 && (
        <section>
          <div className="eyebrow mb-3">Holding · {holds.length}</div>
          <div className="flex flex-col gap-4">
            {holds.map((r) => <RecCard key={r.instrumentId} rec={r} />)}
          </div>
        </section>
      )}
    </div>
  );
}
