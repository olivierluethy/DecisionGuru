import type { ExposureSlice } from '../lib/api';

/** ISO-3166 alpha-2 (e.g. "CH") → flag emoji via regional-indicator symbols. */
function flagEmoji(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return '';
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function Bars({
  title,
  slices,
  max = 8,
  flags = false,
}: {
  title: string;
  slices: ExposureSlice[];
  max?: number;
  flags?: boolean;
}) {
  const top = slices.slice(0, max);
  const rest = slices.slice(max);
  const restWeight = rest.reduce((s, x) => s + x.weight, 0);
  const rows = restWeight > 0 ? [...top, { key: '__rest', label: `${rest.length} more`, weight: restWeight }] : top;
  const peak = Math.max(...rows.map((r) => r.weight), 0.0001);

  return (
    <div>
      <div className="eyebrow mb-2">{title}</div>
      <div className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2 text-[13px]">
            <span className="w-28 shrink-0 truncate text-text-muted flex items-center gap-1.5" title={r.label}>
              {flags && flagEmoji(r.key) && <span className="text-base leading-none">{flagEmoji(r.key)}</span>}
              <span className="truncate">{r.label}</span>
            </span>
            <div className="flex-1 h-2 rounded-sm bg-surface-2 overflow-hidden">
              <div
                className="h-full bg-gold/70 rounded-sm"
                style={{ width: `${(r.weight / peak) * 100}%` }}
              />
            </div>
            <span className="font-mono tnum text-text-faint w-12 text-right">
              {(r.weight * 100).toFixed(1)}%
            </span>
          </div>
        ))}
        {!rows.length && <div className="text-sm text-text-faint">No breakdown available.</div>}
      </div>
    </div>
  );
}

/** Country + sector exposure as ranked horizontal bars (gold, matching allocation motif). */
export function ExposureBars({
  countries,
  sectors,
  columns = true,
}: {
  countries: ExposureSlice[];
  sectors: ExposureSlice[];
  columns?: boolean;
}) {
  return (
    <div className={columns ? 'grid sm:grid-cols-2 gap-6' : 'flex flex-col gap-6'}>
      <Bars title="Geography" slices={countries} flags />
      <Bars title="Sector" slices={sectors} />
    </div>
  );
}
