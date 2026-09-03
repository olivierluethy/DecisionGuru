import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Blend, Trophy, ShieldCheck, Scale } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, type MarketCombo, type ComboWhy } from '../lib/api';
import { Spinner, EmptyState } from './ui';
import { fmtPct, fmtPctSigned, fmtDate } from '../lib/format';
import { useApp } from '../store';

/**
 * Historical combinations — "was holding this one company the best I could have done in
 * this market, and if not, with whom and at which split?"
 *
 * The answer is a leaderboard, so the framing matters more than usual: a mix picked because
 * it topped the past is curve-fitted by construction. This view therefore leads with the
 * *mechanism* (did a partner simply do better, did rebalancing between uncorrelated names
 * add the return, or was the gain purely a calmer ride?) and repeats plainly what the
 * numbers exclude — dividends, Swiss tax, trading costs, FX.
 */

const YEARS = [1, 3, 5] as const;

const WHY: Record<ComboWhy, string> = {
  'subject-led': 'This company carried the mix on its own.',
  'partner-outperformed': 'The partner was simply the better company over this window — the mix inherits its return.',
  'rebalancing-bonus': 'The mix beat both of its legs held alone. That can only come from rebalancing between names that do not move together, not from picking a winner.',
  'risk-reduction': 'Roughly the same return as holding the stock alone, but a materially shallower worst drawdown.',
  'mix-effect': 'The blend landed between its legs.',
};

