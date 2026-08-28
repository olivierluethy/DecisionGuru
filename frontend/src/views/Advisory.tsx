import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Check, ArrowRight, Eye } from 'lucide-react';
import type { AdvisoryInsight, RangeKey } from '@decisionguru/shared';
import { api } from '../lib/api';
import { useApp } from '../store';
import { DeltaChart } from '../components/DeltaChart';
import { TimeRangeSelector } from '../components/TimeRangeSelector';
import { VerdictBadge, VerdictRationale } from '../components/Verdict';
import { Spinner, EmptyState } from '../components/ui';
import { sliceByRange } from '../lib/range';
import { fmtCHF, fmtCHFSigned, fmtDate, fmtPctSigned, plClass } from '../lib/format';

export function Advisory() {
  const qc = useQueryClient();
  const { selectInstrument } = useApp();
  const [includeHandled, setIncludeHandled] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['advisory', includeHandled],
    queryFn: () => api.advisory(includeHandled),
  });

  const mark = async (id: number, handled: boolean) => {
    await api.setAdvisoryHandled(id, handled).catch(() => undefined);
    qc.invalidateQueries({ queryKey: ['advisory'] });
  };

  if (isLoading) return <Spinner label="Analysing your holdings…" />;

  const insights = data?.insights ?? [];

  return (
    <div className="p-6 max-w-[1100px] mx-auto">
      <header className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <div className="eyebrow mb-1 flex items-center gap-1.5">
            <Sparkles size={12} /> Advisory · harmonize
          </div>
          <h1 className="font-display text-2xl font-semibold">Rebalancing insights</h1>
          <p className="text-sm text-text-muted mt-1 max-w-2xl">
            Holdings that materially lagged a reference ETF over the same period — shown with the
            same verdict every other view uses. A lagging name that is undervalued and sound reads
            <span className="text-gain"> Buy more</span> or <span className="text-text-muted">Hold</span>,
            not a sell: the gain figure is historical context, not a recommendation. Analytical,{' '}
            <span className="text-text">not financial advice</span>.
          </p>
        </div>
        <button
          className={`btn-secondary ${includeHandled ? '!border-azure/50' : ''}`}
          onClick={() => setIncludeHandled((v) => !v)}
        >
          <Eye size={15} /> {includeHandled ? 'Hiding none' : 'Show handled'}
        </button>
      </header>

      {insights.length === 0 ? (
        <EmptyState
          title="No underperformers flagged"
          hint="None of your holdings lag a reference ETF by a meaningful margin over their holding period — or you need more history. Import more data or check back as prices update."
        />
      ) : (
        <div className="space-y-5">
          {insights.map((ins) => (
            <InsightCard key={ins.instrumentId} ins={ins} onOpen={() => selectInstrument(ins.instrumentId)} onMark={mark} />
          ))}
        </div>
      )}
    </div>
  );
}

function InsightCard({
  ins,
  onOpen,
  onMark,
}: {
  ins: AdvisoryInsight;
  onOpen: () => void;
  onMark: (id: number, handled: boolean) => void;
}) {
  const [range, setRange] = useState<RangeKey>('MAX');
  const sliced = sliceByRange(ins.series, range);

  return (
    <section className={`card border-l-2 ${ins.handled ? 'border-l-hairline-strong opacity-70' : 'border-l-gold'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <button className="font-mono text-text hover:text-azure" onClick={onOpen}>
              {ins.symbol}
            </button>
            <span className="text-sm text-text-muted truncate max-w-[280px]">{ins.name}</span>
            {ins.verdict && <VerdictBadge verdict={ins.verdict.verdict} confidence={ins.verdict.confidence} />}
            {ins.handled && (
              <span className="chip !py-0 !px-2 text-gain border-gain/40">
                <Check size={11} /> handled
              </span>
            )}
          </div>
          <div className="text-xs text-text-faint mt-0.5 font-mono">{ins.isin}</div>
        </div>
        <div className="text-right">
          <div className="eyebrow mb-1">Benchmark opportunity cost</div>
          <div className="font-mono font-semibold text-display-l tnum leading-none text-gain">
            {fmtCHFSigned(ins.reallocationGainCHF)}
          </div>
        </div>
      </div>

      <p className="text-sm text-text-muted mb-4">{ins.rationale}</p>

      {/* Recommended single best alternative */}
      <div className="flex flex-wrap items-center gap-3 mb-4 bg-surface-2 border border-hairline rounded p-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono text-text">{ins.symbol}</span>
          <ArrowRight size={15} className="text-text-faint" />
          <span className="font-mono text-gold">{ins.referenceEtf}</span>
        </div>
        <span className="text-xs text-text-muted">{ins.referenceEtfName} — best alternative over your holding period</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-4">
        <Metric label="Purchased" value={fmtDate(ins.sinceDate)} />
        <Metric label="Invested" value={fmtCHF(ins.investedCHF)} />
        <Metric label="Your return" value={fmtPctSigned(ins.holdingReturnPct)} cls={plClass(ins.holdingReturnPct)} />
        <Metric label={`${ins.referenceEtf} return`} value={fmtPctSigned(ins.referenceReturnPct)} cls="text-gold" />
        <Metric label="Holding value now" value={fmtCHF(ins.holdingValueCHF)} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-3 text-[11px] text-text-muted">
          <span className="flex items-center gap-1.5">
            <span className="w-4 h-0.5 bg-azure inline-block" /> {ins.symbol}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-4 h-0 border-t-2 border-dashed border-gold inline-block" /> {ins.referenceEtf}
          </span>
        </div>
        <TimeRangeSelector value={range} onChange={setRange} />
      </div>
      <DeltaChart series={sliced} benchmarkName={ins.referenceEtf} height={220} entryDate={ins.sinceDate} />

      <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-hairline">
        <button className="btn-ghost" onClick={onOpen}>
          Open position
        </button>
        {ins.handled ? (
          <button className="btn-secondary" onClick={() => onMark(ins.instrumentId, false)}>
            Reopen
          </button>
        ) : (
          <button className="btn-primary" onClick={() => onMark(ins.instrumentId, true)}>
            <Check size={15} /> Mark handled
          </button>
        )}
      </div>
    </section>
  );
}

function Metric({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div>
      <div className="eyebrow mb-1">{label}</div>
      <div className={`font-mono tnum text-sm ${cls ?? ''}`}>{value}</div>
    </div>
  );
}
