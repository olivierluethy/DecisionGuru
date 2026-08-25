import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api } from '../lib/api';

export interface SymbolPick {
  symbol: string;
  name: string;
  kind: string;
}

export function SymbolSearch({ onPick }: { onPick: (p: SymbolPick) => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const { data, isFetching } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.searchSymbol(debounced),
    enabled: debounced.trim().length >= 1,
  });

  return (
    <div>
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-faint" />
        <input
          className="input pl-9"
          placeholder="Search ticker, name or ISIN (e.g. Nike, AAPL, CH0012032048)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
      </div>
      {debounced && (
        <div className="mt-2 border border-hairline rounded divide-y divide-hairline max-h-56 overflow-y-auto">
          {isFetching && <div className="px-3 py-2 text-sm text-text-faint">Searching…</div>}
          {!isFetching && !data?.length && <div className="px-3 py-2 text-sm text-text-faint">No matches.</div>}
          {data?.map((r) => (
            <button
              key={r.symbol}
              className="w-full text-left px-3 py-2 hover:bg-surface-2 flex items-center gap-2 text-sm"
              onClick={() => onPick({ symbol: r.symbol, name: r.name, kind: r.kind })}
            >
              <span className="font-mono text-azure w-24 shrink-0">{r.symbol}</span>
              <span className="truncate text-text">{r.name}</span>
              <span className="ml-auto text-[11px] uppercase text-text-faint">{r.kind}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
