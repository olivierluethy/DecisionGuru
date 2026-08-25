import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Modal } from '../components/Modal';
import { DeltaChart } from '../components/DeltaChart';
import { Segmented, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { useApp } from '../store';
import { fmtCHF, fmtCHFSigned, fmtPct, plClass } from '../lib/format';

/**
 * Compare an arbitrary basket of instruments against one or more benchmark ETFs.
 * Answers "how would just these holdings have done vs the ETF(s) I didn't buy?"
 */
export function CompareModal({ instrumentIds }: { instrumentIds: number[] }) {
  const { closeModal, benchmark } = useApp();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const { data: instruments } = useQuery({ queryKey: ['instruments'], queryFn: api.listInstruments });

  const [selected, setSelected] = useState<string[]>([benchmark]);
  const [preTax, setPreTax] = useState(false);

  const benchmarks = settings?.benchmarks ?? [];
  const toggleBench = (sym: string) =>
    setSelected((s) => (s.includes(sym) ? s.filter((x) => x !== sym) : [...s, sym]));

  const compare = useQuery({
    queryKey: ['compare', instrumentIds, selected, preTax],
    queryFn: () => api.compare(instrumentIds, selected, preTax),
    enabled: selected.length > 0 && instrumentIds.length > 0,
  });

  const basketNames = useMemo(() => {
    const byId = new Map((instruments ?? []).map((i) => [i.id, i]));
    return instrumentIds.map((id) => byId.get(id)?.symbol ?? String(id));
  }, [instruments, instrumentIds]);

  return (
    <Modal
      title="Compare basket vs ETF"
      subtitle={`${instrumentIds.length} holding${instrumentIds.length === 1 ? '' : 's'}: ${basketNames.join(', ')}`}
      onClose={closeModal}
      size="xl"
      footer={
        <button className="btn-secondary" onClick={closeModal}>
          Close
        </button>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="label">Benchmark ETFs</div>
            <div className="flex flex-wrap gap-2">
              {benchmarks.map((b) => {
                const on = selected.includes(b.symbol);
                return (
                  <button
                    key={b.symbol}
                    onClick={() => toggleBench(b.symbol)}
                    className={`chip cursor-pointer ${on ? '!border-azure/60 !text-azure' : ''}`}
                    title={b.name}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-azure' : 'bg-hairline-strong'}`} />
                    {b.symbol}
                  </button>
                );
              })}
            </div>
          </div>
          <Segmented
            value={preTax ? 'pre' : 'after'}
            onChange={(v) => setPreTax(v === 'pre')}
            options={[
              { value: 'after', label: 'After-tax' },
              { value: 'pre', label: 'Pre-tax' },
            ]}
          />
        </div>

        {compare.isLoading ? (
          <Spinner label="Comparing basket…" />
        ) : !compare.data ? (
          <p className="text-sm text-text-faint">Pick at least one benchmark.</p>
        ) : (
          <div className="space-y-5">
            {compare.data.comparisons.map((cmp) => {
              const ahead = cmp.aggregate.deltaCHF >= 0;
              return (
                <section key={cmp.benchmark} className={`card border-l-2 ${ahead ? 'border-l-gain' : 'border-l-loss'}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
                    <div className="eyebrow">
                      Basket vs {cmp.benchmark} · {preTax ? 'pre-tax' : 'after-tax'} · CHF
                    </div>
                    <div className="text-[11px] text-text-muted">{cmp.benchmarkName}</div>
                  </div>
                  <div className="grid lg:grid-cols-[minmax(220px,1fr)_2fr] gap-5">
                    <div className="flex flex-col justify-center">
                      <div className={`font-mono font-semibold text-display-l tnum leading-none ${plClass(cmp.aggregate.deltaCHF)}`}>
                        {fmtCHFSigned(cmp.aggregate.deltaCHF)}
                      </div>
                      <p className={`text-sm mt-2 ${ahead ? 'text-gain' : 'text-loss'}`}>
                        {ahead
                          ? `Your basket is ahead of ${cmp.benchmark} by ${fmtPct(Math.abs(cmp.aggregate.deltaPct))}.`
                          : `You'd have ${fmtPct(Math.abs(cmp.aggregate.deltaPct))} more in ${cmp.benchmark}.`}
                      </p>
                      <div className="grid grid-cols-2 gap-4 mt-4">
                        <div>
                          <div className="eyebrow mb-1">Basket value</div>
                          <div className="font-mono tnum">{fmtCHF(cmp.aggregate.actualValueCHF)}</div>
                        </div>
                        <div>
                          <div className="eyebrow mb-1">ETF value</div>
                          <div className="font-mono tnum text-gold">{fmtCHF(cmp.aggregate.counterfactualValueCHF)}</div>
                        </div>
                      </div>
                    </div>
                    <DeltaChart series={cmp.aggregate.series} benchmarkName={cmp.benchmark} height={220} />
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
