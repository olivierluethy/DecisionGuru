import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RangeKey } from '@decisionguru/shared';
import { Modal } from '../components/Modal';
import { DeltaChart } from '../components/DeltaChart';
import { TimeRangeSelector } from '../components/TimeRangeSelector';
import { Segmented, Spinner, KindBadge } from '../components/ui';
import { SymbolSearch, type SymbolPick } from '../components/SymbolSearch';
import { api } from '../lib/api';
import { useApp } from '../store';
import { sliceByRange } from '../lib/range';
import { fmtCHF, fmtCHFSigned, fmtPct, fmtPctSigned, plClass } from '../lib/format';

type MetricKey = 'price' | 'actual' | 'etf' | 'delta' | 'deltaPct' | 'xirr' | 'etfXirr' | 'yield';
const METRICS: { key: MetricKey; label: string }[] = [
  { key: 'price', label: 'Price/share' },
  { key: 'actual', label: 'Actual value' },
  { key: 'etf', label: 'Alt. value' },
  { key: 'delta', label: 'Δ CHF' },
  { key: 'deltaPct', label: 'Δ %' },
  { key: 'xirr', label: 'XIRR' },
  { key: 'etfXirr', label: 'Alt. XIRR' },
  { key: 'yield', label: 'Div. yield' },
];

/**
 * Flexible N-vs-N comparison: pick any mix of stocks & ETFs and one or more
 * benchmark ETFs. Sticky table headers, a shared time-range selector, and
 * toggleable metric columns keep dense comparisons legible.
 */
