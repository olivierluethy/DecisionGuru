import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea,
  ReferenceDot,
} from 'recharts';
import type { MovementsResponse } from '../lib/api';
import { fmtDate, fmtNum } from '../lib/format';

export interface PriceOverlay {
  symbol: string;
  series: Array<{ date: string; close: number }>;
  /** Line colour (hex). */
  color: string;
}

interface Props {
  series: Array<{ date: string; close: number }>;
  movements?: MovementsResponse;
  currency?: string | null;
  height?: number;
  /**
   * Extra instruments to overlay. Each curve is rebased to the subject stock's price at
   * the first date both cover, so every line branches off the stock line at its start and
   * you compare shapes (their % paths) — independent of price scale or currency.
   */
  overlays?: PriceOverlay[];
}

const MAX_POINTS = 520;

type Row = Record<string, number | null>;

/** Last close on/before `ts` in a time-sorted `[{t,c}]` array (binary search). */
function closeAtOrBefore(sorted: { t: number; c: number }[], ts: number): number {
  let lo = 0, hi = sorted.length - 1, res = sorted[0].c;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].t <= ts) { res = sorted[mid].c; lo = mid + 1; } else hi = mid - 1;
  }
  return res;
}

/**
 * Full-history price with explainable annotations: stagnation stretches shaded (warn),
 * major up-legs marked gain and down-legs marked loss, plus optional rebased overlays of
 * other instruments. Time axis is numeric so uneven sampling and marker placement stay truthful.
 */
export function PriceMovementChart({ series, movements, currency, height = 300, overlays }: Props) {
  if (!series || series.length < 2) {
    return (
      <div className="flex items-center justify-center text-text-faint text-sm" style={{ height }}>
        No price history to chart.
      </div>
    );
  }
  const t = (d: string) => new Date(d).getTime();
  const ovs = (overlays ?? []).filter((o) => o.series.length >= 2);

  // Downsample for render, always keeping the marker anchor dates.
  const anchors = new Set<string>();
  movements?.legs.forEach((l) => anchors.add(l.to));
  movements?.stagnation.forEach((s) => {
    anchors.add(s.from);
    anchors.add(s.to);
  });
  const stride = Math.max(1, Math.ceil(series.length / MAX_POINTS));
  const data: Row[] = series
    .filter((p, i) => i % stride === 0 || i === series.length - 1 || anchors.has(p.date))
    .map((p) => ({ t: t(p.date), close: p.close }));

  // Rebase each overlay onto the stock's price at the first date both cover.
  ovs.forEach((ov, i) => {
    const key = `ov${i}`;
    data.forEach((d) => { d[key] = null; });
    const sorted = ov.series.map((p) => ({ t: t(p.date), c: p.close })).sort((a, b) => a.t - b.t);
    const firstT = sorted[0].t;
    const anchor = data.find((d) => (d.t as number) >= firstT);
    if (!anchor) return;
    const etfAtAnchor = closeAtOrBefore(sorted, anchor.t as number);
    const scale = etfAtAnchor > 0 ? (anchor.close as number) / etfAtAnchor : 0;
    if (scale > 0) {
      data.forEach((d) => {
        d[key] = (d.t as number) >= firstT ? closeAtOrBefore(sorted, d.t as number) * scale : null;
      });
    }
  });

  const ccy = currency || '';

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <defs>
          <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3DA9FC" stopOpacity={0.22} />
            <stop offset="100%" stopColor="#3DA9FC" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#243040" strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={(v) => fmtDate(new Date(v).toISOString().slice(0, 10)).replace(/^\d+ /, '')}
          tick={{ fill: '#5F6E82', fontSize: 11 }}
          stroke="#243040"
          minTickGap={48}
        />
        <YAxis
          tickFormatter={(v) => fmtNum(v, false)}
          tick={{ fill: '#5F6E82', fontSize: 11 }}
          stroke="#243040"
          width={64}
        />
        <Tooltip
          contentStyle={{ background: '#1A2331', border: '1px solid #243040', borderRadius: 6, fontSize: 12 }}
          labelStyle={{ color: '#93A1B5' }}
          labelFormatter={(v) => fmtDate(new Date(v as number).toISOString().slice(0, 10))}
          formatter={(value: number, name: string) => {
            if (typeof name === 'string' && name.startsWith('ov')) {
              const i = Number(name.slice(2));
              return [`${ccy} ${fmtNum(value)}`, `${ovs[i]?.symbol ?? 'ETF'} (rebased)`];
            }
            return [`${ccy} ${fmtNum(value)}`, 'Close'];
          }}
        />
        {/* Stagnation stretches — long near-zero-growth "dead money" periods. */}
        {movements?.stagnation.map((s, i) => (
          <ReferenceArea
            key={`stag-${i}`}
            x1={t(s.from)}
            x2={t(s.to)}
            fill="#F0B34A"
            fillOpacity={0.07}
            stroke="#F0B34A"
            strokeOpacity={0.18}
            strokeDasharray="3 3"
          />
        ))}
        <Area
          type="monotone"
          dataKey="close"
          stroke="#3DA9FC"
          strokeWidth={2}
          fill="url(#priceFill)"
          isAnimationActive={false}
          dot={false}
        />
        {/* Rebased comparison overlays (other ETFs / stocks). */}
        {ovs.map((ov, i) => (
          <Line
            key={ov.symbol}
            type="monotone"
            dataKey={`ov${i}`}
            stroke={ov.color}
            strokeWidth={2}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
        ))}
        {/* Major moves — surge (gain) / drop (loss) end markers. */}
        {movements?.legs.map((l, i) => (
          <ReferenceDot
            key={`leg-${i}`}
            x={t(l.to)}
            y={l.endClose}
            r={3.5}
            fill={l.kind === 'surge' ? '#31D6A0' : '#FF5D6C'}
            stroke="#0A0E15"
            strokeWidth={1.5}
          />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
