import { useMemo } from 'react';
import clsx from 'clsx';
import { SlidersHorizontal, X } from 'lucide-react';
import type { ScreenerRow } from '../lib/api';
import { fmtNum, fmtPct, fmtPctSigned } from '../lib/format';
import { RangeFilter, type Range } from './RangeFilter';

/** The numeric columns the range bar filters on. */
export type MetricKey = 'mos' | 'yield' | 'quality' | 'supportable' | 'price';
/** An active range per metric; a metric absent here is unfiltered. */
export type Ranges = Partial<Record<MetricKey, Range>>;

interface MetricDef {
  key: MetricKey;
  label: string;
  /** The row's value for this metric, or null when it has none (excluded, never 0). */
  get: (r: ScreenerRow) => number | null;
  format: (v: number) => string;
}

// Quality is stored as a 0..1 fraction; shown as a 0..100 score to match the table's /max.
export const METRICS: MetricDef[] = [
  { key: 'mos', label: 'Margin of safety', get: (r) => r.marginOfSafety, format: (v) => fmtPctSigned(v, 0) },
  { key: 'yield', label: 'Dividend yield', get: (r) => r.dividendYield, format: (v) => fmtPct(v, 1) },
  { key: 'quality', label: 'Quality', get: (r) => (r.quality.max ? r.quality.score / r.quality.max : null), format: (v) => `${Math.round(v * 100)}` },
  { key: 'supportable', label: 'Supportable', get: (r) => r.supportableReturn, format: (v) => fmtPct(v, 0) },
  { key: 'price', label: 'Price', get: (r) => r.price, format: (v) => fmtNum(v, false) },
];

const META = Object.fromEntries(METRICS.map((m) => [m.key, m])) as Record<MetricKey, MetricDef>;
const EPS = 1e-6;

/** The reachable [min,max] for each metric, from the data's own spread. Null when there
 *  aren't at least two distinct values to range over (nothing to filter). */
export function computeDomains(rows: ScreenerRow[]): Partial<Record<MetricKey, Range>> {
  const out: Partial<Record<MetricKey, Range>> = {};
  for (const m of METRICS) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of rows) {
      const v = m.get(r);
      if (v == null || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo !== Infinity && hi - lo > EPS) out[m.key] = { min: lo, max: hi };
  }
  return out;
}

/** A metric filters only when its range is narrower than the full domain on either end. */
export function isMetricActive(key: MetricKey, ranges: Ranges, domains: Partial<Record<MetricKey, Range>>): boolean {
  const r = ranges[key];
  const d = domains[key];
  if (!r || !d) return false;
  return r.min > d.min + EPS || r.max < d.max - EPS;
}

/** True when a row clears every active range. A row missing a value for an active metric is
 *  excluded from that metric (never coerced to 0) but reappears when the range is cleared. */
export function passesRanges(r: ScreenerRow, ranges: Ranges, domains: Partial<Record<MetricKey, Range>>): boolean {
  for (const m of METRICS) {
    if (!isMetricActive(m.key, ranges, domains)) continue;
    const v = m.get(r);
    if (v == null || !Number.isFinite(v)) return false;
    const range = ranges[m.key]!;
    if (v < range.min - EPS || v > range.max + EPS) return false;
  }
  return true;
}

export function activeMetricCount(ranges: Ranges, domains: Partial<Record<MetricKey, Range>>): number {
  return METRICS.reduce((n, m) => n + (isMetricActive(m.key, ranges, domains) ? 1 : 0), 0);
}

interface Preset {
  key: string;
  label: string;
  /** The floor thresholds this preset sets (metric → min, clamped into its domain). */
  floors: Partial<Record<MetricKey, number>>;
}

// Common value combinations. A preset only *sets* the underlying ranges — still editable.
const PRESETS: Preset[] = [
  { key: 'high-mos', label: 'High MoS', floors: { mos: 0.25 } },
  { key: 'high-yield', label: 'High yield', floors: { yield: 0.03 } },
  { key: 'undervalued-income', label: 'Undervalued income', floors: { mos: 0.25, yield: 0.03 } },
];

