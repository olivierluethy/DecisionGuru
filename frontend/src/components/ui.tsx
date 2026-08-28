import type { ReactNode } from 'react';
import { Loader2, ArrowUpRight, ArrowDownRight, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { InstrumentDataStatus } from '@decisionguru/shared';
import { fmtPctSigned } from '../lib/format';

export function Stat({
  label,
  value,
  sub,
  className,
  valueClass,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
  valueClass?: string;
}) {
  return (
    <div className={className}>
      <div className="eyebrow mb-1">{label}</div>
      <div className={clsx('font-mono text-lg font-medium tnum', valueClass)}>{value}</div>
      {sub && <div className="text-xs text-text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded border border-hairline bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'px-3 h-7 text-[13px] rounded-sm transition-colors',
            value === o.value ? 'bg-azure text-bg font-medium' : 'text-text-muted hover:text-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-text-muted text-sm py-8 justify-center">
      <Loader2 size={16} className="animate-spin" />
      {label ?? 'Loading…'}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6">
      <h3 className="font-display text-lg text-text mb-1">{title}</h3>
      {hint && <p className="text-sm text-text-muted max-w-md mb-4">{hint}</p>}
      {action}
    </div>
  );
}

export function StaleDot({ stale, asOf }: { stale?: boolean; asOf?: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-text-faint">
      <span className={clsx('w-1.5 h-1.5 rounded-full', stale ? 'bg-warn' : 'bg-gain')} />
      {stale ? 'cached' : 'live'}
    </span>
  );
}

const STATUS_META: Record<
  InstrumentDataStatus['state'],
  { dot: string; text: string; label: string }
> = {
  ok: { dot: 'bg-gain', text: 'text-text-faint', label: 'live' },
  stale: { dot: 'bg-warn', text: 'text-warn', label: 'cached' },
  pricing: { dot: 'bg-azure animate-pulse', text: 'text-azure', label: 'pricing…' },
  unresolved: { dot: 'bg-loss', text: 'text-loss', label: 'no ticker' },
  'no-data': { dot: 'bg-warn', text: 'text-warn', label: 'no data' },
  'data-issue': { dot: 'bg-loss', text: 'text-loss', label: 'data issue' },
};

/**
 * Per-instrument market-data health. Never let a 0 read as a real value: an unresolved
 * or dataless instrument shows an explicit badge (with the reason on hover) instead.
 */
export function DataStatusBadge({
  status,
  showOk = false,
  onRetry,
}: {
  status?: InstrumentDataStatus | null;
  showOk?: boolean;
  onRetry?: () => void;
}) {
  if (!status) return null;
  if (status.state === 'ok' && !showOk) return null;
  const m = STATUS_META[status.state];
  return (
    <span
      className={clsx('inline-flex items-center gap-1.5 text-[11px]', m.text)}
      title={status.message ?? undefined}
    >
      <span className={clsx('w-1.5 h-1.5 rounded-full', m.dot)} />
      {m.label}
      {status.state === 'unresolved' && onRetry && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
          className="underline underline-offset-2 hover:text-azure"
        >
          retry
        </button>
      )}
    </span>
  );
}

export function KindBadge({ kind }: { kind: string }) {
  return (
    <span
      className={clsx(
        'chip !py-0 !px-2 uppercase tracking-wide',
        kind === 'etf' ? 'text-gold border-gold/40' : 'text-azure border-azure/40',
      )}
    >
      {kind}
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Premium presentation primitives — shared across every view so the app reads
 * as one product. None of these fetch or compute anything; they render values
 * the caller already has, in a consistent visual hierarchy.
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Section title with a real display-face heading over an uppercase eyebrow
 * kicker, plus an optional trailing action/control cluster. Gives every section
 * the same head so the eye learns the rhythm of the page.
 */
export function SectionHeader({
  title,
  eyebrow,
  icon: Icon,
  action,
  className,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-wrap items-center justify-between gap-3', className)}>
      <div className="flex items-center gap-2.5 min-w-0">
        {Icon && (
          <span className="grid place-items-center w-8 h-8 rounded bg-surface-2 border border-hairline text-text-muted shrink-0">
            <Icon size={15} />
          </span>
        )}
        <div className="min-w-0">
          {eyebrow && <div className="eyebrow mb-0.5">{eyebrow}</div>}
          <h2 className="font-display text-[15px] font-semibold text-text leading-tight truncate">{title}</h2>
        </div>
      </div>
      {action && <div className="flex items-center gap-2 shrink-0">{action}</div>}
    </div>
  );
}

export type Accent = 'azure' | 'gold' | 'gain' | 'loss' | 'neutral';

const ACCENT_BORDER: Record<Accent, string> = {
  azure: 'border-l-azure',
  gold: 'border-l-gold',
  gain: 'border-l-gain',
  loss: 'border-l-loss',
  neutral: 'border-l-hairline-strong',
};

/**
 * Primary metric surface. One clear reading order: eyebrow label → large mono
 * value → a delta/sub line for context. A left accent bar carries meaning
 * (azure = you, gold = counterfactual, gain/loss = direction). Becomes a button
 * when `onClick` is supplied, with the same quiet hover as any interactive card.
 */
export function MetricCard({
  label,
  icon: Icon,
  value,
  valueClass,
  delta,
  sub,
  spark,
  accent = 'neutral',
  onClick,
  className,
  labelClass,
}: {
  label: ReactNode;
  icon?: LucideIcon;
  value: ReactNode;
  valueClass?: string;
  delta?: ReactNode;
  sub?: ReactNode;
  spark?: ReactNode;
  accent?: Accent;
  onClick?: () => void;
  className?: string;
  labelClass?: string;
}) {
  const body = (
    <>
      <div className={clsx('flex items-center gap-1.5 eyebrow mb-2', labelClass)}>
        {Icon && <Icon size={12} className="shrink-0" />}
        <span className="truncate">{label}</span>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className={clsx('font-mono font-semibold text-2xl tnum leading-none', valueClass)}>{value}</div>
        {spark && <div className="shrink-0 pb-0.5">{spark}</div>}
      </div>
      {(delta != null || sub != null) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {delta}
          {sub != null && <span className="text-text-muted">{sub}</span>}
        </div>
      )}
    </>
  );
  const cls = clsx('card border-l-2', ACCENT_BORDER[accent], className);
  if (onClick) {
    return (
      <button onClick={onClick} className={clsx(cls, 'card-interactive text-left w-full')}>
        {body}
      </button>
    );
  }
  return <div className={cls}>{body}</div>;
}

/**
 * Directional change chip. `value` is a fraction (0.024 → “+2.4%”). Zero reads
 * muted with no arrow; positive/negative carry the gain/loss tint and an arrow.
 */
export function DeltaPill({
  value,
  digits = 1,
  className,
  suffix,
}: {
  value: number | null | undefined;
  digits?: number;
  className?: string;
  suffix?: ReactNode;
}) {
  if (value == null || !Number.isFinite(value)) return null;
  const up = value > 0;
  const down = value < 0;
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : null;
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium tnum',
        up && 'text-gain bg-gain/10',
        down && 'text-loss bg-loss/10',
        !up && !down && 'text-text-muted bg-surface-2',
        className,
      )}
    >
      {Icon && <Icon size={11} className="shrink-0" />}
      {fmtPctSigned(value, digits)}
      {suffix != null && <span className="text-text-faint ml-0.5">{suffix}</span>}
    </span>
  );
}

