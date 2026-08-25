import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import clsx from 'clsx';

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
