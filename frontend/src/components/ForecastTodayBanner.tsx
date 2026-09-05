import { useQuery } from '@tanstack/react-query';
import { CalendarClock, ArrowRight, Flame } from 'lucide-react';
import { api } from '../lib/api';
import { fmtCHF } from '../lib/format';
import { useApp } from '../store';

/**
 * Overview surface for issue #8: the single most useful line from the forecast — what to
 * act on today and the money each day of waiting costs — with a route into the full
 * Forecasts view. Renders nothing when there's neither an action nor a daily cost.
 */
export function ForecastTodayBanner() {
  const { setView } = useApp();
  const { data } = useQuery({ queryKey: ['forecast'], queryFn: () => api.forecast(30) });
  if (!data) return null;

  const count = data.today.count;
  const perDay = data.dailyOpportunityCostCHF;
  if (count === 0 && perDay <= 0) return null;

  const first = data.today.actions[0];

  return (
    <button
      onClick={() => setView('forecasts')}
      className="w-full text-left card border-l-2 border-l-azure hover:border-hairline-strong transition-colors mb-6 flex items-center gap-4"
    >
      <CalendarClock size={18} className="text-azure shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text flex items-center gap-2 flex-wrap">
          {count > 0 ? (
            <>
              <span className="font-medium text-azure">{count} to act on today</span>
              {perDay > 0 && (
                <span className="inline-flex items-center gap-1 text-loss">
                  <Flame size={12} /> <span className="font-mono tnum">{fmtCHF(perDay, true)}/day</span> at stake
                </span>
              )}
            </>
          ) : (
            <span className="inline-flex items-center gap-1 text-loss">
              <Flame size={12} /> <span className="font-mono tnum">{fmtCHF(perDay, true)}/day</span> lost to waiting
            </span>
          )}
        </div>
        {first && (
          <div className="text-[12px] text-text-faint mt-0.5 truncate">{first.title} · {first.detail}</div>
        )}
      </div>
      <span className="flex items-center gap-1 text-[13px] text-azure shrink-0">
        See the forecast <ArrowRight size={14} />
      </span>
    </button>
  );
}
