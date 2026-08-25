import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useApp } from '../store';

export function BenchmarkSelect({ compact = false }: { compact?: boolean }) {
  const { benchmark, setBenchmark } = useApp();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const benchmarks = settings?.benchmarks ?? [];

  return (
    <label className="flex items-center gap-2 text-sm">
      {!compact && <span className="text-text-muted">vs</span>}
      <select
        className="input !h-8 !w-auto pr-8 cursor-pointer"
        value={benchmark}
        onChange={(e) => setBenchmark(e.target.value)}
      >
        {benchmarks.map((b) => (
          <option key={b.symbol} value={b.symbol}>
            {b.symbol} — {b.name}
          </option>
        ))}
      </select>
    </label>
  );
}
