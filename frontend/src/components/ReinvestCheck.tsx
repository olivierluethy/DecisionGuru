import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, PieChart, Trophy, Wallet } from 'lucide-react';
import { api, type ReinvestCheck as ReinvestCheckData, type ReinvestBuyZoneWindow } from '../lib/api';
import { Spinner, EmptyState, MiniBar } from './ui';
import { fmtCHF, fmtCHFSigned, fmtPct, fmtMoney, fmtDate } from '../lib/format';
import { useApp } from '../store';

/**
 * Reinvestment check — should the next franc go into the stock you already own?
 *
 * A Hold verdict says the stock is worth owning; the reader's instinct then is to buy more
 * of it. This answers the different question that actually applies to new money, in the
 * three ways it can independently come out "no": a competitor is better positioned right
 * now, topping up concentrates the book, or the same money would have done better elsewhere.
 * Below that, the timing read: what buying during a past buy-zone window would have been
 * worth against your own cost basis.
 */

const VERDICT: Record<string, { label: string; tone: string; border: string; blurb: string }> = {
  'best-in-market': {
    label: 'Best positioned in its market', tone: 'text-gain', border: 'border-l-gain',
    blurb: 'On value and growth strength combined, no competitor in this market currently ranks ahead of it.',
  },
  'peers-better-positioned': {
    label: 'Competitors are better positioned', tone: 'text-warn', border: 'border-l-warn',
    blurb: 'One or more companies in the same market are both cheaper and growing faster. Topping up here buys the weaker position of the two.',
  },
  'mid-field': {
    label: 'Mid-field in its market', tone: 'text-text-muted', border: 'border-l-hairline',
    blurb: 'No competitor beats it on both axes at once, but it does not lead either — the case for more money here rests on the value read, not on market position.',
  },
  unranked: {
    label: 'Market position unavailable', tone: 'text-text-muted', border: 'border-l-hairline',
    blurb: 'Too few comparable companies with cached data to rank this one inside its market.',
  },
};

