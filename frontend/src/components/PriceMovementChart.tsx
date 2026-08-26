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

interface Props {
  series: Array<{ date: string; close: number }>;
  movements?: MovementsResponse;
  currency?: string | null;
  height?: number;
  /**
   * Optional ETF overlay. Its price curve is rebased to the stock's first close, so both
   * lines start from the same level and you see the ETF's shape (its % path) against the
   * stock's — currency- and price-scale-independent.
   */
  benchmark?: { symbol: string; series: Array<{ date: string; close: number }> };
}

const MAX_POINTS = 520;

/**
 * Full-history price with explainable annotations: stagnation stretches shaded (warn),
 * major up-legs marked gain and down-legs marked loss. Time axis is numeric so uneven
 * sampling and marker placement stay truthful.
 */
export function PriceMovementChart({ series, movements, currency, height = 300, benchmark }: Props) {
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
    .map((p) => ({ t: t(p.date), close: p.close, bench: null as number | null }));

  // ETF overlay rebased to the stock's first close (same starting level → comparable shape).
  const benchSorted =
    benchmark && benchmark.series.length >= 2
      ? benchmark.series.map((p) => ({ t: t(p.date), c: p.close })).sort((a, b) => a.t - b.t)
      : null;
  if (benchSorted && data.length) {
    const closeAtOrBefore = (ts: number): number => {
      let lo = 0, hi = benchSorted.length - 1, res = benchSorted[0].c;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (benchSorted[mid].t <= ts) { res = benchSorted[mid].c; lo = mid + 1; } else hi = mid - 1;
      }
      return res;
    };
    // Anchor at the first date BOTH series cover (the ETF may be younger than the stock,
    // e.g. VWRL from 2016 vs Nestlé from 1990) — before that, draw no ETF line.
    const etfFirstT = benchSorted[0].t;
    const anchor = data.find((d) => d.t >= etfFirstT);
    if (anchor) {
      const etfAtAnchor = closeAtOrBefore(anchor.t);
      const scale = etfAtAnchor > 0 ? anchor.close / etfAtAnchor : 0;
      if (scale > 0) {
        data.forEach((d) => { d.bench = d.t >= etfFirstT ? closeAtOrBefore(d.t) * scale : null; });
      }
    }
  }
  const showBench = !!benchSorted && data.some((d) => d.bench != null);

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
          formatter={(value: number, name: string) => [
            `${ccy} ${fmtNum(value)}`,
            name === 'bench' ? `${benchmark?.symbol} (rebased)` : 'Close',
          ]}
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
        {/* ETF counterfactual — its price path rebased to the stock's start (gold, dashed). */}
        {showBench && (
          <Line
            type="monotone"
            dataKey="bench"
            stroke="#D9A94E"
            strokeWidth={2}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
        )}
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
