import clsx from 'clsx';
import { TrendingUp, Minus, TrendingDown } from 'lucide-react';
import type { Verdict, VerdictKey } from '../lib/api';

/** Verdict → semantic colour + copy. Reuses the reserved gain/neutral/loss tokens, exactly
 *  as §9c of the styleguide specifies. This is the ONE verdict vocabulary in the app. */
export const VERDICT_META: Record<
  VerdictKey,
  { label: string; text: string; border: string; dot: string; Icon: typeof Minus }
> = {
  'buy-more': { label: 'Buy more', text: 'text-gain', border: 'border-l-gain', dot: 'bg-gain', Icon: TrendingUp },
  hold: { label: 'Hold', text: 'text-text-muted', border: 'border-l-hairline-strong', dot: 'bg-text-faint', Icon: Minus },
  sell: { label: 'Sell', text: 'text-loss', border: 'border-l-loss', dot: 'bg-loss', Icon: TrendingDown },
};

/** The canonical verdict chip — used on every surface that shows a recommendation. */
export function VerdictBadge({
  verdict,
  action,
  confidence,
  withIcon = false,
  title,
  className,
}: {
  verdict: VerdictKey;
  /** Ownership-aware label to show instead of the default key label (colour/icon still
   *  come from the key, so an owned "Reduce" keeps the Hold colour, a "Buy" the gain). */
  action?: { label: string } | null;
  confidence?: string | null;
  withIcon?: boolean;
  title?: string;
  className?: string;
}) {
  const m = VERDICT_META[verdict];
  const label = action?.label ?? m.label;
  return (
    <span title={title} className={clsx('chip !py-0 !px-2 inline-flex items-center gap-1.5', m.text, className)}>
      {withIcon ? <m.Icon size={12} /> : <span className={clsx('w-1.5 h-1.5 rounded-full', m.dot)} />}
      {label}
      {confidence && <span className="text-[11px] text-text-faint ml-0.5">· {confidence}</span>}
    </span>
  );
}

/** Rationale + conflict note + trim note block that sits under a verdict badge. Renders
 *  the shared engine's explanation verbatim so every view reads identically. */
export function VerdictRationale({
  verdict,
  showRationale = true,
  className,
}: {
  verdict: Verdict;
  showRationale?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      {showRationale && (
        <p className="text-[13px] text-text-muted leading-relaxed tnum">{verdict.rationale}</p>
      )}
      {verdict.conflictNote && (
        <p className="text-[12px] text-text-faint mt-1 flex gap-1.5">
          <span aria-hidden className="shrink-0">↔</span>
          <span>{verdict.conflictNote}</span>
        </p>
      )}
      {verdict.trimNote && <p className="text-[12px] text-warn mt-1">{verdict.trimNote}</p>}
    </div>
  );
}
