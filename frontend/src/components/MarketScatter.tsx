import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, ZAxis, ReferenceLine, Tooltip,
} from 'recharts';
import type { MarketCompetitor } from '../lib/api';

/**
 * The value x strength plane, drawn once and reused twice: full size inside the market
 * position card, and shrunk into the floating mini-map that follows the comparables table
 * down the page. Both read the same point array and the same `active` symbol, so the
 * mini-map cannot drift away from the chart it mirrors.
 *
 * `active` is the company the user is currently pointing at — from a dot here, from a row
 * in the table, or from a dot in the other copy of this chart. It is always a symbol, the
 * same identifier the table keys its rows on; nothing about a company's position is stored
 * or mapped anywhere else.
 */

export interface MarketScatterPoint {
  /** Market strength percentile (0-100). */ x: number;
  /** Value percentile (0-100). */ y: number;
  symbol: string;
  name: string | null;
  isSubject: boolean;
  rank: number | null;
}

/** The one derivation of "who can be placed on this plane". A company needs both
 *  percentiles to have a position; the rest are simply not plotted (the table marks
 *  them so the absence is visible rather than mysterious). */
export function marketScatterPoints(competitors: MarketCompetitor[]): MarketScatterPoint[] {
  return competitors
    .filter((c) => c.valuePct != null && c.strengthPct != null)
    .map((c) => ({
      x: c.strengthPct as number,
      y: c.valuePct as number,
      symbol: c.symbol,
      name: c.name,
      isSubject: c.isSubject,
      rank: c.rank ?? null,
    }));
}

const SUBJECT_FILL = '#4FD0E0';
const PEER_FILL = '#5F6E82';
const ACTIVE_FILL = '#F0C368';
const ACTIVE_RING = '#D9A94E';

const VARIANTS = {
  full: {
    dotR: 4.2, labelSize: 10, halo: '#141B27',
    margin: { top: 8, right: 12, bottom: 16, left: 4 },
    axisTicks: true,
  },
  mini: {
    dotR: 3, labelSize: 9, halo: '#1A2331',
    margin: { top: 6, right: 10, bottom: 6, left: 6 },
    axisTicks: false,
  },
} as const;

/** True on devices that can actually hover. Drives dot taps: a mouse click opens the
 *  company, a touch tap pins the highlight instead (there is no hover to pin it). */
