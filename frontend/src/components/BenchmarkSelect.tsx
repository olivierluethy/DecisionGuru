import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Check } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../store';
import { SymbolSearch } from './SymbolSearch';
import { KindBadge } from './ui';

/**
 * The "vs" comparison-asset selector. Sets the global `benchmark` symbol that every
 * comparison view (counterfactual chart, break-even, projection, what-if) keys off.
 *
 * Not limited to the configured benchmark ETFs: users can search the full supported
 * universe (any stock or ETF, by ticker / name / ISIN) via the shared `SymbolSearch`,
 * or quick-pick one of the default benchmarks. The chosen symbol flows straight into
 * the existing counterfactual calculation — only the symbol changes, nothing else.
 */
export function BenchmarkSelect({ compact = false }: { compact?: boolean }) {
  const { benchmark, setBenchmark } = useApp();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const benchmarks = settings?.benchmarks ?? [];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close the popover on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (symbol: string) => {
    setBenchmark(symbol);
    setOpen(false);
  };

  const currentName = benchmarks.find((b) => b.symbol === benchmark)?.name;

  return (
    <div ref={ref} className="relative inline-flex items-center gap-2">
      {!compact && <span className="text-text-muted text-sm">vs</span>}
      <button
        type="button"
        className="input !h-8 !w-auto inline-flex items-center gap-2 pr-2 cursor-pointer"
        onClick={() => setOpen((v) => !v)}
        title={currentName ? `${benchmark} — ${currentName}` : `Compare with ${benchmark}`}
      >
        <span className="font-mono text-text">{benchmark}</span>
        <ChevronDown size={14} className="text-text-faint" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-80 bg-surface border border-hairline rounded shadow-xl p-2">
          <div className="eyebrow px-1 pb-1.5">Compare with — any stock or ETF</div>
          <SymbolSearch onPick={(p) => pick(p.symbol)} />
          {benchmarks.length > 0 && (
            <>
              <div className="eyebrow px-1 pb-1 pt-3">Benchmarks</div>
              <div className="max-h-56 overflow-y-auto">
                {benchmarks.map((b) => {
                  const active = b.symbol === benchmark;
                  return (
                    <button
                      key={b.symbol}
                      type="button"
                      onClick={() => pick(b.symbol)}
                      className={`w-full text-left px-2 py-1.5 rounded hover:bg-surface-2 flex items-center gap-2 text-sm ${
                        active ? 'bg-surface-2' : ''
                      }`}
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
