import clsx from 'clsx';
import type { ExchangeStatus } from '../lib/api';
import { liveExchange, useTicker } from '../lib/marketclock';

/**
 * Live single-exchange status chip: a coloured dot, the exchange label, and a
 * HH:MM:SS countdown to the next open/close ticked once a second. Used on the
 * position and research headers.
 */
export function MarketStatusChip({
  hours,
  label = 'code',
}: {
  hours: ExchangeStatus;
  label?: 'code' | 'name';
}) {
  const now = useTicker(1000);
  const live = liveExchange(hours, now);
  return (
    <span
      className={clsx('chip !py-0.5', live.isOpen ? 'text-gain' : 'text-text-faint')}
      title={`${hours.name} · ${live.localTime} local · ${hours.nextChange} in ${live.countdown}`}
    >
      <span className={clsx('w-1.5 h-1.5 rounded-full', live.isOpen ? 'bg-gain' : 'bg-text-faint')} />
      {label === 'name' ? hours.name : hours.code} {live.isOpen ? 'open' : 'closed'}
      <span className="text-text-faint font-mono tnum ml-1">
        · {hours.nextChange === 'closes' ? '−' : '+'}
        {live.countdown}
      </span>
    </span>
  );
}
