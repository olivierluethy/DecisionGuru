import type { RangeStats as RangeStatsT } from '@decisionguru/shared';
import { fmtCHF, fmtPctSigned, plClass } from '../lib/format';

/** Compact high / low / start / end / % strip describing the selected range. */
export function RangeStats({ stats }: { stats: RangeStatsT | null }) {
  if (!stats) return null;
  const cell = (label: string, value: string, cls?: string) => (
    <div>
      <div className="eyebrow mb-0.5">{label}</div>
      <div className={`font-mono tnum text-sm ${cls ?? ''}`}>{value}</div>
    </div>
  );
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2">
      {cell('Start', fmtCHF(stats.start))}
      {cell('End', fmtCHF(stats.end))}
      {cell('High', fmtCHF(stats.high))}
      {cell('Low', fmtCHF(stats.low))}
      {cell('Change', fmtPctSigned(stats.changePct), plClass(stats.changeAbs))}
    </div>
  );
}
