import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  CalendarClock, TrendingDown, TrendingUp, ArrowRight, Repeat, Swords,
  Newspaper, Wallet, ExternalLink, Flame, CircleAlert,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  api, type ForecastResponse, type ForecastEvent, type ForecastAction,
  type ForecastEventKind, type Conviction,
} from '../lib/api';
import { Spinner, EmptyState } from '../components/ui';
import { fmtCHF, fmtDate } from '../lib/format';
import { useApp } from '../store';

/** How each kind of forecast event reads on the timeline — dot colour, rail icon, label. */
const KIND_META: Record<ForecastEventKind, { label: string; dot: string; icon: LucideIcon; tone: string }> = {
  sell: { label: 'Sell / trim', dot: 'bg-loss', icon: TrendingDown, tone: 'text-loss' },
  reinvest: { label: 'Reinvest', dot: 'bg-gold', icon: Repeat, tone: 'text-gold' },
  buy: { label: 'Buy', dot: 'bg-gain', icon: TrendingUp, tone: 'text-gain' },
  watch: { label: 'Watch', dot: 'bg-azure', icon: Swords, tone: 'text-azure' },
  news: { label: 'Happened', dot: 'bg-text-faint', icon: Newspaper, tone: 'text-text-muted' },
};

const CONV_LABEL: Record<Conviction, string> = { high: 'High', medium: 'Medium', low: 'Low' };

function relativeDay(offsetDays: number): string {
  if (offsetDays <= 0) return 'Today';
  if (offsetDays === 1) return 'Tomorrow';
  return `In ${offsetDays} days`;
}

export function Forecasts() {
  const { data, isLoading } = useQuery({ queryKey: ['forecast'], queryFn: () => api.forecast(30) });

  if (isLoading) return <div className="p-6"><Spinner label="Reading the road ahead…" /></div>;
  if (!data) return null;

  const hasAnything = data.timeline.length > 0 || data.today.count > 0;
  if (!hasAnything && data.summary.portfolioValueCHF <= 0) {
    return (
      <div className="p-6 max-w-[1100px] mx-auto">
        <Header />
        <EmptyState
          title="Nothing to forecast yet"
          hint="Import your transactions and account statement — the forecast reads your holdings, their valuation, the competition and the news to predict what's worth acting on, and when."
        />
      </div>
    );
  }

  return (
    <div id="view-forecasts" className="p-6 max-w-[1100px] mx-auto">
      <Header />
      <MotivationLever data={data} />
      <TodayActions actions={data.today.actions} />
      <Timeline events={data.timeline} horizonDays={data.horizonDays} />
      <p className="text-[11px] text-text-faint mt-8">
        Forecasts are model estimates from historical returns, current valuation, competitor
        trajectories and cached headlines — not certainties, and not financial advice. Predicted
        timing is derived from conviction and straight-line competitor crossovers; the provider
        exposes no earnings calendar. Figures are after Swiss tax where a sale is involved.
      </p>
    </div>
  );
}

function Header() {
  return (
    <header className="mb-6">
      <div className="eyebrow mb-1">Prognosen · what's coming</div>
      <h1 className="font-display text-2xl font-semibold flex items-center gap-2">
        <CalendarClock size={22} className="text-azure" /> Forecasts
      </h1>
      <p className="text-sm text-text-muted mt-1 max-w-2xl">
        A forward view of your portfolio: what to act on today, when each holding is likely worth
        acting on, and — the motivation lever — how much each day of doing nothing costs you.
      </p>
    </header>
  );
}