export function usePointerCanHover(): boolean {
  const [canHover, setCanHover] = useState(
    () => window.matchMedia?.('(hover: hover)').matches ?? true,
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(hover: hover)');
    if (!mq) return;
    const onChange = () => setCanHover(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return canHover;
}

/** Recharts hands event/shape callbacks the datum spread onto the point item; read the
 *  symbol from either shape so a recharts internals change can't silently break sync. */
function symbolOf(p: unknown): string | null {
  const o = p as { symbol?: string; payload?: { symbol?: string } } | null | undefined;
  return o?.symbol ?? o?.payload?.symbol ?? null;
}

export function MarketScatter({
  points, active, onActiveChange, onOpen, variant = 'full',
}: {
  points: MarketScatterPoint[];
  active: string | null;
  onActiveChange: (symbol: string | null) => void;
  onOpen?: (point: MarketScatterPoint) => void;
  variant?: keyof typeof VARIANTS;
}) {
  const v = VARIANTS[variant];
  const canHover = usePointerCanHover();

  // Dense markets overlap. Drawing the active company last puts it on top of whatever it
  // shares a coordinate with, so the highlight is never buried under a neighbour.
  const ordered = useMemo(() => {
    if (!active || !points.some((p) => p.symbol === active)) return points;
    return [...points.filter((p) => p.symbol !== active), ...points.filter((p) => p.symbol === active)];
  }, [points, active]);

  const renderPoint = useCallback((props: Record<string, unknown>) => {
    const cx = props.cx as number | undefined;
    const cy = props.cy as number | undefined;
    const p = (props.payload ?? props) as MarketScatterPoint;
    if (cx == null || cy == null || !p?.symbol) return <g />;

    const isActive = p.symbol === active;
    const dimmed = active != null && !isActive;
    const fill = isActive ? ACTIVE_FILL : p.isSubject ? SUBJECT_FILL : PEER_FILL;
    // Peers recede while something is highlighted, the subject less so — losing track of
    // "this company" while inspecting a rival would defeat the point of the chart.
    const opacity = !dimmed ? 0.95 : p.isSubject ? 0.5 : 0.28;
    // Flip the label to the inside of the plot near the right edge so it never clips.
    const labelLeft = p.x > 68;

    return (
      <g>
        {isActive && (
          <circle
            cx={cx} cy={cy} r={v.dotR * 2.7}
            fill="none" stroke={ACTIVE_RING} strokeWidth={1.2} strokeOpacity={0.55}
          />
        )}
        <circle
          cx={cx} cy={cy} r={isActive ? v.dotR * 1.55 : v.dotR}
          fill={fill} fillOpacity={opacity}
          stroke={isActive ? v.halo : 'none'} strokeWidth={isActive ? 1.2 : 0}
        />
        {isActive && (
          <text
            x={cx + (labelLeft ? -(v.dotR * 3.4) : v.dotR * 3.4)} y={cy}
            dy="0.32em" textAnchor={labelLeft ? 'end' : 'start'}
            fontSize={v.labelSize} fontWeight={600} fill={ACTIVE_FILL}
            stroke={v.halo} strokeWidth={3} paintOrder="stroke"
            // The label must never steal the pointer from a dot sitting behind it.
            style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace', pointerEvents: 'none' }}
          >
            {p.symbol}
          </text>
        )}
      </g>
    );
  }, [active, v.dotR, v.labelSize, v.halo]);

  const handleDotClick = useCallback((p: unknown, _i: number, e?: { stopPropagation?: () => void }) => {
    e?.stopPropagation?.();
    const sym = symbolOf(p);
    if (!sym) return;
    if (canHover) {
      const point = points.find((q) => q.symbol === sym);
      if (point) onOpen?.(point);
    } else {
      // No hover to drive the highlight — the tap itself pins and un-pins it.
      onActiveChange(active === sym ? null : sym);
    }
  }, [canHover, points, onOpen, onActiveChange, active]);

  return (
    <div
      className="w-full h-full"
      onMouseLeave={() => canHover && onActiveChange(null)}
      // Tapping empty plot area clears a pinned highlight on touch.
      onClick={() => !canHover && onActiveChange(null)}
    >
      <ResponsiveContainer>
        <ScatterChart margin={v.margin}>
          <XAxis
            type="number" dataKey="x" domain={[0, 100]}
            ticks={v.axisTicks ? [0, 25, 50, 75, 100] : undefined}
            tick={v.axisTicks ? { fontSize: 10, fill: '#5F6E82' } : false}
            stroke="#243040" height={v.axisTicks ? 30 : 1}
            label={v.axisTicks
              ? { value: 'Market strength →', position: 'insideBottom', offset: -8, fontSize: 10, fill: '#5F6E82' }
              : undefined}
          />
          <YAxis
            type="number" dataKey="y" domain={[0, 100]}
            ticks={v.axisTicks ? [0, 25, 50, 75, 100] : undefined}
            tick={v.axisTicks ? { fontSize: 10, fill: '#5F6E82' } : false}
            stroke="#243040" width={v.axisTicks ? 34 : 1}
            label={v.axisTicks
              ? { value: 'Value →', angle: -90, position: 'insideLeft', offset: 12, fontSize: 10, fill: '#5F6E82' }
              : undefined}
          />
          <ZAxis range={[70, 70]} />
          <ReferenceLine x={50} stroke="#243040" strokeDasharray="3 3" />
          <ReferenceLine y={50} stroke="#243040" strokeDasharray="3 3" />
          {variant === 'full' && (
            <Tooltip
              cursor={{ stroke: '#243040' }}
              content={({ payload }) => {
                const p = payload?.[0]?.payload as MarketScatterPoint | undefined;
                if (!p) return null;
                return (
                  <div className="bg-surface-2 border border-hairline rounded px-2.5 py-1.5 text-[11px]">
                    <div className="font-mono text-text">{p.symbol}{p.isSubject ? ' · this' : ''}</div>
                    {p.name && <div className="text-text-faint truncate max-w-[180px]">{p.name}</div>}
                    <div className="text-text-muted mt-1">
                      Value {p.y.toFixed(0)} · Strength {p.x.toFixed(0)}
                      {p.rank != null && <> · #{p.rank}</>}
                    </div>
                  </div>
                );
              }}
            />
          )}
          <Scatter
            data={ordered}
            isAnimationActive={false}
            shape={renderPoint as never}
            onMouseEnter={(p: unknown) => canHover && onActiveChange(symbolOf(p))}
            onClick={handleDotClick as never}
            className={canHover ? 'cursor-pointer' : undefined}
          />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
