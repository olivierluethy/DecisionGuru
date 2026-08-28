import { useId, useState } from 'react';
import clsx from 'clsx';

export interface Range { min: number; max: number }

/**
 * A compact dual-thumb range control for one numeric metric (§9d). The track is
 * `--surface-2`; the selected span between the thumbs fills `--azure`. Two overlaid native
 * range inputs keep it accessible and keyboard-operable; the thumb the user grabbed is
 * raised so both ends stay reachable even when they meet. The live min–max readout is shown
 * in the metric's own unit via `format`.
 */
export function RangeFilter({
  label,
  domain,
  value,
  onChange,
  format,
  active,
}: {
  label: string;
  domain: Range;
  value: Range;
  onChange: (r: Range) => void;
  format: (v: number) => string;
  active: boolean;
}) {
  const id = useId();
  const [top, setTop] = useState<'min' | 'max'>('max');
  const span = Math.max(domain.max - domain.min, 1e-9);
  const step = span / 100;
  const leftPct = ((value.min - domain.min) / span) * 100;
  const rightPct = ((domain.max - value.max) / span) * 100;

  // Bounded so a thumb can't cross its neighbour.
  const setMin = (v: number) => onChange({ min: Math.min(v, value.max), max: value.max });
  const setMax = (v: number) => onChange({ min: value.min, max: Math.max(v, value.min) });

  return (
    <div className="min-w-[168px]">
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <span className={clsx('text-[12px] font-medium', active ? 'text-text' : 'text-text-muted')}>
          {label}
        </span>
        <span className="font-mono tnum text-[11px] text-text-faint">
          {format(value.min)}<span className="mx-0.5">–</span>{format(value.max)}
        </span>
      </div>
      <div className="relative h-3.5 flex items-center">
        <div className="absolute inset-x-0 h-1.5 rounded-full bg-surface-2" />
        <div
          className="absolute h-1.5 rounded-full bg-azure"
          style={{ left: `${leftPct}%`, right: `${rightPct}%` }}
        />
        <input
          type="range"
          className="dg-range"
          style={{ zIndex: top === 'min' ? 30 : 20 }}
          min={domain.min}
          max={domain.max}
          step={step}
          value={value.min}
          aria-label={`${label} minimum`}
          onPointerDown={() => setTop('min')}
          onChange={(e) => setMin(Number(e.target.value))}
        />
        <input
          type="range"
          className="dg-range"
          style={{ zIndex: top === 'max' ? 30 : 20 }}
          min={domain.min}
          max={domain.max}
          step={step}
          value={value.max}
          aria-label={`${label} maximum`}
          onPointerDown={() => setTop('max')}
          onChange={(e) => setMax(Number(e.target.value))}
        />
        <label htmlFor={id} className="sr-only">{label} range</label>
      </div>
    </div>
  );
}
