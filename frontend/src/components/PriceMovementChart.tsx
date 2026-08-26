import {
  ComposedChart,
  Area,
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

interface Props {
  series: Array<{ date: string; close: number }>;
  movements?: MovementsResponse;
  currency?: string | null;
  height?: number;
}

const MAX_POINTS = 520;

/**
 * Full-history price with explainable annotations: stagnation stretches shaded (warn),
 * major up-legs marked gain and down-legs marked loss. Time axis is numeric so uneven
 * sampling and marker placement stay truthful.
 */
export function PriceMovementChart({ series, movements, currency, height = 300 }: Props) {
  if (!series || series.length < 2) {
    return (
      <div className="flex items-center justify-center text-text-faint text-sm" style={{ height }}>
        No price history to chart.
      </div>
    );
  }
  const t = (d: string) => new Date(d).getTime();

  // Downsample for render, always keeping the marker anchor dates.
  const anchors = new Set<string>();
  movements?.legs.forEach((l) => anchors.add(l.to));
  movements?.stagnation.forEach((s) => {
    anchors.add(s.from);
    anchors.add(s.to);
  });
  const stride = Math.max(1, Math.ceil(series.length / MAX_POINTS));
  const data = series
    .filter((p, i) => i % stride === 0 || i === series.length - 1 || anchors.has(p.date))
    .map((p) => ({ t: t(p.date), close: p.close }));

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
          formatter={(value: number) => [`${ccy} ${fmtNum(value)}`, 'Close']}
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