/**
 * Inline SVG sparkline — a shape, not a chart. Inherits `currentColor` so the
 * caller tints it (text-azure / text-gain / text-loss). Renders nothing below
 * two finite points. Stroke stays crisp at any width via non-scaling-stroke.
 */
export function Sparkline({
  data,
  width = 96,
  height = 28,
  fill = true,
  className,
  strokeWidth = 1.5,
}: {
  data: (number | null | undefined)[];
  width?: number;
  height?: number;
  fill?: boolean;
  className?: string;
  strokeWidth?: number;
}) {
  const pts = data.filter((n): n is number => n != null && Number.isFinite(n));
  if (pts.length < 2) return null;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const stepX = width / (pts.length - 1);
  const y = (v: number) => height - ((v - min) / span) * (height - 2) - 1;
  const line = pts.map((v, i) => `${i ? 'L' : 'M'}${(i * stepX).toFixed(2)} ${y(v).toFixed(2)}`).join(' ');
  const area = `${line} L${width} ${height} L0 ${height} Z`;
  const gid = `spark-${Math.round(min)}-${Math.round(max)}-${pts.length}`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={clsx('overflow-visible', className)}
      aria-hidden
    >
      {fill && (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gid})`} stroke="none" />
        </>
      )}
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * Horizontal proportion bar. `value`/`max` set the fill; the track sits on the
 * card surface so it works inside any card. Used for weights and fundamentals.
 */
export function MiniBar({
  value,
  max = 1,
  barClass = 'bg-azure',
  className,
}: {
  value: number | null | undefined;
  max?: number;
  barClass?: string;
  className?: string;
}) {
  const pct = value != null && Number.isFinite(value) && max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={clsx('h-1.5 rounded-full bg-surface-2 overflow-hidden', className)}>
      <div className={clsx('h-full rounded-full transition-[width] duration-500', barClass)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Shimmering placeholder that holds layout while data loads. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={clsx('relative overflow-hidden rounded bg-surface-2/70', className)}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />
    </div>
  );
}

/**
 * Quiet entrance wrapper: a small lift + fade on mount, staggered by `delay`.
 * Uses the `fade-up` keyframe with `both` fill so it lands visible even when the
 * global reduced-motion rule collapses the duration — content is never hidden.
 */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <div className={clsx('animate-fade-up', className)} style={delay ? { animationDelay: `${delay}ms` } : undefined}>
      {children}
    </div>
  );
}
