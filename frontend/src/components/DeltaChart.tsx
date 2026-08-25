import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { CounterfactualPoint } from '@decisionguru/shared';
import { fmtCHF, fmtDate } from '../lib/format';

interface Props {
  series: CounterfactualPoint[];
  benchmarkName: string;
  height?: number;
}

/**
 * The signature chart: actual holding (azure, solid) vs the ETF counterfactual
 * (gold, dashed), with the gap between them shaded green (you won) or red (ETF won).
 */
export function DeltaChart({ series, benchmarkName, height = 260 }: Props) {
  if (!series.length) {
    return (
      <div className="flex items-center justify-center text-text-faint text-sm" style={{ height }}>
        No history to chart yet.
      </div>
    );
  }
  const last = series[series.length - 1];
  const actualAhead = last.actualCHF >= last.benchmarkCHF;
  const bandColor = actualAhead ? '#31D6A0' : '#FF5D6C';

  const data = series.map((p) => ({
    ...p,
    band: [Math.min(p.actualCHF, p.benchmarkCHF), Math.max(p.actualCHF, p.benchmarkCHF)],
  }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <defs>
          <linearGradient id="deltaBand" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={bandColor} stopOpacity={0.22} />
            <stop offset="100%" stopColor={bandColor} stopOpacity={0.06} />
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
          contentStyle={{
            background: '#1A2331',
            border: '1px solid #243040',
            borderRadius: 6,
            fontSize: 12,
          }}
          labelStyle={{ color: '#93A1B5' }}
          labelFormatter={(d) => fmtDate(String(d))}
          formatter={(value: number, name: string) => {
            const label = name === 'actualCHF' ? 'Actual' : name === 'benchmarkCHF' ? benchmarkName : name;
            return [fmtCHF(value), label];
          }}
        />
        <Area
          dataKey="band"
          stroke="none"
          fill="url(#deltaBand)"
          isAnimationActive={false}
          activeDot={false}
          legendType="none"
          tooltipType="none"
        />
        <Line
          type="monotone"
          dataKey="benchmarkCHF"
          stroke="#D9A94E"
          strokeWidth={2}
          strokeDasharray="4 3"
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="actualCHF"
          stroke="#3DA9FC"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
