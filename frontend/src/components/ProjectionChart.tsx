import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import type { ProjectionPoint } from '@decisionguru/shared';
import { fmtCHF, fmtDate } from '../lib/format';

interface Props {
  points: ProjectionPoint[];
  crossoverMonth: number | null;
  height?: number;
}

/** Forward projection: hold (azure dashed hypothetical) vs sell→ETF (gold dashed). */
export function ProjectionChart({ points, crossoverMonth, height = 240 }: Props) {
  if (!points.length) return null;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid stroke="#243040" strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={(d) => fmtDate(d).replace(/^\d+ /, '')}
          tick={{ fill: '#5F6E82', fontSize: 11 }}
          stroke="#243040"
          minTickGap={50}
        />
        <YAxis tickFormatter={(v) => fmtCHF(v)} tick={{ fill: '#5F6E82', fontSize: 11 }} stroke="#243040" width={70} />
        <Tooltip
          contentStyle={{ background: '#1A2331', border: '1px solid #243040', borderRadius: 6, fontSize: 12 }}
          labelStyle={{ color: '#93A1B5' }}
          labelFormatter={(d) => fmtDate(String(d))}
          formatter={(value: number, name: string) => [fmtCHF(value), name === 'hold' ? 'Hold stock' : 'Sell → ETF']}
        />
        {crossoverMonth != null && points[crossoverMonth] && (
          <ReferenceLine
            x={points[crossoverMonth].date}
            stroke="#93A1B5"
            strokeDasharray="3 3"
            label={{ value: 'ETF overtakes', fill: '#93A1B5', fontSize: 10, position: 'top' }}
          />
        )}
        <Line type="monotone" dataKey="hold" stroke="#3DA9FC" strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="etf" stroke="#D9A94E" strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