export function CompareModal({ instrumentIds }: { instrumentIds: number[] }) {
  const { closeModal, benchmark } = useApp();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const { data: instruments } = useQuery({ queryKey: ['instruments'], queryFn: api.listInstruments });

  // Editable basket — seeded from the passed selection, or all holdings when empty.
  const [basket, setBasket] = useState<number[]>(instrumentIds);
  useEffect(() => {
    if (instrumentIds.length === 0 && instruments && basket.length === 0) {
      setBasket(instruments.map((i) => i.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instruments]);

  const [selected, setSelected] = useState<string[]>([benchmark]);
  // Searched-in comparison targets (symbol → its display name/kind), so any stock/ETF/index
  // — not just the settings benchmark ETFs — can be compared against. `selected` remains the
  // single source of truth for which symbols /analysis/compare receives.
  const [picks, setPicks] = useState<Record<string, SymbolPick>>({});
  const addPick = (p: SymbolPick) =>
    setSelected((s) => {
      setPicks((m) => ({ ...m, [p.symbol]: p }));
      return s.includes(p.symbol) ? s : [...s, p.symbol];
    });
  const [preTax, setPreTax] = useState(false);
  const [range, setRange] = useState<RangeKey>('1Y');
  const [visible, setVisible] = useState<Set<MetricKey>>(new Set(METRICS.map((m) => m.key)));

  const benchmarks = settings?.benchmarks ?? [];
  const benchSymbols = new Set(benchmarks.map((b) => b.symbol));
  const extraSelected = selected.filter((s) => !benchSymbols.has(s));
  const toggleBench = (sym: string) =>
    setSelected((s) => (s.includes(sym) ? s.filter((x) => x !== sym) : [...s, sym]));
  const toggleInstrument = (id: number) =>
    setBasket((b) => (b.includes(id) ? b.filter((x) => x !== id) : [...b, id]));
  const toggleMetric = (k: MetricKey) =>
    setVisible((v) => {
      const n = new Set(v);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  const compare = useQuery({
    queryKey: ['compare', basket, selected, preTax],
    queryFn: () => api.compare(basket, selected, preTax),
    enabled: selected.length > 0 && basket.length > 0,
  });

  const nameById = useMemo(() => new Map((instruments ?? []).map((i) => [i.id, i])), [instruments]);
  const posById = useMemo(
    () => new Map((compare.data?.positions ?? []).map((p) => [p.instrument.id, p])),
    [compare.data],
  );

  return (
    <Modal
      title="Compare holdings vs securities"
      subtitle={`${basket.length} holding${basket.length === 1 ? '' : 's'} vs ${selected.length} comparison${selected.length === 1 ? '' : 's'}`}
      onClose={closeModal}
      size="xl"
      footer={
        <button className="btn-secondary" onClick={closeModal}>
          Close
        </button>
      }
    >
      <div className="space-y-5">
        {/* Basket multi-select */}
        <div>
          <div className="label">Holdings in comparison ({basket.length})</div>
          <div className="flex flex-wrap gap-2 max-h-24 overflow-y-auto">
            {(instruments ?? []).map((i) => {
              const on = basket.includes(i.id);
              return (
                <button
                  key={i.id}
                  onClick={() => toggleInstrument(i.id)}
                  className={`chip cursor-pointer ${on ? '!border-azure/60 !text-azure' : 'opacity-60'}`}
                  title={i.name}
                >
                  <KindBadge kind={i.kind} />
                  {i.symbol}
                </button>
              );
            })}
          </div>
        </div>

        {/* Benchmark multi-select + tax basis */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="label">Compare against (stocks, ETFs, indices)</div>
            <div className="flex flex-wrap gap-2">
              {benchmarks.map((b) => {
                const on = selected.includes(b.symbol);
                return (
                  <button
                    key={b.symbol}
                    onClick={() => toggleBench(b.symbol)}
                    className={`chip cursor-pointer ${on ? '!border-gold/60 !text-gold' : ''}`}
                    title={b.name}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-gold' : 'bg-hairline-strong'}`} />
                    {b.symbol}
                  </button>
                );
              })}
              {extraSelected.map((sym) => {
                const p = picks[sym];
                return (
                  <button
                    key={sym}
                    onClick={() => toggleBench(sym)}
                    className="chip cursor-pointer !border-gold/60 !text-gold"
                    title={p ? `${p.name} — click to remove` : 'click to remove'}
                  >
                    {p && <KindBadge kind={p.kind} />}
                    {sym}
                    <span className="ml-1 text-text-faint">×</span>
                  </button>
                );
              })}
            </div>
            <div className="mt-2 max-w-sm">
              <SymbolSearch onPick={addPick} />
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

        {/* Metric toggles + range */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5">
            {METRICS.map((m) => (
              <button
                key={m.key}
                onClick={() => toggleMetric(m.key)}
                className={`chip cursor-pointer ${visible.has(m.key) ? '!border-azure/50 !text-text' : 'opacity-50'}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <TimeRangeSelector value={range} onChange={setRange} />
        </div>

        {compare.isLoading ? (
          <Spinner label="Comparing…" />
        ) : basket.length === 0 || selected.length === 0 ? (
          <p className="text-sm text-text-faint">Pick at least one holding and one benchmark.</p>
        ) : !compare.data ? (
          <p className="text-sm text-text-faint">No comparison data.</p>
        ) : (
          <div className="space-y-6">
            {compare.data.comparisons.map((cmp) => {
              const ahead = cmp.aggregate.deltaCHF >= 0;
              const slicedSeries = sliceByRange(cmp.aggregate.series, range);
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
                          <div className="eyebrow mb-1">Alt. value</div>
                          <div className="font-mono tnum text-gold">{fmtCHF(cmp.aggregate.counterfactualValueCHF)}</div>
                        </div>
                      </div>
                    </div>
                    <DeltaChart series={slicedSeries} benchmarkName={cmp.benchmark} height={220} />
                  </div>

                  {/* Per-position metrics — sticky header, toggleable columns */}
                  <div className="mt-5 border border-hairline rounded overflow-hidden">
                    <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 z-10">
                          <tr>
                            <th className="th">Holding</th>
                            {visible.has('price') && <th className="th text-right">Price/share</th>}
                            {visible.has('actual') && <th className="th text-right">Actual value</th>}
                            {visible.has('etf') && <th className="th text-right">Alt. value</th>}
                            {visible.has('delta') && <th className="th text-right">Δ CHF</th>}
                            {visible.has('deltaPct') && <th className="th text-right">Δ %</th>}
                            {visible.has('xirr') && <th className="th text-right">XIRR</th>}
                            {visible.has('etfXirr') && <th className="th text-right">Alt. XIRR</th>}
                            {visible.has('yield') && <th className="th text-right">Div. yield</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {cmp.perPosition.map((pp) => {
                            const cf = pp.counterfactual;
                            const inst = nameById.get(pp.instrumentId);
                            const pos = posById.get(pp.instrumentId);
                            return (
                              <tr key={pp.instrumentId}>
                                <td className="td">
                                  <div className="flex items-center gap-2">
                                    {inst && <KindBadge kind={inst.kind} />}
                                    <span className="font-mono text-text">{pp.symbol}</span>
                                  </div>
                                </td>
                                {visible.has('price') && (
                                  <td className="td text-right font-mono tnum">
                                    {fmtCHF(
                                      pos && pos.openQuantity > 0 && pos.currentValueCHF != null
                                        ? pos.currentValueCHF / pos.openQuantity
                                        : pos?.currentPrice,
                                      true,
                                    )}
                                  </td>
                                )}
                                {visible.has('actual') && (
                                  <td className="td text-right font-mono tnum">{fmtCHF(cf.actualValueCHF)}</td>
                                )}
                                {visible.has('etf') && (
                                  <td className="td text-right font-mono tnum text-gold">{fmtCHF(cf.counterfactualValueCHF)}</td>
                                )}
                                {visible.has('delta') && (
                                  <td className={`td text-right font-mono tnum ${plClass(cf.deltaCHF)}`}>{fmtCHFSigned(cf.deltaCHF)}</td>
                                )}
                                {visible.has('deltaPct') && (
                                  <td className={`td text-right font-mono tnum ${plClass(cf.deltaCHF)}`}>{fmtPctSigned(cf.deltaPct)}</td>
                                )}
                                {visible.has('xirr') && (
                                  <td className={`td text-right font-mono tnum ${plClass(cf.actualXirr)}`}>{fmtPctSigned(cf.actualXirr)}</td>
                                )}
                                {visible.has('etfXirr') && (
                                  <td className="td text-right font-mono tnum text-gold">{fmtPctSigned(cf.benchmarkXirr)}</td>
                                )}
                                {visible.has('yield') && (
                                  <td className="td text-right font-mono tnum text-text-muted">{fmtPct(pos?.metrics.currentYield, 2)}</td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
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