function applyPreset(preset: Preset, ranges: Ranges, domains: Partial<Record<MetricKey, Range>>): Ranges {
  const next: Ranges = { ...ranges };
  for (const [k, floor] of Object.entries(preset.floors) as [MetricKey, number][]) {
    const d = domains[k];
    if (!d) continue;
    const min = Math.min(Math.max(floor, d.min), d.max);
    next[k] = { min, max: d.max };
  }
  return next;
}

/** A preset reads active while every floor it sets is still satisfied by the current ranges. */
function presetActive(preset: Preset, ranges: Ranges, domains: Partial<Record<MetricKey, Range>>): boolean {
  const entries = Object.entries(preset.floors) as [MetricKey, number][];
  return entries.every(([k, floor]) => {
    const r = ranges[k];
    const d = domains[k];
    if (!r || !d) return false;
    return r.min >= Math.min(Math.max(floor, d.min), d.max) - EPS && isMetricActive(k, ranges, domains);
  });
}

/**
 * The Discover numeric filter bar (§9d): a dual-thumb range per numeric column, preset
 * chips for common value combinations, an active-filter count and a clear-all. Composes by
 * AND with the sector / industry / verdict dropdowns and the mode toggle; the caller feeds
 * the result to both the table and the map. Filtering is live (no apply button).
 */
export function DiscoverFilterBar({
  rows,
  ranges,
  onRanges,
  otherActiveCount,
  onClearAll,
}: {
  rows: ScreenerRow[];
  ranges: Ranges;
  onRanges: (r: Ranges) => void;
  /** Active dropdown filters (sector / industry / verdict) to add to the count + clear-all. */
  otherActiveCount: number;
  onClearAll: () => void;
}) {
  const domains = useMemo(() => computeDomains(rows), [rows]);
  const shown = METRICS.filter((m) => domains[m.key]);
  const activeCount = activeMetricCount(ranges, domains) + otherActiveCount;

  const setRange = (key: MetricKey, r: Range) => onRanges({ ...ranges, [key]: r });

  const togglePreset = (p: Preset) => {
    if (presetActive(p, ranges, domains)) {
      // Clear just the metrics this preset governs.
      const next = { ...ranges };
      for (const k of Object.keys(p.floors) as MetricKey[]) delete next[k];
      onRanges(next);
    } else {
      onRanges(applyPreset(p, ranges, domains));
    }
  };

  if (shown.length === 0) return null;

  return (
    <div className="card !py-4 mb-4">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="eyebrow flex items-center gap-2">
          <SlidersHorizontal size={13} /> Refine by value
        </div>
        <div className="flex items-center gap-2">
          {PRESETS.map((p) => {
            const on = presetActive(p, ranges, domains);
            return (
              <button
                key={p.key}
                onClick={() => togglePreset(p)}
                className={clsx('chip !py-1 transition-colors',
                  on ? 'text-azure border-azure/50' : 'hover:border-hairline-strong')}
                title={`Set ${p.label} thresholds`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-4">
        {shown.map((m) => {
          const d = domains[m.key]!;
          return (
            <RangeFilter
              key={m.key}
              label={m.label}
              domain={d}
              value={ranges[m.key] ?? d}
              onChange={(r) => setRange(m.key, r)}
              format={META[m.key].format}
              active={isMetricActive(m.key, ranges, domains)}
            />
          );
        })}
      </div>

      {activeCount > 0 && (
        <div className="flex items-center gap-3 mt-3 pt-3 border-t border-hairline">
          <span className="text-[12px] text-text-faint tnum">
            {activeCount} {activeCount === 1 ? 'filter' : 'filters'} active
          </span>
          <button className="btn-ghost !h-7 !px-2 text-[12px] ml-auto" onClick={onClearAll}>
            <X size={13} /> Clear all filters
          </button>
        </div>
      )}
    </div>
  );
}
