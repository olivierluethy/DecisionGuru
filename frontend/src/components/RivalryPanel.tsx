import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Swords, TrendingDown, Trophy } from 'lucide-react';
import { api, type Rival, type RivalryVerdict } from '../lib/api';
import { Spinner, EmptyState } from './ui';
import { fmtCHF, fmtPctSigned, fmtDate, fmtPct } from '../lib/format';
import { useApp } from '../store';

/**
 * Competitor watch — who in this market is closing on the company you hold?
 *
 * The race runs from the reader's own purchase date, so the gap is the number that actually
 * applies to them: had they bought the rival instead, would they now be ahead? A rival still
 * behind but gaining is the one worth showing, because that is while there is still a
 * decision to make.
 *
 * Momentum alone would push a reader straight into the expensive laggard that Market position
 * warns about, so every rival is also weighed on valuation, and the verdict says which of the
 * two stories it is.
 */

const VERDICT: Record<RivalryVerdict, { label: string; tone: string; blurb: string }> = {
  'already-ahead-and-cheaper': {
    label: 'Ahead of you, and cheaper', tone: 'text-loss',
    blurb: 'Since you bought, this company has returned more than yours — and it still trades further below its own fair value.',
  },
  'already-ahead-but-pricier': {
    label: 'Ahead of you, but pricier', tone: 'text-warn',
    blurb: 'It has returned more than your holding since you bought, but is priced higher against its own fair value — the lead is paid for.',
  },
  'closing-and-cheaper': {
    label: 'Closing, and cheaper', tone: 'text-warn',
    blurb: 'Still behind you, but gaining — and it trades further below its own fair value than your holding does. The one to watch.',
  },
  'closing-but-pricier': {
    label: 'Closing, but pricier', tone: 'text-text-muted',
    blurb: 'Gaining on you on price alone: it is valued higher against its own fair value than your holding. Momentum without the valuation behind it.',
  },
  behind: {
    label: 'Behind', tone: 'text-gain',
    blurb: 'Behind your holding and not gaining on it.',
  },
};

const GROUP_LABEL: Record<number, string> = {
  0: 'Ahead and still gaining',
  1: 'Closing on you',
  2: 'Ahead, but falling back',
  3: 'Behind',
};

