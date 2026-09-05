import { memo, useCallback, useMemo, useState, type RefObject } from 'react';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, Cell, LabelList,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { LineChart as LineIcon, ScatterChart as ScatterIcon, BarChart3 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { MarketCompetitor } from '../lib/api';
import { fmtPct, fmtPctSigned, fmtDate } from '../lib/format';
import { MarketScatter, type MarketScatterPoint } from './MarketScatter';

/**
 * The competitor market analysis, shown three ways behind one tab strip (issue #7):
 *   · Trend    — the rebased performance lines over the window (a line chart)
 *   · Position — the value × strength plane (the dotted / scatter view)
 *   · Returns  — window return per company, ranked (a bar chart / Balkendiagramm)
 *
 * All three read the SAME `active` symbol that the comparables table and the floating
 * mini-map share, so hovering a company anywhere lights it up here too — switching tab
 * never loses the pointer's company. Position is offered only when the market is large
 * enough to place companies on the plane; otherwise its tab is hidden rather than empty.
 */

type ChartTab = 'trend' | 'position' | 'returns';

const GAIN = '#31D6A0';
const LOSS = '#FF5D6C';
const SUBJECT = '#4FD0E0';
const ACTIVE = '#F0C368';

export interface MarketChartsProps {
  /** Rebased multi-line series and the merged {date→values} rows for the Trend view. */
  lines: { key: string; label: string; color: string }[];
  chartData: Record<string, number | string>[];
  /** Plotted companies for the Position (scatter) view. */
  points: MarketScatterPoint[];
  /** Full competitor set + the active window, for the Returns (bar) view. */
  competitors: MarketCompetitor[];
  range: string;
  /** True when the plane can be drawn — gates the Position tab. */
  hasScatter: boolean;
  /** Shared hover: the company pointed at anywhere in the section. */
  active: string | null;
  onActiveChange: (symbol: string | null) => void;
  onOpen: (point: { symbol: string; name: string | null }) => void;
  /** Observed by the parent to hide/show the mini-map once the charts scroll away. */
  containerRef?: RefObject<HTMLDivElement>;
}

export function MarketCharts({
  lines, chartData, points, competitors, range, hasScatter,
  active, onActiveChange, onOpen, containerRef,
}: MarketChartsProps) {
  // Trend is the default: "how has this company performed against its market" is the first
  // question, and a line chart answers it directly. Position leads only when it exists.
  const [tab, setTab] = useState<ChartTab>('trend');

  // Position can vanish between symbols (a thin market). Fall back to Trend rather than
  // leaving the panel parked on a tab that is no longer offered.
  const activeTab: ChartTab = tab === 'position' && !hasScatter ? 'trend' : tab;

  const tabs = useMemo(() => {
    const t: { key: ChartTab; label: string; icon: LucideIcon }[] = [
      { key: 'trend', label: 'Trend', icon: LineIcon },
    ];
    if (hasScatter) t.push({ key: 'position', label: 'Position', icon: ScatterIcon });
    t.push({ key: 'returns', label: 'Returns', icon: BarChart3 });
    return t;
  }, [hasScatter]);

  return (
    <div ref={containerRef}>
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <div className="eyebrow">Market view · {range}</div>
        <div role="tablist" aria-label="Market analysis view" className="flex gap-1">
          {tabs.map((t) => {
            const Icon = t.icon;
            const selected = activeTab === t.key;
            return (
              <button
                key={t.key}
                role="tab"
                type="button"
                aria-selected={selected}
                onClick={() => setTab(t.key)}
                title={`${t.label} view`}
                className={clsx(
                  'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sm text-[12px] cursor-pointer',
                  'border transition-colors duration-150 motion-reduce:transition-none',
                  selected
                    ? 'border-azure/50 text-text bg-surface-2'
                    : 'border-hairline text-text-muted hover:text-text hover:border-hairline-strong',
                )}
              >
                <Icon size={13} aria-hidden />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* One panel per view. Kept simple: only the selected view mounts a recharts tree. */}
      <div role="tabpanel">
        {activeTab === 'trend' && <RebasedChart lines={lines} chartData={chartData} />}
        {activeTab === 'position' && hasScatter && (
          <PositionView points={points} active={active} onActiveChange={onActiveChange} onOpen={onOpen} />
        )}
        {activeTab === 'returns' && (
          <ReturnsBars
            competitors={competitors} range={range}
            active={active} onActiveChange={onActiveChange} onOpen={onOpen}
          />
        )}
      </div>
    </div>
  );
}

/** The rebased multi-line chart. Memoised so pointing at a company — which re-renders the
 *  section on every crossing — never re-renders recharts' most expensive child here. */
const RebasedChart = memo(function RebasedChart({ lines, chartData }: {
  lines: { key: string; label: string; color: string }[];
  chartData: Record<string, number | string>[];
}) {
  if (chartData.length <= 1) {
    return <p className="text-[12px] text-text-faint">Not enough cached price history to chart this window yet — it fills in shortly.</p>;
  }
  return (
    <div style={{ width: '100%', height: 240 }}>
      <ResponsiveContainer>
        <LineChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#243040" strokeDasharray="2 4" strokeOpacity={0.5} vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#5F6E82' }} minTickGap={48}
            tickFormatter={(d) => fmtDate(d).replace(/ \d{4}$/, '')} stroke="#243040" />
          <YAxis tick={{ fontSize: 10, fill: '#5F6E82' }} width={40} stroke="#243040"
            tickFormatter={(v) => `${v}`} />
          <Tooltip contentStyle={{ background: '#1A2331', border: '1px solid #243040', borderRadius: 6, fontSize: 12 }}
            labelFormatter={(d) => fmtDate(d as string)} formatter={(v: number) => [`${Number(v).toFixed(1)}`, '']} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {lines.map((ln) => (
            <Line key={ln.key} type="monotone" dataKey={ln.key} name={ln.label} stroke={ln.color}
              strokeWidth={ln.key === 'subject' ? 2.4 : 1.5} dot={false} isAnimationActive={false} connectNulls />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <p className="text-[11px] text-text-faint mt-1">Rebased to 100 at the start of the window · price return (currency-neutral).</p>
    </div>
  );
});

/** The value × strength plane, framed with the same caption the section used to carry. */
function PositionView({ points, active, onActiveChange, onOpen }: {
  points: MarketScatterPoint[];
  active: string | null;
  onActiveChange: (symbol: string | null) => void;
  onOpen: (p: MarketScatterPoint) => void;
}) {
  return (
    <div>
      <div style={{ width: '100%', height: 240 }}>
        <MarketScatter points={points} active={active} onActiveChange={onActiveChange} onOpen={onOpen} variant="full" />
      </div>
      <p className="text-[11px] text-text-faint mt-1">
        Each dot is a company in this market; azure is this one. Top-right is cheap and strong,
        top-left cheap but lagging. Hover a row in the comparables table to find that company
        here — and hover a dot to find its row. Click a dot to open it.
      </p>
    </div>
  );
}

interface ReturnRow {
  symbol: string;
  name: string | null;
  isSubject: boolean;
  /** Window return as a percent (e.g. 67.2), already scaled from the fraction. */
  pct: number;
}

/** Window return per company as a ranked horizontal bar chart (Balkendiagramm). Companies
 *  without a return for this window yet are simply omitted — a missing bar reads cleaner
 *  than a zero-height one, and the table already marks what is still loading. */
function ReturnsBars({ competitors, range, active, onActiveChange, onOpen }: {
  competitors: MarketCompetitor[];
  range: string;
  active: string | null;
  onActiveChange: (symbol: string | null) => void;
  onOpen: (p: { symbol: string; name: string | null }) => void;
}) {
  const rows = useMemo<ReturnRow[]>(() => competitors
    .filter((c) => c.returns[range] != null)
    .map((c) => ({ symbol: c.symbol, name: c.name, isSubject: c.isSubject, pct: (c.returns[range] as number) * 100 }))
    .sort((a, b) => b.pct - a.pct), [competitors, range]);

  const onEnter = useCallback((_: unknown, index: number) => {
    onActiveChange(rows[index]?.symbol ?? null);
  }, [rows, onActiveChange]);
  const onClick = useCallback((_: unknown, index: number) => {
    const r = rows[index];
    if (r) onOpen({ symbol: r.symbol, name: r.name });
  }, [rows, onOpen]);

  if (rows.length === 0) {
    return <p className="text-[12px] text-text-faint">No {range} returns cached for this market yet — the bars fill in as peer history lands.</p>;
  }

  // One row per company; give each a legible band and let the panel scroll when a market
  // runs long rather than crushing dozens of bars into a fixed height.
  const height = Math.min(Math.max(rows.length * 30 + 24, 120), 460);

  return (
    <div>
      <div className="overflow-y-auto" style={{ maxHeight: 460 }}>
        <div style={{ width: '100%', height }} onMouseLeave={() => onActiveChange(null)}>
          <ResponsiveContainer>
            <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 44, bottom: 4, left: 8 }} barCategoryGap="22%">
              <CartesianGrid stroke="#243040" strokeDasharray="2 4" strokeOpacity={0.5} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: '#5F6E82' }} stroke="#243040"
                tickFormatter={(v) => `${v}%`} />
              <YAxis type="category" dataKey="symbol" width={68} stroke="#243040"
                tick={{ fontSize: 10, fill: '#8A97A8', fontFamily: '"JetBrains Mono", ui-monospace, monospace' }} />
              <Tooltip
                cursor={{ fill: '#243040', fillOpacity: 0.35 }}
                content={({ payload }) => {
                  const r = payload?.[0]?.payload as ReturnRow | undefined;
                  if (!r) return null;
                  return (
                    <div className="bg-surface-2 border border-hairline rounded px-2.5 py-1.5 text-[11px]">
                      <div className="font-mono text-text">{r.symbol}{r.isSubject ? ' · this' : ''}</div>
                      {r.name && <div className="text-text-faint truncate max-w-[180px]">{r.name}</div>}
                      <div className={`mt-1 tnum ${r.pct < 0 ? 'text-loss' : 'text-gain'}`}>{range} return {fmtPctSigned(r.pct / 100)}</div>
                    </div>
                  );
                }}
              />
              <Bar dataKey="pct" isAnimationActive={false} onMouseEnter={onEnter} onClick={onClick}
                className="cursor-pointer" radius={[0, 2, 2, 0]}>
                <LabelList dataKey="pct" position="right" formatter={(v: number) => fmtPct(v / 100, 1)}
                  style={{ fontSize: 10, fill: '#8A97A8' }} />
                {rows.map((r) => {
                  const isActive = r.symbol === active;
                  const base = r.pct < 0 ? LOSS : GAIN;
                  const fill = isActive ? ACTIVE : r.isSubject ? SUBJECT : base;
                  return (
                    <Cell key={r.symbol} fill={fill}
                      fillOpacity={active && !isActive ? (r.isSubject ? 0.7 : 0.5) : 0.92}
                      stroke={r.isSubject ? SUBJECT : 'none'} strokeWidth={r.isSubject ? 1 : 0} />
                  );
                })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <p className="text-[11px] text-text-faint mt-1">
        {range} price return per company, best first · azure is this one. Hover a bar to light up
        its row below; click to open it.
      </p>
    </div>
  );
}
