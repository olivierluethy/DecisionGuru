import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../lib/api';
import { clockSkewMs, liveExchange, useTicker } from '../lib/marketclock';

/**
 * Compact live open/closed status for the exchanges the portfolio trades on.
 * The server hands an absolute next-change instant; we tick a HH:MM:SS
 * countdown and each exchange's local clock once a second, and only refetch
 * occasionally (state changes are derived locally, then reconciled).
 */
export function MarketHoursStrip() {
  const qc = useQueryClient();
  const { data, dataUpdatedAt } = useQuery({
    queryKey: ['market-hours'],
    queryFn: api.marketHours,
    refetchInterval: 5 * 60_000,
  });
  const now = useTicker(1000);
  const exchanges = data?.exchanges ?? [];
  const skew = clockSkewMs(exchanges[0]?.serverNowUtc, dataUpdatedAt);

  // When any countdown reaches 0 the open/closed state has flipped — pull a
  // fresh authoritative status so the next-change target re-anchors.
  useEffect(() => {
    if (exchanges.some((ex) => liveExchange(ex, now, skew).remaining <= 0)) {
      qc.invalidateQueries({ queryKey: ['market-hours'] });
    }
  }, [now, exchanges, skew, qc]);

  if (!exchanges.length) return null;

  return (
    <div className="px-4 py-3 border-t border-hairline">
      <div className="eyebrow mb-2">Markets</div>
      <div className="flex flex-col gap-2">
        {exchanges.map((ex) => {
          const live = liveExchange(ex, now, skew);
          // `nextChange` is the state the countdown runs toward (the opposite of
          // the current state). Spell it out for the tooltip; the compact line
          // uses a −/+ prefix (− counts down to a close, + up to an open).
          const dir = ex.nextChange === 'closes' ? 'closes' : 'opens';
          return (
            <div
              key={ex.code}
              className="flex flex-col gap-0.5 min-w-0"
              title={`${ex.name} · ${live.localTime} local — ${
                live.isOpen ? 'Open' : 'Closed'
              }, ${dir} in ${live.countdown}`}
            >
              {/* Primary line: exchange · state · time until the state flips. */}
              <div className="flex items-center gap-1.5 min-w-0 text-[12px]">
                {/* Filled dot = open, hollow ring = closed — status without relying on colour. */}
                <span
                  className={clsx(
                    'w-1.5 h-1.5 rounded-full shrink-0',
                    live.isOpen ? 'bg-gain' : 'border border-text-faint',
                  )}
                />
                <span className="font-medium text-text shrink-0">{ex.code}</span>
                <span
                  className={clsx('text-[11px] shrink-0', live.isOpen ? 'text-gain' : 'text-text-muted')}
                >
                  {live.isOpen ? 'open' : 'closed'}
                </span>
                <span className="font-mono tnum text-text-faint text-[11px] ml-auto shrink-0 tabular-nums">
                  {ex.nextChange === 'closes' ? '−' : '+'}
                  {live.countdown}
                </span>
              </div>
              {/* Secondary line: full name (decodes the abbreviation) + local clock. */}
              <div className="flex items-baseline gap-2 min-w-0 pl-3">
                <span className="truncate text-[11px] text-text-faint min-w-0">{ex.name}</span>
                <span className="font-mono tnum text-text-faint/80 text-[10px] ml-auto shrink-0 tabular-nums">
                  {live.localTime}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
