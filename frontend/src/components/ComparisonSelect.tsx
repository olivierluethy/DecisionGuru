import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { api } from '../lib/api';
import { SymbolSearch } from './SymbolSearch';

// Distinct, dark-legible comparison-line colours — shared so a chip and its chart line match.
export const COMPARE_COLORS = ['#D9A94E', '#A98BFF', '#4FD0E0', '#F0883E', '#EC6DB0', '#B6D94E', '#8FA0B8'];

/**
 * The multi-ticker "vs" comparison selector, mirroring the header benchmark picker but for
 * an arbitrary NUMBER of comparison lines. Shows the subject symbol + "vs", then a chip per
 * comparison: the configured benchmark ETFs toggle on/off, any other stock or ETF (any market)
 * is added through the shared `SymbolSearch` and removed with its ✕. The chosen symbols flow
 * out through `onChange` as a plain string[] — the caller decides how each line is fetched and
 * drawn. `colorOf` lets the caller tint each active chip to match its chart line.
 */
export function ComparisonSelect({
  subject,
  selected,
  onChange,
  colorOf,
}: {
  subject?: string;
  selected: string[];
  onChange: (next: string[]) => void;
  colorOf?: (sym: string) => string;
}) {
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const benchmarkChoices = (settings?.benchmarks ?? []).map((b) => b.symbol);
  const [showAdd, setShowAdd] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close the add-popover on outside click or Escape.
  useEffect(() => {
    if (!showAdd) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowAdd(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowAdd(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showAdd]);

  const toggle = (sym: string) =>
    onChange(selected.includes(sym) ? selected.filter((s) => s !== sym) : [...selected, sym]);
  const add = (sym: string) => {
    if (!selected.includes(sym)) onChange([...selected, sym]);
  };
  const remove = (sym: string) => onChange(selected.filter((s) => s !== sym));

  const chipStyle = (sym: string) =>
    colorOf ? { borderColor: colorOf(sym), color: colorOf(sym) } : undefined;
  // Anything selected that is not one of the benchmark quick-picks (searched-in companies/ETFs).
  const custom = selected.filter((s) => s && !benchmarkChoices.includes(s));

  return (
    <div ref={ref} className="relative flex items-center gap-2 flex-wrap">
      {subject && (
        <span className="inline-flex items-center gap-2">
          <span className="font-mono text-text">{subject}</span>
          <span className="text-text-muted text-sm">vs</span>
        </span>
      )}
      {benchmarkChoices.map((sym) => {
        const on = selected.includes(sym);
        return (
          <button
            key={sym}
            onClick={() => toggle(sym)}
            className={`chip cursor-pointer ${on ? '!text-text' : 'opacity-60'}`}
            style={on ? chipStyle(sym) : undefined}
          >
            {sym}
          </button>
        );
      })}
      {custom.map((sym) => (
        <button
          key={sym}
          onClick={() => remove(sym)}
          title="Remove"
          className="chip cursor-pointer !text-text inline-flex items-center gap-1"
          style={chipStyle(sym)}
        >
          {sym} <X size={11} />
        </button>
      ))}
      <button onClick={() => setShowAdd((v) => !v)} className="chip cursor-pointer">
        <Plus size={12} /> Add stock / ETF
      </button>
      {showAdd && (
        <div className="absolute left-0 top-full z-30 mt-1 w-80 bg-surface border border-hairline rounded shadow-xl p-2">
          <div className="eyebrow px-1 pb-1.5">Compare with — any stock or ETF</div>
          <SymbolSearch
            onPick={(p) => {
              add(p.symbol);
              setShowAdd(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
