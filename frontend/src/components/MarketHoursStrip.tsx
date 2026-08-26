import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../lib/api';

function untilLabel(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m`;
  return `${Math.round(h / 24)}d`;
}

/** Compact live open/closed status for the exchanges the portfolio trades on. */
export function MarketHoursStrip() {
  const { data } = useQuery({
    queryKey: ['market-hours'],
    queryFn: api.marketHours,
    refetchInterval: 60_000,
  });
  const exchanges = data?.exchanges ?? [];
  if (!exchanges.length) return null;

  return (
    <div className="px-4 py-3 border-t border-hairline">
      <div className="eyebrow mb-2">Markets</div>
      <div className="flex flex-col gap-1.5">
        {exchanges.map((ex) => (
          <div key={ex.code} className="flex items-center gap-2 text-[12px]" title={`${ex.name} · ${ex.localTime} local`}>
            <span
              className={clsx('w-1.5 h-1.5 rounded-full shrink-0', ex.isOpen ? 'bg-gain' : 'bg-text-faint')}
            />
            <span className="text-text-muted w-10 shrink-0">{ex.code}</span>
            <span className="font-mono tnum text-text-faint w-11 shrink-0">{ex.localTime}</span>
            <span className={clsx('ml-auto tnum', ex.isOpen ? 'text-gain' : 'text-text-faint')}>
              {ex.isOpen ? 'open' : 'closed'}
            </span>
            <span className="text-text-faint tnum w-14 text-right shrink-0">
              {ex.nextChange === 'closes' ? '−' : '+'}
              {untilLabel(ex.minutesToNextChange)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
