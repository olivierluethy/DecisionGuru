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
      <div className="flex flex-col gap-1.5">
        {exchanges.map((ex) => {
          const live = liveExchange(ex, now, skew);
          return (
            <div
              key={ex.code}
              className="flex items-center gap-2 text-[12px]"
              title={`${ex.name} · ${live.localTime} local · ${live.isOpen ? 'open' : 'closed'}, ${
                ex.nextChange
              } in ${live.countdown}`}
            >
              <span
                className={clsx('w-1.5 h-1.5 rounded-full shrink-0', live.isOpen ? 'bg-gain' : 'bg-text-faint')}
              />
              <span className="text-text-muted w-9 shrink-0">{ex.code}</span>
              <span className="font-mono tnum text-text-faint w-[52px] shrink-0">{live.localTime}</span>
              <span className={clsx('tnum', live.isOpen ? 'text-gain' : 'text-text-faint')}>
                {live.isOpen ? 'open' : 'closed'}
              </span>
              <span
                className="font-mono tnum text-text-faint ml-auto text-right shrink-0 tabular-nums"
                title={`${ex.nextChange} in ${live.countdown}`}
              >
                {ex.nextChange === 'closes' ? '−' : '+'}
                {live.countdown}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
