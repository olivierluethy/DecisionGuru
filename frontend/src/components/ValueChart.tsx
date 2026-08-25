import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { RangeSeries } from '@decisionguru/shared';
import { fmtCHF, fmtDate } from '../lib/format';

/** Portfolio / per-holding equity curve in CHF. Azure line (you), subtle fill. */
export function ValueChart({ series, height = 260 }: { series: RangeSeries | undefined; height?: number }) {
  const points = series?.points ?? [];
  if (points.length < 2) {
    return (
      <div className="flex items-center justify-center text-text-faint text-sm" style={{ height }}>
        {series ? 'Not enough cached history to chart this range yet.' : 'Loading…'}
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <defs>
          <linearGradient id="valueFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3DA9FC" stopOpacity={0.24} />
            <stop offset="100%" stopColor="#3DA9FC" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#243040" strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={(d) => fmtDate(d).replace(/^\d+ /, '')}
          tick={{ fill: '#5F6E82', fontSize: 11 }}
          stroke="#243040"
          minTickGap={40}
        />
        <YAxis
          tickFormatter={(v) => fmtCHF(v)}
          tick={{ fill: '#5F6E82', fontSize: 11 }}
          stroke="#243040"
          width={70}
        />
        <Tooltip
          contentStyle={{ background: '#1A2331', border: '1px solid #243040', borderRadius: 6, fontSize: 12 }}
          labelStyle={{ color: '#93A1B5' }}
          labelFormatter={(d) => fmtDate(String(d))}
          formatter={(value: number) => [fmtCHF(value, true), 'Portfolio']}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke="#3DA9FC"
          strokeWidth={2}
          fill="url(#valueFill)"
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
