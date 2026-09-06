import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Check } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { SymbolSearch } from './SymbolSearch';
import { KindBadge } from './ui';

/**
 * A controlled single-symbol picker: a full-width field that opens a popover combining a
 * free-text search over the whole supported universe (any stock / ETF, by ticker / name /
 * ISIN) with a quick-pick list of the configured benchmark ETFs. Mirrors the Portfolio
 * "compare with" popover, but owns no global state — the caller drives it via value/onChange,
 * so it works anywhere (e.g. a scenario benchmark or subject), holdings or not.
 */
export function SymbolPicker({
  value, onChange, placeholder = 'Search stock or ETF…', align = 'left', className,
}: {
  value: string;
  onChange: (symbol: string) => void;
  placeholder?: string;
  align?: 'left' | 'right';
  className?: string;
}) {
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const benchmarks = settings?.benchmarks ?? [];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (symbol: string) => { onChange(symbol); setOpen(false); };
  const currentName = benchmarks.find((b) => b.symbol === value)?.name;

  return (
    <div ref={ref} className={clsx('relative', className)}>
      <button
        type="button"
        className="input w-full inline-flex items-center justify-between gap-2 cursor-pointer"
        onClick={() => setOpen((v) => !v)}
        title={value ? (currentName ? `${value} — ${currentName}` : value) : placeholder}
      >
        <span className={clsx('font-mono truncate', value ? 'text-text' : 'text-text-faint')}>
          {value || placeholder}
        </span>
        <ChevronDown size={14} className="text-text-faint shrink-0" />
      </button>

      {open && (
        <div className={clsx('absolute z-30 mt-1 w-80 max-w-[80vw] bg-surface border border-hairline rounded shadow-xl p-2',
          align === 'right' ? 'right-0' : 'left-0')}>
          <div className="eyebrow px-1 pb-1.5">Search — any stock or ETF</div>
          <SymbolSearch onPick={(p) => pick(p.symbol)} />
          {benchmarks.length > 0 && (
            <>
              <div className="eyebrow px-1 pb-1 pt-3">Benchmarks</div>
              <div className="max-h-56 overflow-y-auto">
                {benchmarks.map((b) => {
                  const active = b.symbol === value;
                  return (
                    <button
                      key={b.symbol}
                      type="button"
                      onClick={() => pick(b.symbol)}
                      className={clsx('w-full text-left px-2 py-1.5 rounded hover:bg-surface-2 flex items-center gap-2 text-sm',
                        active ? 'bg-surface-2' : '')}
                    >
                      <span className="font-mono text-azure w-20 shrink-0">{b.symbol}</span>
                      <span className="truncate text-text flex-1">{b.name}</span>
                      <KindBadge kind="etf" />
                      {active && <Check size={14} className="text-azure shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