export function ReinvestCheck({ instrumentId }: { instrumentId: number }) {
  // null = "whatever the server suggests" (your idle cash); a number = the reader overrode it.
  const [amount, setAmount] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const openModal = useApp((s) => s.openModal);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['reinvest', instrumentId, amount],
    queryFn: () => api.reinvest(instrumentId, amount),
    staleTime: 30 * 60_000,
    retry: 1,
    placeholderData: keepPreviousData,
  });

  if (isLoading) return <Spinner label="Weighing this against the market…" />;
  if (isError || !data) return <EmptyState title="Reinvestment check unavailable" hint="Try again shortly." />;
  if (!data.available) {
    return <EmptyState title="Nothing to top up" hint={data.reason ?? 'This position is closed.'} />;
  }

  const v = VERDICT[data.verdict ?? 'unranked'] ?? VERDICT.unranked;
  const stronger = data.strongerAlternatives ?? [];
  const conc = data.concentration;
  const wbw = data.wouldBeWorth;
  const missed = data.missedEntry;
  const shown = data.amountCHF ?? 0;

  const applyDraft = () => {
    const n = Number(draft.replace(/['\s]/g, ''));
    setAmount(Number.isFinite(n) && n > 0 ? n : null);
  };

  return (
    <div className="space-y-5">
      {/* How much money the whole section is about. */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor={`reinvest-amount-${instrumentId}`}>Amount to invest (CHF)</label>
          <input
            id={`reinvest-amount-${instrumentId}`}
            className="input !w-44"
            inputMode="decimal"
            placeholder={String(Math.round(shown))}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={applyDraft}
            onKeyDown={(e) => { if (e.key === 'Enter') applyDraft(); }}
          />
        </div>
        <p className="text-[12px] text-text-faint pb-2.5">
          Using <span className="text-text font-mono tnum">{fmtCHF(shown)}</span>
          {data.amountSource === 'idle-cash'
            ? <> — your idle cash. </>
            : data.amountSource === 'default'
              ? <> — no idle cash on the ledger, so a round figure to think in. </>
              : <> . </>}
          Every figure below scales with it.
        </p>
      </div>

      {/* The headline: is this the best home for that money in this market? */}
      <div className={`card !p-4 border-l-2 ${v.border}`}>
        <div className={`font-semibold flex items-center gap-2 ${v.tone}`}>
          {data.verdict === 'peers-better-positioned' ? <AlertTriangle size={16} />
            : data.verdict === 'best-in-market' ? <CheckCircle2 size={16} /> : <Trophy size={16} />}
          {v.label}
        </div>
        <p className="text-sm text-text-muted mt-1 max-w-[70ch]">
          {v.blurb}
          {data.marketPosition?.rank != null && (
            <> <span className="font-mono text-text">{data.symbol}</span> ranks{' '}
              <span className="font-mono tnum text-text">#{data.marketPosition.rank}</span> of{' '}
              <span className="font-mono tnum">{data.marketPosition.of}</span> over {data.horizon}.</>
          )}
        </p>
        {stronger.length > 0 && (
          <div className="mt-3">
            <div className="eyebrow mb-2">Cheaper and stronger than {data.symbol}</div>
            <div className="flex flex-wrap gap-2">
              {stronger.map((a) => (
                <button
                  key={a.symbol}
                  type="button"
                  onClick={() => openModal({ kind: 'opportunity', symbol: a.symbol, name: a.name, currency: a.currency })}
                  className="chip cursor-pointer hover:border-hairline-strong"
                  title={`Open ${a.symbol}`}
                >
                  <span className="font-mono text-text">{a.symbol}</span>
                  {a.name && <span className="text-text-faint truncate max-w-[140px]">{a.name}</span>}
                  <span className="text-text-muted tnum">V {a.valuePct?.toFixed(0)} · S {a.strengthPct?.toFixed(0)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* What topping up does to single-name risk. */}
      {conc && (
        <div className="card !p-4">
          <div className="eyebrow mb-3 flex items-center gap-1.5"><PieChart size={12} /> What this does to concentration</div>
          <div className="space-y-3 max-w-[520px]">
            <WeightRow label="Today" weight={conc.currentWeight} threshold={conc.threshold} />
            <WeightRow label={`Top up ${data.symbol}`} weight={conc.weightAfterTopUp} threshold={conc.threshold} emphasise />
            <WeightRow label="Buy a peer instead" weight={conc.weightAfterPeerBuy} threshold={conc.threshold} />
          </div>
          <p className="text-[12px] text-text-muted mt-3 max-w-[70ch]">
            {conc.crossesThreshold ? (
              <><span className="text-warn">Adding here pushes this holding past {fmtPct(conc.threshold, 0)} of your book</span> —
                the app's concentration threshold. The same money in a competitor keeps your exposure to this
                market and lowers single-name risk.</>
            ) : conc.aboveThreshold ? (
              <>This holding is already above the {fmtPct(conc.threshold, 0)} concentration threshold; topping up
                deepens that.</>
            ) : (
              <>Both routes stay under the {fmtPct(conc.threshold, 0)} concentration threshold, so this dimension does
                not argue against either.</>
            )}
          </p>
        </div>
      )}

      {/* Same money, this stock or a competitor — what the record says. */}
      {wbw && wbw.peers.length > 0 && (
        <div>
          <div className="eyebrow mb-2 flex items-center gap-1.5">
            <Wallet size={12} /> What {fmtCHF(shown)} would be worth today, invested back then
          </div>
          <div className="border border-hairline rounded overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="th">Company</th>
                    <th className="th text-right">Value</th>
                    <th className="th text-right">Strength</th>
                    {wbw.years.map((y) => <th key={y} className="th text-right">{y}Y ago</th>)}
                  </tr>
                </thead>
                <tbody>
                  <tr className="bg-surface-2">
                    <td className="td">
                      <span className="font-mono text-text">{data.symbol}</span>
                      <span className="text-[10px] uppercase text-azure ml-2">yours</span>
                    </td>
                    <td className="td text-right font-mono tnum">{data.marketPosition?.valuePct?.toFixed(0) ?? '—'}</td>
                    <td className="td text-right font-mono tnum">{data.marketPosition?.strengthPct?.toFixed(0) ?? '—'}</td>
                    {wbw.years.map((y) => (
                      <td key={y} className="td text-right font-mono tnum">{money(wbw.subject[`${y}Y`])}</td>
                    ))}
                  </tr>
                  {wbw.peers.map((p) => (
                    <tr key={p.symbol}>
                      <td className="td">
                        <button
                          type="button"
                          onClick={() => openModal({ kind: 'opportunity', symbol: p.symbol, name: p.name, currency: p.currency })}
                          className="group inline-flex items-center gap-2 text-left cursor-pointer"
                          title={`Open ${p.symbol}`}
                        >
                          <span className="font-mono text-text group-hover:text-azure underline-offset-2 group-hover:underline">{p.symbol}</span>
                          {p.name && <span className="text-text-faint truncate group-hover:text-text-muted">{p.name}</span>}
                        </button>
                      </td>
                      <td className="td text-right font-mono tnum">{p.valuePct?.toFixed(0) ?? '—'}</td>
                      <td className="td text-right font-mono tnum">{p.strengthPct?.toFixed(0) ?? '—'}</td>
                      {wbw.years.map((y) => {
                        const val = p.wouldBeWorth[`${y}Y`];
                        const mine = wbw.subject[`${y}Y`];
                        const ahead = val != null && mine != null && val > mine;
                        return (
                          <td key={y} className={`td text-right font-mono tnum ${ahead ? 'text-gain' : ''}`}>{money(val)}</td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-[11px] text-text-faint mt-1">
            Price return only — no dividends, Swiss tax, fees or FX moves; each company measured the same way.
            Green means that company would have turned the same money into more than yours did. Backward-looking.
          </p>
        </div>
      )}

      {missed?.available && <MissedEntry missed={missed} symbol={data.symbol ?? ''} amount={shown} />}
    </div>
  );
}

/** "What if I had bought when it was worth buying?" — against the reader's own entry. */
function MissedEntry({ missed, symbol, amount }: {
  missed: NonNullable<ReinvestCheckData['missedEntry']>; symbol: string; amount: number;
}) {
  const ccy = missed.currency ?? '';
  const yours = missed.yourEntry;
  const best = missed.bestWindow;

  return (
    <div className="space-y-3">
      <div className="eyebrow flex items-center gap-1.5"><Clock size={12} /> What the right entry would have been worth</div>

      {!missed.entryTargetAvailable ? (
        <p className="text-sm text-text-faint">
          No fair-value estimate for {symbol}, so past buy zones cannot be reconstructed. The cheapest day is
          still shown below.
        </p>
      ) : missed.windows.length === 0 ? (
        <p className="text-sm text-text-muted">
          Over the last {missed.lookbackYears} years {symbol} never closed below its{' '}
          <span className="font-mono">{fmtMoney(missed.entryTarget, ccy)}</span> entry target — there was no buy-zone
          window to miss.
        </p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-3">
        <EntryCard
          label="Your entry"
          price={yours.price} ccy={ccy} date={yours.date}
          value={yours.valueTodayCHF} extra={null} amount={amount}
        />
        {best && (
          <EntryCard
            label="Best buy-zone window"
            price={best.lowClose} ccy={ccy} date={best.lowDate}
            value={best.valueTodayCHF} extra={best.extraVsYoursCHF} amount={amount}
            sub={`${fmtDate(best.start)} – ${fmtDate(best.end)} · ${best.days} days below target`}
          />
        )}
        {missed.bestDay && (
          <EntryCard
            label="Cheapest day (ceiling)"
            price={missed.bestDay.price} ccy={ccy} date={missed.bestDay.date}
            value={missed.bestDay.valueTodayCHF} extra={missed.bestDay.extraVsYoursCHF} amount={amount}
            sub="Nobody could have done better than this."
          />
        )}
      </div>

      {missed.windows.length > 0 && (
        <div className="border border-hairline rounded overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="th">Buy-zone window</th>
                  <th className="th text-right">Days</th>
                  <th className="th text-right">Low</th>
                  <th className="th text-right">{fmtCHF(amount)} would be</th>
                  <th className="th text-right">vs. your entry</th>
                </tr>
              </thead>
              <tbody>
                {missed.windows.map((w: ReinvestBuyZoneWindow) => (
                  <tr key={w.start}>
                    <td className="td text-text-muted">{fmtDate(w.start)} – {fmtDate(w.end)}</td>
                    <td className="td text-right font-mono tnum text-text-muted">{w.days}</td>
                    <td className="td text-right font-mono tnum">{fmtMoney(w.lowClose, ccy)}</td>
                    <td className="td text-right font-mono tnum">{money(w.valueTodayCHF)}</td>
                    <td className={`td text-right font-mono tnum ${w.extraVsYoursCHF == null ? 'text-text-faint' : w.extraVsYoursCHF < 0 ? 'text-loss' : 'text-gain'}`}>
                      {w.extraVsYoursCHF == null ? '—' : fmtCHFSigned(w.extraVsYoursCHF)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-[11px] text-text-faint leading-relaxed max-w-[80ch]">
        Your entry is the cost-weighted average of your actual purchases
        {yours.date && <> ({fmtDate(yours.date)})</>}. {missed.note}
      </p>
    </div>
  );
}

function EntryCard({ label, price, ccy, date, value, extra, amount, sub }: {
  label: string; price: number | null; ccy: string; date: string | null;
  value: number | null; extra: number | null; amount: number; sub?: string;
}) {
  return (
    <div className="card !p-4 space-y-1.5">
      <div className="eyebrow">{label}</div>
      <div className="font-mono text-sm text-text tnum">
        {price != null ? fmtMoney(price, ccy) : '—'}
        {date && <span className="text-text-faint ml-2 text-[11px]">{fmtDate(date)}</span>}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xl font-semibold tnum text-text leading-none">{money(value)}</span>
        <span className="text-[11px] text-text-faint">from {fmtCHF(amount)}</span>
      </div>
      {extra != null && (
        <div className={`text-[12px] tnum ${extra < 0 ? 'text-loss' : 'text-gain'}`}>
          {fmtCHFSigned(extra)} vs. your entry
        </div>
      )}
      {sub && <p className="text-[11px] text-text-faint">{sub}</p>}
    </div>
  );
}

function WeightRow({ label, weight, threshold, emphasise }: {
  label: string; weight: number; threshold: number; emphasise?: boolean;
}) {
  const over = weight > threshold;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-[12px] ${emphasise ? 'text-text' : 'text-text-muted'}`}>{label}</span>
        <span className={`font-mono tnum text-sm ${over ? 'text-warn' : 'text-text'}`}>{fmtPct(weight)}</span>
      </div>
      {/* Scaled so the concentration threshold sits at two thirds of the track — the bar is
          about "how close to too much", not about filling the whole portfolio. */}
      <MiniBar value={weight} max={threshold * 1.5} barClass={over ? 'bg-warn' : 'bg-azure'} className="mt-1" />
    </div>
  );
}

function money(v: number | null | undefined): string {
  return v == null ? '—' : fmtCHF(v);
}
