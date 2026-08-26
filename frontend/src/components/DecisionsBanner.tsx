import { useQuery } from '@tanstack/react-query';
import { Compass, ArrowRight } from 'lucide-react';
import { api } from '../lib/api';
import { fmtCHF } from '../lib/format';
import { useApp } from '../store';

/** Proactive strategy surface on the Overview: the single most important thing to act on,
 * with a route into the full Decisions view. Renders nothing when there's no signal. */
export function DecisionsBanner() {
  const { setView } = useApp();
  const { data } = useQuery({ queryKey: ['recommendations'], queryFn: api.recommendations });
  if (!data) return null;

  const actionable = data.recommendations.filter((r) => r.action === 'sell' || r.action === 'trim');
  const hasCash = !!data.cashSignal;
  if (!actionable.length && !hasCash) return null;

  const top = actionable.slice(0, 3);

  return (
    <button
      onClick={() => setView('decisions')}
      className="w-full text-left card border-l-2 border-l-warn hover:border-hairline-strong transition-colors mb-6 flex items-center gap-4"
    >
      <Compass size={18} className="text-warn shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text">
          {actionable.length > 0 ? (
            <>
              <span className="font-medium text-warn">{actionable.length} holding{actionable.length > 1 ? 's' : ''}</span>{' '}
              flagged to reallocate · <span className="font-mono tnum">{fmtCHF(data.summary.reallocatableCHF)}</span> at stake
            </>
          ) : (
            <><span className="font-medium text-gain">{fmtCHF(data.summary.idleCashCHF)}</span> idle cash ready to deploy</>
          )}
        </div>
        <div className="text-[12px] text-text-faint mt-0.5 truncate">
          {top.length > 0
            ? top.map((r) => `${r.symbol} (${r.action})`).join(' · ')
            : data.cashSignal?.reason}
        </div>
      </div>
      <span className="flex items-center gap-1 text-[13px] text-azure shrink-0">
        Review decisions <ArrowRight size={14} />
      </span>
    </button>
  );
}