/** The Motivationshebel: the money bleeding away, per day, per week, per month, from inaction. */
function MotivationLever({ data }: { data: ForecastResponse }) {
  const perDay = data.dailyOpportunityCostCHF;
  const bleeding = perDay > 0;

  return (
    <div
      className={clsx(
        'card border-l-2 mb-6',
        bleeding ? 'border-l-loss bg-loss/[0.04]' : 'border-l-gain',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {bleeding
              ? <Flame size={16} className="text-loss shrink-0" />
              : <TrendingUp size={16} className="text-gain shrink-0" />}
            <span className="eyebrow">{bleeding ? 'Cost of doing nothing' : 'On track'}</span>
          </div>
          <div className={clsx('font-mono text-3xl font-semibold tnum mt-1.5', bleeding ? 'text-loss' : 'text-gain')}>
            {bleeding ? `${fmtCHF(perDay, true)} / day` : 'CHF 0 / day'}
          </div>
          <p className="text-sm text-text-muted mt-2 max-w-[56ch]">
            {bleeding ? (
              <>
                Based on the historical return gap, every day your flagged holdings stay put — rather
                than in the benchmark they'd be reinvested into — costs you about this much.{' '}
                <span className="text-text">{fmtCHF(data.atRiskValueCHF)}</span> of capital is behind
                the estimate.
              </>
            ) : (
              <>Nothing in your portfolio is bleeding return against its benchmark right now. The
                timeline below still tracks what's worth watching.</>
            )}
          </p>
        </div>

        {bleeding && (
          <div className="flex gap-6 shrink-0">
            <Projection label="A week" value={perDay * 7} />
            <Projection label="A month" value={perDay * 30} />
          </div>
        )}
      </div>
    </div>
  );
}

function Projection({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-right">
      <div className="eyebrow mb-1">{label} of waiting</div>
      <div className="font-mono text-xl font-semibold tnum text-loss">−{fmtCHF(value)}</div>
    </div>
  );
}

/** "What to do today" — the immediate action list, each wired to the plan builder. */
function TodayActions({ actions }: { actions: ForecastAction[] }) {
  if (actions.length === 0) {
    return (
      <section className="mb-8">
        <div className="eyebrow mb-3">Today</div>
        <div className="card flex items-center gap-3 text-sm text-text-muted">
          <CircleAlert size={16} className="text-text-faint shrink-0" />
          Nothing needs doing today. The timeline below is your early warning.
        </div>
      </section>
    );
  }

  return (
    <section className="mb-8">
      <div className="eyebrow mb-3">Today · {actions.length} to act on</div>
      <div className="flex flex-col gap-3">
        {actions.map((a) => <ActionCard key={a.id} action={a} />)}
      </div>
    </section>
  );
}

function ActionCard({ action: a }: { action: ForecastAction }) {
  const { openModal, selectInstrument } = useApp();
  const isSell = a.kind === 'sell';
  const isDeploy = a.kind === 'deploy-cash';

  const plan = () => {
    if (isSell && a.instrumentId != null && a.target) {
      openModal({
        kind: 'create-plan',
        sellInstrumentIds: [a.instrumentId],
        targets: [{ symbol: a.target.symbol, name: a.target.name ?? undefined, allocationPct: 1 }],
      });
    } else if (isDeploy && a.target) {
      openModal({
        kind: 'create-plan',
        sellInstrumentIds: [],
        targets: [{ symbol: a.target.symbol, name: a.target.name ?? undefined, allocationPct: 1 }],
      });
    }
  };

  return (
    <div className={clsx('card border-l-2', isSell ? 'border-l-loss' : 'border-l-gain')}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={clsx('chip !py-0.5', isSell ? 'text-loss' : 'text-gain')}>
              {isSell ? <TrendingDown size={12} /> : <Wallet size={12} />}
              {isSell ? 'Sell' : isDeploy ? 'Deploy cash' : 'Buy'}
            </span>
            <button
              onClick={() => a.instrumentId != null && selectInstrument(a.instrumentId)}
              disabled={a.instrumentId == null}
              className={clsx('font-mono text-sm', a.instrumentId != null ? 'text-azure hover:text-azure-bright' : 'text-text')}
            >
              {a.symbol}
            </button>
            {a.target && a.target.symbol !== a.symbol && (
              <span className="flex items-center gap-1.5 text-[13px] text-text-muted">
                <ArrowRight size={13} className="text-text-faint" />
                <span className="font-mono text-gold">{a.target.symbol}</span>
              </span>
            )}
            <span className="text-[11px] text-text-faint uppercase tracking-wide">{CONV_LABEL[a.conviction]} confidence</span>
          </div>
          <p className="text-[13px] text-text-muted mt-2 max-w-[68ch] leading-relaxed">{a.detail}</p>
        </div>

        <div className="text-right shrink-0">
          {a.opportunityCostPerDayCHF != null && a.opportunityCostPerDayCHF > 0 ? (
            <>
              <div className="eyebrow mb-1">Costs you</div>
              <div className="font-mono text-xl font-semibold tnum text-loss">−{fmtCHF(a.opportunityCostPerDayCHF, true)}/day</div>
              {a.opportunityCostCumulativeCHF != null && a.opportunityCostCumulativeCHF > 0 && (
                <div className="text-[11px] text-text-faint mt-0.5">
                  {fmtCHF(a.opportunityCostCumulativeCHF)} behind so far
                </div>
              )}
            </>
          ) : (
            <>
              <div className="eyebrow mb-1">{isDeploy ? 'Idle' : 'Value'}</div>
              <div className="font-mono text-xl font-semibold tnum text-text">{fmtCHF(a.currentValueCHF)}</div>
            </>
          )}
        </div>
      </div>

      {(isSell || isDeploy) && a.target && (
        <div className="mt-4 pt-3 border-t border-hairline flex items-center justify-end">
          <button className="btn-primary h-8" onClick={plan}>Add to plan</button>
        </div>
      )}
    </div>
  );
}

/** The forecast timeline — a vertical, dated rail of predicted (and just-occurred) events. */
function Timeline({ events, horizonDays }: { events: ForecastEvent[]; horizonDays: number }) {
  if (events.length === 0) return null;
  let lastDate = '';

  return (
    <section>
      <div className="eyebrow mb-3">Timeline · next {horizonDays} days</div>
      <div className="relative pl-1">
        <div className="absolute left-[8px] top-2 bottom-2 w-px bg-hairline" aria-hidden />
        <ul className="space-y-1">
          {events.map((e) => {
            const showDate = e.date !== lastDate;
            lastDate = e.date;
            return <EventRow key={e.id} event={e} showDate={showDate} />;
          })}
        </ul>
      </div>
    </section>
  );
}

function EventRow({ event: e, showDate }: { event: ForecastEvent; showDate: boolean }) {
  const m = KIND_META[e.kind];
  const Icon = m.icon;
  const occurred = e.status === 'occurred';

  return (
    <li className="relative pl-7">
      <span
        className={clsx(
          'absolute left-[2px] top-[9px] w-[13px] h-[13px] rounded-full border-2 border-bg',
          m.dot, occurred && 'opacity-70',
        )}
        aria-hidden
      />
      <div className="py-1.5">
        {showDate && (
          <div className="flex items-baseline gap-2 mb-1">
            <span className="font-mono text-[11px] text-text tnum">{fmtDate(e.date)}</span>
            <span className="text-[11px] text-text-faint">{relativeDay(e.offsetDays)}</span>
          </div>
        )}
        <div className="card !p-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Icon size={13} className={clsx('shrink-0', m.tone)} />
                <span className={clsx('text-[11px] uppercase tracking-wide', m.tone)}>{m.label}</span>
                {e.symbol && <span className="font-mono text-sm text-text">{e.symbol}</span>}
                {e.target && e.kind !== 'reinvest' && e.target.symbol !== e.symbol && (
                  <span className="flex items-center gap-1 text-[12px] text-text-muted">
                    <ArrowRight size={12} className="text-text-faint" />
                    <span className="font-mono text-gold">{e.target.symbol}</span>
                  </span>
                )}
                {occurred && (
                  <span className="chip !py-0.5 !px-1.5 text-[10px] text-text-muted">just happened</span>
                )}
              </div>
              <div className="text-sm text-text mt-1">{e.title}</div>
              <p className="text-[12px] text-text-muted mt-1 max-w-[70ch] leading-relaxed">{e.detail}</p>

              {e.news && e.kind !== 'news' && (
                <a
                  href={e.news.link ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="group mt-2 inline-flex items-center gap-1.5 text-[12px] text-text-faint hover:text-azure"
                >
                  <Newspaper size={12} className="shrink-0" />
                  <span className="truncate max-w-[46ch]">{e.news.title}</span>
                  <ExternalLink size={11} className="shrink-0" />
                </a>
              )}
              {e.kind === 'news' && e.news?.link && (
                <a
                  href={e.news.link}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1.5 inline-flex items-center gap-1.5 text-[12px] text-azure hover:text-azure-bright"
                >
                  Read it <ExternalLink size={11} />
                </a>
              )}

              {e.basis.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {e.basis.map((b) => (
                    <span key={b} className="text-[10px] text-text-faint bg-surface-2 rounded px-1.5 py-0.5">{b}</span>
                  ))}
                </div>
              )}
            </div>

            {e.opportunityCostPerDayCHF != null && e.opportunityCostPerDayCHF > 0 && (
              <div className="text-right shrink-0">
                <div className="eyebrow mb-0.5">Per day</div>
                <div className="font-mono text-sm font-semibold tnum text-loss">−{fmtCHF(e.opportunityCostPerDayCHF, true)}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