export function RivalryPanel({ instrumentId }: { instrumentId: number }) {
  const openModal = useApp((s) => s.openModal);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['rivalry', instrumentId],
    queryFn: () => api.rivalry(instrumentId),
    staleTime: 30 * 60_000,
    retry: 1,
  });

  if (isLoading) return <Spinner label="Running the race…" />;
  if (isError || !data) return <EmptyState title="Competitor watch unavailable" hint="Try again shortly." />;
  if (!data.available) {
    return <EmptyState title="No race to run" hint={data.reason ?? 'Not enough history yet.'} />;
  }

  const rivals = data.rivals ?? [];
  const threat = data.nearestThreat;

  return (
    <div className="space-y-5">
      {/* The headline: is anyone actually coming for this position? */}
      {threat ? (
        <div className={`card !p-4 border-l-2 ${threat.aheadOfYou ? 'border-l-loss' : 'border-l-warn'}`}>
          <div className={`font-semibold flex items-center gap-2 ${VERDICT[threat.verdict].tone}`}>
            {threat.aheadOfYou ? <Trophy size={16} /> : <AlertTriangle size={16} />}
            {threat.aheadOfYou
              ? `${threat.symbol} has already overtaken ${data.symbol}`
              : `${threat.symbol} is closing on ${data.symbol}`}
          </div>
          <p className="text-sm text-text-muted mt-1 max-w-[72ch]">
            Since your purchase on <span className="text-text">{fmtDate(data.entryDate ?? null)}</span>,{' '}
            <span className="font-mono text-text">{threat.symbol}</span> has returned{' '}
            <span className={threat.gap >= 0 ? 'text-loss' : 'text-gain'}>{fmtPctSigned(threat.gap)}</span>{' '}
            {threat.gap >= 0 ? 'more' : 'less'} than your holding
            {threat.closingSpeedPerYear != null && threat.closingSpeedPerYear > 0 && (
              <> and is gaining at about <span className="text-text">{fmtPctSigned(threat.closingSpeedPerYear)}</span> a year</>
            )}.
            {threat.daysToCrossover != null && (
              <> On that trend it passes you in about <span className="text-text">{threat.daysToCrossover} days</span>
                {threat.crossoverDate && <> ({fmtDate(threat.crossoverDate)})</>}.</>
            )}
            {' '}{VERDICT[threat.verdict].blurb}
          </p>
          {threat.switch.monthsToRecoverFee != null && (
            <p className="text-[12px] text-text-muted mt-2 max-w-[72ch]">
              Switching your <span className="text-text">{fmtCHF(threat.switch.positionValueCHF)}</span> would cost about{' '}
              <span className="text-text">{fmtCHF(threat.switch.roundTripFeeCHF)}</span> in fees — at the current pace the
              performance difference earns that back in{' '}
              <span className="text-text">{threat.switch.monthsToRecoverFee} months</span>.
            </p>
          )}
        </div>
      ) : (
        <div className="card !p-4 border-l-2 border-l-gain">
          <div className="font-semibold text-gain flex items-center gap-2">
            <Swords size={16} /> Nobody is gaining on this position
          </div>
          <p className="text-sm text-text-muted mt-1">
            No comparable company is ahead of your holding or closing the gap since you bought on{' '}
            {fmtDate(data.entryDate ?? null)}.
          </p>
        </div>
      )}

      {rivals.length > 0 && (
        <div>
          <div className="eyebrow mb-2">The field · since {fmtDate(data.entryDate ?? null)}</div>
          <div className="border border-hairline rounded overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="th">Company</th>
                    <th className="th">Standing</th>
                    <th className="th text-right">Gap vs. you</th>
                    <th className="th text-right">Closing at</th>
                    <th className="th text-right">Overtakes in</th>
                    <th className="th text-right">Margin of safety</th>
                  </tr>
                </thead>
                <tbody>
                  {rivals.map((r) => <RivalRow key={r.symbol} r={r} onOpen={openModal} />)}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-[11px] text-text-faint mt-1 max-w-[80ch]">{data.note}</p>
        </div>
      )}
    </div>
  );
}

function RivalRow({ r, onOpen }: { r: Rival; onOpen: ReturnType<typeof useApp.getState>['openModal'] }) {
  return (
    <tr className={r.threatGroup === 0 ? 'bg-surface-2' : ''}>
      <td className="td">
        <button
          type="button"
          onClick={() => onOpen({ kind: 'opportunity', symbol: r.symbol, name: r.name, currency: r.currency })}
          title={`Open ${r.symbol}`}
          className="group inline-flex items-center gap-2 text-left cursor-pointer"
        >
          <span className="font-mono text-text group-hover:text-azure underline-offset-2 group-hover:underline">{r.symbol}</span>
          {r.name && <span className="text-text-faint truncate group-hover:text-text-muted">{r.name}</span>}
        </button>
      </td>
      <td className="td">
        <span className={`text-[12px] ${VERDICT[r.verdict].tone}`}>{GROUP_LABEL[r.threatGroup]}</span>
        {r.threatGroup === 2 && (
          <TrendingDown size={12} className="inline ml-1.5 text-gain" aria-label="losing ground" />
        )}
      </td>
      <td className={`td text-right font-mono tnum ${r.gap >= 0 ? 'text-loss' : 'text-gain'}`}>{fmtPctSigned(r.gap)}</td>
      <td className={`td text-right font-mono tnum ${r.closingSpeedPerYear == null ? 'text-text-faint' : r.closingSpeedPerYear > 0 ? 'text-loss' : 'text-gain'}`}>
        {r.closingSpeedPerYear == null ? '—' : `${fmtPctSigned(r.closingSpeedPerYear)}/yr`}
      </td>
      <td className="td text-right font-mono tnum text-text-muted">
        {r.daysToCrossover != null ? `${r.daysToCrossover} d` : '—'}
      </td>
      <td className={`td text-right font-mono tnum ${r.marginOfSafety == null ? 'text-text-faint' : r.marginOfSafety < 0 ? 'text-loss' : 'text-gain'}`}>
        {r.marginOfSafety == null ? '—' : fmtPct(r.marginOfSafety)}
      </td>
    </tr>
  );
}
