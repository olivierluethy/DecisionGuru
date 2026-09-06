import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Play, Save, Trash2, FolderOpen, Layers, Wallet, FlaskConical } from 'lucide-react';
import { api, type ProspectiveProjection, type UniversalCompareResponse, type CompareEntity } from '../lib/api';
import type { ScenarioConfig, ScenarioResult } from '@decisionguru/shared';
import { useApp } from '../store';
import { ExportAction } from '../components/ExportAction';
import { fmtCHF, fmtCHFSigned, fmtDurationMonths, fmtNum, fmtPct, fmtPctSigned, plClass } from '../lib/format';
import { DeltaChart } from '../components/DeltaChart';
import { ProjectionChart } from '../components/ProjectionChart';
import { SymbolPicker } from '../components/SymbolPicker';
import { ComparisonSelect } from '../components/ComparisonSelect';
import { Segmented, Spinner, KindBadge, InfoTooltip } from '../components/ui';

type HypoResult = { projection: ProspectiveProjection; compare: UniversalCompareResponse };
const YEAR_OPTS = [{ value: '3', label: '3Y' }, { value: '5', label: '5Y' }, { value: '10', label: '10Y' }];

export function Scenarios() {
  const qc = useQueryClient();
  const { benchmark } = useApp();
  const instruments = useQuery({ queryKey: ['instruments'], queryFn: api.listInstruments });
  const scenarios = useQuery({ queryKey: ['scenarios'], queryFn: api.listScenarios });

  const [config, setConfig] = useState<ScenarioConfig>({
    mode: 'portfolio',
    includedInstrumentIds: [],
    benchmarkSymbol: benchmark,
    sellAllToEtf: false,
    preTax: false,
    symbol: '',
    amountCHF: 10_000,
    projectionYears: 5,
    compareSymbols: [],
  });
  const [name, setName] = useState('');
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const [hypo, setHypo] = useState<HypoResult | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [modeAuto, setModeAuto] = useState(true);

  const mode = config.mode ?? 'portfolio';
  // No holdings → default to the hypothetical study so Scenarios is usable without a portfolio.
  useEffect(() => {
    if (modeAuto && instruments.data && instruments.data.length === 0) {
      setConfig((c) => ({ ...c, mode: 'hypothetical' }));
    }
  }, [instruments.data, modeAuto]);
  const setMode = (m: 'portfolio' | 'hypothetical') => { setModeAuto(false); setConfig((c) => ({ ...c, mode: m })); };
  const patch = (p: Partial<ScenarioConfig>) => setConfig((c) => ({ ...c, ...p }));

  const run = useMutation({ mutationFn: () => api.runScenario(config), onSuccess: setResult });
  const runHypo = useMutation({ mutationFn: (cfg: ScenarioConfig) => computeHypo(cfg), onSuccess: setHypo });
  const save = useMutation({
    mutationFn: () =>
      activeId ? api.updateScenario(activeId, name || 'Untitled', config) : api.createScenario(name || 'Untitled', config),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scenarios'] }),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.deleteScenario(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['scenarios'] }); if (activeId) setActiveId(null); },
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
    setModeAuto(false);
    if ((s.config.mode ?? 'portfolio') === 'hypothetical') runHypo.mutate(s.config);
    else api.runScenario(s.config).then(setResult);
  };

  const included = config.sellAllToEtf ? allIds : config.includedInstrumentIds;
  const canRun = mode === 'hypothetical' ? !!config.symbol?.trim() : included.length > 0;
  const running = mode === 'hypothetical' ? runHypo.isPending : run.isPending;

  return (
    <div id="view-scenarios" className="p-6 max-w-[1400px] mx-auto">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="eyebrow mb-1">Workbench</div>
          <h1 className="font-display text-2xl font-semibold">Scenario comparisons</h1>
          <p className="text-sm text-text-muted mt-1">
            Test your portfolio against the ETF you didn't buy — or, without owning anything,
            put a hypothetical amount into any stock or ETF and see how it could play out.
          </p>
        </div>
        <ExportAction target={() => document.getElementById('view-scenarios')} title="Scenario comparisons" filename="scenarios" className="btn-secondary shrink-0" label="PDF / Word" />
      </header>

      <div className="grid lg:grid-cols-[360px_1fr] gap-6">
        {/* Builder */}
        <div className="space-y-4">
          <section className="card">
            <h3 className="font-display text-base font-semibold mb-3">Build</h3>

            {/* Mode — portfolio counterfactual vs a holdings-free hypothetical study. */}
            <div className="inline-flex w-full rounded border border-hairline bg-surface-2 p-0.5 mb-4">
              {([['portfolio', 'Portfolio', Wallet], ['hypothetical', 'Hypothetical', FlaskConical]] as const).map(([m, label, Icon]) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 h-8 rounded-sm text-[13px] transition-colors ${
                    mode === m ? 'bg-surface text-text font-medium' : 'text-text-muted hover:text-text'
                  }`}
                >
                  <Icon size={14} /> {label}
                </button>
              ))}
            </div>

            <label className="label">Scenario name</label>
            <input className="input mb-4" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nvidia vs the world" />

            <label className="label">Benchmark</label>
            <div className="mb-4">
              <SymbolPicker value={config.benchmarkSymbol} onChange={(s) => patch({ benchmarkSymbol: s })} />
            </div>

            {mode === 'portfolio' ? (
              <>
                <div className="flex items-center justify-between mb-4">
                  <label className="label !mb-0 flex items-center gap-2"><Layers size={14} /> Sell everything → ETF</label>
                  <input type="checkbox" className="accent-azure w-4 h-4" checked={config.sellAllToEtf}
                    onChange={(e) => patch({ sellAllToEtf: e.target.checked })} />
                </div>

                <div className="flex items-center justify-between mb-4">
                  <span className="label !mb-0">Basis</span>
                  <Segmented value={config.preTax ? 'pre' : 'after'} onChange={(v) => patch({ preTax: v === 'pre' })}
                    options={[{ value: 'after', label: 'After-tax' }, { value: 'pre', label: 'Pre-tax' }]} />
                </div>

                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div>
                    <label className="label">From date</label>
                    <input type="date" className="input" value={config.fromDate ?? ''}
                      onChange={(e) => patch({ fromDate: e.target.value || null })} />
                    <p className="text-[11px] text-text-faint mt-1">Ignore trades before this.</p>
                  </div>
                  <div>
                    <label className="label">As of</label>
                    <input type="date" className="input" value={config.asOf ?? ''}
                      onChange={(e) => patch({ asOf: e.target.value || null })} />
                    <p className="text-[11px] text-text-faint mt-1">Value on this date (default today).</p>
                  </div>
                </div>

                {!config.sellAllToEtf && (
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-1">
                      <label className="label !mb-0">Include positions</label>
                      <div className="flex gap-2 text-[11px]">
                        <button className="text-azure hover:text-azure-bright" onClick={() => patch({ includedInstrumentIds: allIds })}>All</button>
                        <button className="text-text-faint hover:text-text" onClick={() => patch({ includedInstrumentIds: [] })}>None</button>
                      </div>
                    </div>
                    <div className="max-h-52 overflow-y-auto border border-hairline rounded divide-y divide-hairline">
                      {(instruments.data ?? []).map((i) => (
                        <label key={i.id} className="flex items-start gap-2 px-3 py-2 hover:bg-surface-2 cursor-pointer text-sm">
                          <input type="checkbox" className="accent-azure mt-0.5" checked={config.includedInstrumentIds.includes(i.id)} onChange={() => toggle(i.id)} />
                          <KindBadge kind={i.kind} />
                          <span className="font-mono shrink-0">{i.symbol}</span>
                          <span className="text-text-muted break-words min-w-0">{i.name}</span>
                        </label>
                      ))}
                      {!instruments.data?.length && (
                        <div className="px-3 py-3 text-sm text-text-faint">
                          No positions — switch to <button className="text-azure" onClick={() => setMode('hypothetical')}>Hypothetical</button> to test any asset.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <label className="label">Invest in</label>
                <div className="mb-1">
                  <SymbolPicker value={config.symbol ?? ''} onChange={(s) => patch({ symbol: s })} placeholder="Pick a stock or ETF…" />
                </div>
                <p className="text-[11px] text-text-faint mb-4">Any stock or ETF — you don't need to own it.</p>

                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div>
                    <label className="label">Amount (CHF)</label>
                    <input type="number" min={0} step={1000} className="input tnum" value={config.amountCHF ?? 10_000}
                      onChange={(e) => patch({ amountCHF: Math.max(0, Number(e.target.value)) })} />
                  </div>
                  <div>
                    <label className="label">Horizon</label>
                    <Segmented value={String(config.projectionYears ?? 5)} onChange={(v) => patch({ projectionYears: Number(v) })} options={YEAR_OPTS} />
                  </div>
                </div>

                <div className="mb-4">
                  <label className="label flex items-center gap-1.5">
                    Also compare with
                    <InfoTooltip text="Optional extra stocks or ETFs to line up in the historical track-record table alongside your pick and the benchmark." />
                  </label>
                  <ComparisonSelect subject={config.symbol ?? ''} selected={config.compareSymbols ?? []} onChange={(next) => patch({ compareSymbols: next })} />
                </div>
              </>
            )}

            <div className="flex gap-2">
              <button className="btn-primary flex-1" disabled={running || !canRun}
                onClick={() => (mode === 'hypothetical' ? runHypo.mutate(config) : run.mutate())}>
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
                    {(s.config.mode ?? 'portfolio') === 'hypothetical'
                      ? <FlaskConical size={14} className="text-gold shrink-0" />
                      : <FolderOpen size={14} className="text-azure shrink-0" />}
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
          {running ? (
            <Spinner label={mode === 'hypothetical' ? 'Projecting…' : 'Running scenario…'} />
          ) : mode === 'hypothetical' ? (
            hypo ? <HypotheticalResultView data={hypo} /> : <HypotheticalEmpty ready={!!config.symbol?.trim()} />
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

async function computeHypo(cfg: ScenarioConfig): Promise<HypoResult> {
  const symbol = (cfg.symbol || '').trim().toUpperCase();
  const years = cfg.projectionYears ?? 5;
  const amount = cfg.amountCHF ?? 10_000;
  const entities: CompareEntity[] = [
    { type: 'symbol', symbol, name: symbol, kind: 'stock' },
    { type: 'symbol', symbol: cfg.benchmarkSymbol, kind: 'etf' },
    ...(cfg.compareSymbols ?? [])
      .filter((s) => s !== symbol && s !== cfg.benchmarkSymbol)
      .map((s) => ({ type: 'symbol' as const, symbol: s })),
  ];
  const [projection, compare] = await Promise.all([
    api.researchProjection(symbol, { benchmark: cfg.benchmarkSymbol, amount, years }),
    api.universalCompare(entities, years),
  ]);
  return { projection, compare };
}

function ScenarioEmpty({ count }: { count: number }) {
  return (
    <section className="card h-full flex flex-col items-center justify-center text-center py-16 px-6 border-dashed">
      <div className="mb-5 flex items-center gap-4">
        <span className="flex items-center gap-2 text-sm text-azure"><span className="w-8 h-0.5 bg-azure" /> your basket</span>
        <span className="flex items-center gap-2 text-sm text-gold"><span className="w-8 h-0.5 border-t-2 border-dashed border-gold" /> the ETF</span>
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

function HypotheticalEmpty({ ready }: { ready: boolean }) {
  return (
    <section className="card h-full flex flex-col items-center justify-center text-center py-16 px-6 border-dashed">
      <FlaskConical size={22} className="text-gold mb-4" />
      <h3 className="font-display text-lg text-text mb-1">Test any idea — no holdings needed</h3>
      <p className="text-sm text-text-muted max-w-sm mb-4">
        Pick any stock or ETF, choose an amount and a horizon, and see the forward projection
        of holding it versus your benchmark — plus how the two have actually performed.
      </p>
      <div className="text-xs text-text-faint">{ready ? 'Press Run.' : 'Pick an asset in "Invest in" to begin.'}</div>
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
        <div className={`font-mono font-semibold text-display-l tnum ${plClass(agg.deltaCHF)}`}>{fmtCHFSigned(agg.deltaCHF)}</div>
        <p className={`text-sm mt-1 ${ahead ? 'text-gain' : 'text-loss'}`}>
          {ahead ? `Your basket beat the ETF by ${fmtPct(Math.abs(agg.deltaPct))}.` : `The ETF would have won by ${fmtPct(Math.abs(agg.deltaPct))}.`}
        </p>
        <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-hairline">
          <div>
            <div className="eyebrow mb-1">Positions</div>
            <div className="font-mono tnum text-lg">{includedCount}</div>
            <div className="text-[11px] text-text-faint mt-0.5"><span className="text-gain">{winners}▲</span> · <span className="text-loss">{losers}▼</span> vs ETF</div>
          </div>
          <div><div className="eyebrow mb-1">Actual value</div><div className="font-mono tnum text-lg text-azure">{fmtCHF(agg.actualValueCHF)}</div></div>
          <div><div className="eyebrow mb-1">ETF counterfactual</div><div className="font-mono tnum text-lg text-gold">{fmtCHF(agg.counterfactualValueCHF)}</div></div>
        </div>
        <div className="mt-4"><DeltaChart series={agg.series} benchmarkName={result.scenario.benchmarkSymbol} height={260} /></div>
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
                    <td className="td text-right font-mono tnum text-text-muted">{c.recoveryMonths ? fmtDurationMonths(c.recoveryMonths) : '—'}</td>
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

const BASIS_LABEL: Record<string, string> = { history: 'historical CAGR', override: 'your estimate', assumption: 'assumed' };

function HypotheticalResultView({ data }: { data: HypoResult }) {
  const p = data.projection;
  const ahead = p.advantageCHF >= 0;
  return (
    <div className="space-y-6">
      <section className={`card border-l-2 ${ahead ? 'border-l-gain' : 'border-l-loss'}`}>
        <div className="eyebrow mb-2">Invest {fmtCHF(p.amountCHF)} in {p.symbol} vs {p.benchmark} · {p.years}y · CHF</div>
        <div className={`font-mono font-semibold text-display-l tnum ${plClass(p.advantageCHF)}`}>{fmtCHFSigned(p.advantageCHF)}</div>
        <p className={`text-sm mt-1 ${ahead ? 'text-gain' : 'text-loss'}`}>
          {ahead
            ? `Holding ${p.symbol} projects ahead of ${p.benchmark} by ${fmtCHF(Math.abs(p.advantageCHF))}.`
            : `The ${p.benchmark} ETF projects ahead by ${fmtCHF(Math.abs(p.advantageCHF))}.`}
        </p>
        <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-hairline">
          <div><div className="eyebrow mb-1">{p.symbol} in {p.years}y</div><div className="font-mono tnum text-lg text-azure">{fmtCHF(p.endHoldCHF)}</div></div>
          <div><div className="eyebrow mb-1">{p.benchmark} in {p.years}y</div><div className="font-mono tnum text-lg text-gold">{fmtCHF(p.endEtfCHF)}</div></div>
          <div><div className="eyebrow mb-1">Break-even</div><div className="font-mono tnum text-lg">{p.crossoverMonth != null ? fmtDurationMonths(p.crossoverMonth) : '—'}</div></div>
        </div>
        <div className="flex items-center gap-4 text-[11px] text-text-faint mt-4 mb-1">
          <span className="flex items-center gap-1"><span className="w-4 h-0 border-t-2 border-dashed border-azure inline-block" /> hold {p.symbol}</span>
          <span className="flex items-center gap-1"><span className="w-4 h-0 border-t-2 border-dashed border-gold inline-block" /> {p.benchmark}</span>
        </div>
        <ProjectionChart points={p.points} crossoverMonth={p.crossoverMonth} height={260} />
        <p className="text-[11px] text-text-faint mt-3 leading-relaxed">
          Expected growth — {p.symbol}: {fmtPct(p.assumedStockCagr)} ({BASIS_LABEL[p.stockCagrBasis]}) · {p.benchmark}: {fmtPct(p.assumedEtfCagr)} ({BASIS_LABEL[p.etfCagrBasis]}).
          Model estimate, pre-tax, dividends not modelled — not advice.
        </p>
      </section>

      <section className="card !p-0 overflow-hidden">
        <div className="px-4 pt-4"><div className="eyebrow">Historical track record · {data.compare.windowYears}y</div></div>
        <div className="overflow-x-auto mt-2">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="th w-8">#</th>
                <th className="th">Asset</th>
                <th className="th text-right">Return</th>
                <th className="th text-right">Total</th>
                <th className="th text-right">Vol</th>
                <th className="th text-right">Max DD</th>
                <th className="th text-right">Sharpe</th>
              </tr>
            </thead>
            <tbody>
              {data.compare.entities.map((m) => (
                <tr key={m.symbol} className="hover:bg-surface-2">
                  <td className="td font-mono text-text-faint">{m.rank}</td>
                  <td className="td"><span className="font-mono text-azure">{m.symbol}</span><span className="text-text-muted ml-2 text-[13px]">{m.name}</span></td>
                  <td className={`td text-right font-mono tnum ${plClass(m.cagr)}`}>{fmtPctSigned(m.cagr)}</td>
                  <td className={`td text-right font-mono tnum ${plClass(m.totalReturnPct)}`}>{fmtPctSigned(m.totalReturnPct)}</td>
                  <td className="td text-right font-mono tnum text-text-muted">{fmtPct(m.annualizedVol)}</td>
                  <td className="td text-right font-mono tnum text-loss">{fmtPct(m.maxDrawdownPct)}</td>
                  <td className="td text-right font-mono tnum">{m.sharpe != null ? fmtNum(m.sharpe) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