export function MarketCombos({ symbol }: { symbol: string }) {
  const [years, setYears] = useState<(typeof YEARS)[number]>(5);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['market-combos', symbol, years],
    queryFn: () => api.marketCombos(symbol, years),
    staleTime: 60 * 60_000,
    retry: 1,
    placeholderData: keepPreviousData,
  });

  const chips = (
    <div className="flex flex-wrap gap-1.5">
      {YEARS.map((y) => (
        <button key={y} onClick={() => setYears(y)}
          className={`chip cursor-pointer ${years === y ? '!border-azure/50 !text-text' : 'opacity-50'}`}>
          {y}Y
        </button>
      ))}
    </div>
  );

  if (isLoading) return <Spinner label="Replaying every mix…" />;
  if (isError || !data) return <EmptyState title="Combination analysis unavailable" hint="Try again shortly." />;

  if (!data.available || !data.solo || !data.best || !data.verdict) {
    return (
      <div className="space-y-4">
        {chips}
        <EmptyState
          title="Not enough cached history yet"
          hint={`${data.reason ?? 'No overlapping price history for this window.'} Open this stock and a few competitors in Research so their price history is warmed, then come back.`}
        />
      </div>
    );
  }

  const { solo, best, verdict } = data;
  const led = verdict.key === 'combination-led';
  const safer = data.safestMatch;
  const withSubject = data.bestWithSubject;
  const bestIsSolePeer = best.legs.length === 1 && best.legs[0].symbol !== data.symbol;
  // Only worth a second card when it isn't the same portfolio as the mix-with-this-stock.
  const showBestSeparately = !withSubject || legLabel(best) !== legLabel(withSubject);

  return (
    <div className="space-y-5">
      {chips}

      {/* The question the section exists to answer, answered in one sentence. */}
      <div className={`card !p-4 border-l-2 ${led ? 'border-l-warn' : 'border-l-gain'}`}>
        <div className={`font-semibold ${led ? 'text-warn' : 'text-gain'}`}>
          {led
            ? 'A different allocation would have beaten holding this alone'
            : 'Holding this one company held up on return'}
        </div>
        <p className="text-sm text-text-muted mt-1 max-w-[70ch]">
          Over {data.spanYears ?? years} years, holding <span className="text-text font-mono">{data.symbol}</span> alone
          ranked <span className="text-text font-mono tnum">#{verdict.soloRank}</span> of{' '}
          <span className="font-mono tnum">{verdict.of.toLocaleString()}</span> allocations tested.{' '}
          {led ? (
            bestIsSolePeer ? (
              <>The best of them was not a mix at all — <span className="text-text">{best.legs[0].symbol}</span> held
                alone, <span className="text-gain">{fmtPctSigned(verdict.cagrGap)}</span> a year ahead.</>
            ) : (
              <>The best, <span className="text-text">{legLabel(best)}</span>, returned{' '}
                <span className="text-gain">{fmtPctSigned(verdict.cagrGap)}</span> a year more.</>
            )
          ) : (
            <>No allocation beat it by more than a point a year — concentration was not punished on return.</>
          )}
          {withSubject && (
            <> Keeping <span className="font-mono text-text">{data.symbol}</span> in the portfolio, the best split
              was <span className="text-text">{legLabel(withSubject)}</span>{' '}
              (<span className={withSubject.cagr < 0 ? 'text-loss' : 'text-gain'}>{fmtPctSigned(withSubject.cagr)}</span> a year).</>
          )}
          {safer && (
            <> A mix reached a similar return with a{' '}
              <span className="text-gain">{fmtPct(Math.abs(safer.maxDrawdown - solo.maxDrawdown))}</span> shallower
              worst drawdown — the concentration cost you the ride more than the destination.</>
          )}
        </p>
      </div>

      {/* The answers worth naming. The mix that still holds this stock comes first: it is the
          one that can actually be acted on from where the reader stands today. */}
      <div className="grid gap-3 md:grid-cols-2">
        {withSubject && (
          <ComboCard icon={Blend} title={`Best mix holding ${data.symbol}`} combo={withSubject} solo={solo} />
        )}
        {showBestSeparately && <ComboCard icon={Trophy} title="Best of all allocations" combo={best} solo={solo} />}
        {data.bestRiskAdjusted && (
          <ComboCard icon={Scale} title="Best return per unit of risk" combo={data.bestRiskAdjusted} solo={solo} />
        )}
        {safer && <ComboCard icon={ShieldCheck} title="Same return, calmer ride" combo={safer} solo={solo} />}
      </div>

      {/* Baselines: this stock alone, and the sector index. */}
      <div className="card !p-4">
        <div className="eyebrow mb-2">Measured against</div>
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-[13px]">
          <Baseline label={`${data.symbol} alone`} cagr={solo.cagr} dd={solo.maxDrawdown} />
          {data.sectorEtf && (
            <Baseline label={`Sector index · ${data.sectorEtf.symbol}`}
              cagr={data.sectorEtf.cagr} dd={data.sectorEtf.maxDrawdown} />
          )}
        </div>
      </div>

      {/* The leaderboard itself. */}
      {data.top && data.top.length > 0 && (
        <div>
          <div className="eyebrow mb-2">Top allocations by annualised return</div>
          <div className="border border-hairline rounded overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="th">Mix</th>
                    <th className="th text-right">CAGR</th>
                    <th className="th text-right">Volatility</th>
                    <th className="th text-right">Worst drawdown</th>
                    <th className="th text-right">Return / risk</th>
                    <th className="th text-right">Correlation</th>
                  </tr>
                </thead>
                <tbody>
                  {data.top.map((c) => (
                    <tr key={c.legs.map((l) => `${l.symbol}:${l.weight}`).join('|')}
                      className={c.legs.length === 1 && c.legs[0].symbol === data.symbol ? 'bg-surface-2' : ''}>
                      <td className="td"><Legs combo={c} /></td>
                      <td className={`td text-right font-mono tnum ${c.cagr < 0 ? 'text-loss' : 'text-gain'}`}>{fmtPctSigned(c.cagr)}</td>
                      <td className="td text-right font-mono tnum text-text-muted">{fmtPct(c.volatility)}</td>
                      <td className="td text-right font-mono tnum text-loss">{fmtPct(c.maxDrawdown)}</td>
                      <td className="td text-right font-mono tnum">{c.returnPerRisk != null ? c.returnPerRisk.toFixed(2) : '—'}</td>
                      <td className="td text-right font-mono tnum text-text-muted">{c.correlation != null ? c.correlation.toFixed(2) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Each name on its own, so the leaderboard can be read against its ingredients. */}
      {data.universe.length > 0 && (
        <div>
          <div className="eyebrow mb-2">Each company alone over this window</div>
          <div className="flex flex-wrap gap-2">
            {data.universe.map((u) => (
              <span key={u.symbol} className="chip">
                <span className="font-mono text-text">{u.symbol}</span>
                <span className={u.soloCagr < 0 ? 'text-loss tnum' : 'text-gain tnum'}>{fmtPctSigned(u.soloCagr)}</span>
                <span className="text-text-faint tnum">dd {fmtPct(u.soloMaxDrawdown)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <p className="text-[11px] text-text-faint leading-relaxed">
        {data.startDate && data.endDate && <>Window {fmtDate(data.startDate)} – {fmtDate(data.endDate)} ({data.tradingDays} trading days). </>}
        {data.combinationsTested?.toLocaleString()} mixes of up to three companies on a{' '}
        {data.gridStepPct != null ? `${Math.round(data.gridStepPct * 100)}%` : '10%'} weight grid,
        rebalanced {data.rebalancing ?? 'annually'}. <strong className="text-text-muted">Price return only</strong> —
        no dividends, no Swiss tax, no trading costs, no FX; every mix is measured the same way, so they
        compare fairly against each other but none is a real after-tax outcome.{' '}
        <strong className="text-text-muted">This is the record, not a forecast</strong> — the mix that topped the
        past was selected <em>because</em> it topped the past.
        {data.excluded.length > 0 && (
          <> Excluded for want of cached history: {data.excluded.map((e) => e.symbol).join(', ')}.</>
        )}
      </p>
    </div>
  );
}

function ComboCard({ icon: Icon, title, combo, solo }: {
  icon: LucideIcon; title: string; combo: MarketCombo; solo: MarketCombo;
}) {
  const gap = combo.cagr - solo.cagr;
  return (
    <div className="card !p-4 space-y-2.5">
      <div className="eyebrow flex items-center gap-1.5"><Icon size={12} /> {title}</div>
      <Legs combo={combo} />
      <div className="flex items-baseline gap-2">
        <span className={`font-mono text-xl font-semibold tnum leading-none ${combo.cagr < 0 ? 'text-loss' : 'text-gain'}`}>
          {fmtPctSigned(combo.cagr)}
        </span>
        <span className="text-[11px] text-text-faint">a year</span>
        {Math.abs(gap) > 0.0005 && (
          <span className={`text-[11px] tnum ${gap < 0 ? 'text-loss' : 'text-gain'}`}>
            {fmtPctSigned(gap)} vs. alone
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-muted">
        <span>Worst drawdown <span className="text-loss tnum">{fmtPct(combo.maxDrawdown)}</span></span>
        <span>Volatility <span className="tnum">{fmtPct(combo.volatility)}</span></span>
        {combo.correlation != null && <span>Correlation <span className="tnum">{combo.correlation.toFixed(2)}</span></span>}
      </div>
      <p className="text-[12px] text-text-muted">{WHY[combo.why]}</p>
    </div>
  );
}

/** The mix as clickable tickers with their split — the "Investmentrelation" itself. */
function Legs({ combo }: { combo: MarketCombo }) {
  const openModal = useApp((s) => s.openModal);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {combo.legs.map((l, i) => (
        <span key={l.symbol} className="inline-flex items-center gap-1.5">
          {i > 0 && <span className="text-text-faint text-[11px]">+</span>}
          <button
            type="button"
            onClick={() => openModal({ kind: 'opportunity', symbol: l.symbol, name: l.name })}
            title={l.name ? `Open ${l.symbol} — ${l.name}` : `Open ${l.symbol}`}
            className="font-mono text-[13px] text-text hover:text-azure underline-offset-2 hover:underline cursor-pointer"
          >
            {l.symbol}
          </button>
          <span className="font-mono tnum text-[12px] text-text-muted">{Math.round(l.weight * 100)}%</span>
        </span>
      ))}
    </div>
  );
}

function legLabel(c: MarketCombo): string {
  return c.legs.map((l) => `${l.symbol} ${Math.round(l.weight * 100)}%`).join(' + ');
}

function Baseline({ label, cagr, dd }: { label: string; cagr: number; dd: number }) {
  return (
    <span>
      <span className="eyebrow mr-2">{label}</span>
      <span className={`font-mono tnum ${cagr < 0 ? 'text-loss' : 'text-gain'}`}>{fmtPctSigned(cagr)}</span>
      <span className="text-text-faint"> a year · worst drawdown </span>
      <span className="font-mono tnum text-loss">{fmtPct(dd)}</span>
    </span>
  );
}
