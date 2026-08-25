import clsx from 'clsx';
import type { RangeKey } from '@decisionguru/shared';

export const RANGE_KEYS: RangeKey[] = ['1D', '30D', '1M', '2M', '5M', '6M', '1Y', '2Y', '5Y', 'MAX'];

/** Shared time-range presets for every performance chart (portfolio & per-security). */
export function TimeRangeSelector({
  value,
  onChange,
  ranges = RANGE_KEYS,
}: {
  value: RangeKey;
  onChange: (r: RangeKey) => void;
  ranges?: RangeKey[];
}) {
  return (
    <div className="inline-flex rounded border border-hairline bg-surface-2 p-0.5 overflow-x-auto max-w-full">
      {ranges.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={clsx(
            'px-2.5 h-7 text-[12px] rounded-sm transition-colors font-mono shrink-0',
            value === r ? 'bg-azure text-bg font-medium' : 'text-text-muted hover:text-text',
          )}
        >
          {r}
        </button>
      ))}
    </div>
  );
}
