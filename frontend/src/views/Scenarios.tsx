import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Play, Save, Trash2, FolderOpen, Layers } from 'lucide-react';
import { api } from '../lib/api';
import type { ScenarioConfig, ScenarioResult } from '@decisionguru/shared';
import { useApp } from '../store';
import { ExportAction } from '../components/ExportAction';
import { fmtCHF, fmtCHFSigned, fmtDurationMonths, fmtPct, plClass } from '../lib/format';
import { DeltaChart } from '../components/DeltaChart';
import { Segmented, Spinner, KindBadge } from '../components/ui';

export function Scenarios() {
  const qc = useQueryClient();
  const { benchmark } = useApp();
  const instruments = useQuery({ queryKey: ['instruments'], queryFn: api.listInstruments });
  const scenarios = useQuery({ queryKey: ['scenarios'], queryFn: api.listScenarios });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });

  const [config, setConfig] = useState<ScenarioConfig>({
    includedInstrumentIds: [],
    benchmarkSymbol: benchmark,
    sellAllToEtf: false,
    preTax: false,
  });
  const [name, setName] = useState('');
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);

  const run = useMutation({
    mutationFn: () => api.runScenario(config),
    onSuccess: setResult,
  });
  const save = useMutation({
    mutationFn: () =>
      activeId
        ? api.updateScenario(activeId, name || 'Untitled', config)
        : api.createScenario(name || 'Untitled', config),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scenarios'] }),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.deleteScenario(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scenarios'] });
      if (activeId) setActiveId(null);
    },
  });

  const allIds = (instruments.data ?? []).map((i) => i.id);
  const toggle = (id: number) =>
    setConfig((c) => ({
      ...c,
      includedInstrumentIds: c.includedInstrumentIds.includes(id)
        ? c.includedInstrumentIds.filter((x) => x !== id)
        : [...c.includedInstrumentIds, id],
    }));

  const load = (id: number) => {
    const s = scenarios.data?.find((x) => x.id === id);
    if (!s) return;
    setConfig(s.config);
    setName(s.name);
    setActiveId(id);
    api.runScenario(s.config).then(setResult);
  };

  const included = config.sellAllToEtf ? allIds : config.includedInstrumentIds;

  return (
    <div id="view-scenarios" className="p-6 max-w-[1400px] mx-auto">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
        <div className="eyebrow mb-1">Workbench</div>
        <h1 className="font-display text-2xl font-semibold">Scenario comparisons</h1>
        <p className="text-sm text-text-muted mt-1">
          Compose baskets and test the "sell everything → ETF" thesis. Deltas are after Swiss tax.
        </p>
        </div>
        <ExportAction target={() => document.getElementById('view-scenarios')} title="Scenario comparisons" filename="scenarios" className="btn-secondary shrink-0" label="PDF / Word" />
      </header>

      <div className="grid lg:grid-cols-[360px_1fr] gap-6">
        {/* Builder */}
        <div className="space-y-4">
          <section className="card">
            <h3 className="font-display text-base font-semibold mb-3">Build</h3>
            <label className="label">Scenario name</label>
            <input className="input mb-4" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Brother's thesis" />

            <label className="label">Benchmark</label>
            <select
              className="input mb-4"
              value={config.benchmarkSymbol}
              onChange={(e) => setConfig((c) => ({ ...c, benchmarkSymbol: e.target.value }))}
            >
              {(settings?.benchmarks ?? []).map((b) => (
                <option key={b.symbol} value={b.symbol}>
                  {b.symbol} — {b.name}
                </option>
              ))}
            </select>

            <div className="flex items-center justify-between mb-4">
              <label className="label !mb-0 flex items-center gap-2">
                <Layers size={14} /> Sell everything → ETF
              </label>
              <input
                type="checkbox"
                className="accent-azure w-4 h-4"
                checked={config.sellAllToEtf}
                onChange={(e) => setConfig((c) => ({ ...c, sellAllToEtf: e.target.checked }))}
              />
            </div>

            <div className="flex items-center justify-between mb-4">
              <span className="label !mb-0">Basis</span>
              <Segmented
                value={config.preTax ? 'pre' : 'after'}
                onChange={(v) => setConfig((c) => ({ ...c, preTax: v === 'pre' }))}
                options={[
                  { value: 'after', label: 'After-tax' },
                  { value: 'pre', label: 'Pre-tax' },
                ]}
              />
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="label">From date</label>
                <input
                  type="date"
                  className="input"
                  value={config.fromDate ?? ''}
                  onChange={(e) => setConfig((c) => ({ ...c, fromDate: e.target.value || null }))}
                />
                <p className="text-[11px] text-text-faint mt-1">Ignore trades before this.</p>
              </div>
              <div>
                <label className="label">As of</label>
                <input
                  type="date"
                  className="input"
                  value={config.asOf ?? ''}
                  onChange={(e) => setConfig((c) => ({ ...c, asOf: e.target.value || null }))}
                />
                <p className="text-[11px] text-text-faint mt-1">Value on this date (default today).</p>
              </div>
            </div>

            {!config.sellAllToEtf && (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-1">
                  <label className="label !mb-0">Include positions</label>
                  <div className="flex gap-2 text-[11px]">
                    <button className="text-azure hover:text-azure-bright" onClick={() => setConfig((c) => ({ ...c, includedInstrumentIds: allIds }))}>
                      All
                    </button>
                    <button className="text-text-faint hover:text-text" onClick={() => setConfig((c) => ({ ...c, includedInstrumentIds: [] }))}>
                      None
                    </button>
                  </div>
                </div>
                <div className="max-h-52 overflow-y-auto border border-hairline rounded divide-y divide-hairline">
                  {(instruments.data ?? []).map((i) => (
                    <label key={i.id} className="flex items-start gap-2 px-3 py-2 hover:bg-surface-2 cursor-pointer text-sm">
                      <input
                        type="checkbox"
                        className="accent-azure mt-0.5"
                        checked={config.includedInstrumentIds.includes(i.id)}
                        onChange={() => toggle(i.id)}
                      />
                      <KindBadge kind={i.kind} />
                      <span className="font-mono shrink-0">{i.symbol}</span>
                      <span className="text-text-muted break-words min-w-0">{i.name}</span>
                    </label>
                  ))}
                  {!instruments.data?.length && <div className="px-3 py-3 text-sm text-text-faint">No positions.</div>}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button className="btn-primary flex-1" onClick={() => run.mutate()} disabled={run.isPending || included.length === 0}>
                <Play size={15} /> Run
              </button>
              <button className="btn-secondary" onClick={() => save.mutate()} disabled={!name.trim()}>
                <Save size={15} /> Save
              </button>
            </div>
          </section>

          <section className="card">
            <h3 className="font-display text-base font-semibold mb-3">Saved</h3>
            <div className="space-y-1.5">
              {(scenarios.data ?? []).map((s) => (
                <div key={s.id} className="group flex items-center justify-between gap-2 px-3 py-2 rounded hover:bg-surface-2 text-sm">
                  <button className="flex items-center gap-2 text-left flex-1" onClick={() => load(s.id)}>
                    <FolderOpen size={14} className="text-azure" />
                    {s.name}
                  </button>
                  <button className="text-text-faint hover:text-loss opacity-0 group-hover:opacity-100" onClick={() => del.mutate(s.id)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              {!scenarios.data?.length && <p className="text-sm text-text-faint">No saved scenarios yet.</p>}
            </div>
          </section>
        </div>

        {/* Results */}
        <div>
          {run.isPending ? (
            <Spinner label="Running scenario…" />
          ) : result ? (
            <ScenarioResultView result={result} includedCount={included.length} />
          ) : (
            <ScenarioEmpty count={included.length} />
          )}
        </div>
      </div>
    </div>
  );
}

function ScenarioEmpty({ count }: { count: number }) {
  return (
    <section className="card h-full flex flex-col items-center justify-center text-center py-16 px-6 border-dashed">
      <div className="mb-5 flex items-center gap-4">
        <span className="flex items-center gap-2 text-sm text-azure">
          <span className="w-8 h-0.5 bg-azure" /> your basket
        </span>
        <span className="flex items-center gap-2 text-sm text-gold">
          <span className="w-8 h-0.5 border-t-2 border-dashed border-gold" /> the ETF
        </span>
      </div>
      <h3 className="font-display text-lg text-text mb-1">The road not taken</h3>
      <p className="text-sm text-text-muted max-w-sm mb-4">
        Run a scenario to see, after Swiss tax, how your basket compares against the ETF you
        didn't buy. The shaded gap between the two lines is the opportunity cost.
      </p>
      <div className="text-xs text-text-faint">
        {count > 0 ? `${count} position${count > 1 ? 's' : ''} selected — press Run.` : 'Select positions or toggle "sell everything → ETF".'}
      </div>
    </section>
  );
}

function ScenarioResultView({ result, includedCount }: { result: ScenarioResult; includedCount: number }) {
  const agg = result.aggregate;
  const ahead = agg.deltaCHF >= 0;
  const winners = result.perPosition.filter((p) => p.counterfactual.deltaCHF > 0).length;
  const losers = result.perPosition.filter((p) => p.counterfactual.deltaCHF < 0).length;
  return (
    <div className="space-y-6">
      <section className={`card border-l-2 ${ahead ? 'border-l-gain' : 'border-l-loss'}`}>
        <div className="eyebrow mb-2">
          Basket vs {result.scenario.benchmarkSymbol} · {result.scenario.preTax ? 'pre-tax' : 'after-tax'} · CHF
        </div>
        <div className={`font-mono font-semibold text-display-l tnum ${plClass(agg.deltaCHF)}`}>
          {fmtCHFSigned(agg.deltaCHF)}
        </div>
        <p className={`text-sm mt-1 ${ahead ? 'text-gain' : 'text-loss'}`}>
          {ahead
            ? `Your basket beat the ETF by ${fmtPct(Math.abs(agg.deltaPct))}.`
            : `The ETF would have won by ${fmtPct(Math.abs(agg.deltaPct))}.`}
        </p>
        {/* Summary band — included count + the two valuations side by side */}
        <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-hairline">
          <div>
            <div className="eyebrow mb-1">Positions</div>
            <div className="font-mono tnum text-lg">{includedCount}</div>
            <div className="text-[11px] text-text-faint mt-0.5">
              <span className="text-gain">{winners}▲</span> · <span className="text-loss">{losers}▼</span> vs ETF
            </div>
          </div>
          <div>
            <div className="eyebrow mb-1">Actual value</div>
            <div className="font-mono tnum text-lg text-azure">{fmtCHF(agg.actualValueCHF)}</div>
          </div>
          <div>
            <div className="eyebrow mb-1">ETF counterfactual</div>
            <div className="font-mono tnum text-lg text-gold">{fmtCHF(agg.counterfactualValueCHF)}</div>
          </div>
        </div>
        <div className="mt-4">
          <DeltaChart series={agg.series} benchmarkName={result.scenario.benchmarkSymbol} height={260} />
        </div>
      </section>

      <section className="card !p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="th">Symbol</th>
                <th className="th text-right">Actual CHF</th>
                <th className="th text-right">ETF CHF</th>
                <th className="th text-right">Delta CHF</th>
                <th className="th text-right">Recovery</th>
              </tr>
            </thead>
            <tbody>
              {result.perPosition.map((pp) => {
                const c = pp.counterfactual;
                return (
                  <tr key={pp.instrumentId} className="hover:bg-surface-2">
                    <td className="td font-mono">{pp.symbol}</td>
                    <td className="td text-right font-mono tnum">{fmtCHF(c.actualValueCHF)}</td>
                    <td className="td text-right font-mono tnum text-gold">{fmtCHF(c.counterfactualValueCHF)}</td>
                    <td className={`td text-right font-mono tnum font-medium ${plClass(c.deltaCHF)}`}>{fmtCHFSigned(c.deltaCHF)}</td>
                    <td className="td text-right font-mono tnum text-text-muted">
                      {c.recoveryMonths ? fmtDurationMonths(c.recoveryMonths) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
