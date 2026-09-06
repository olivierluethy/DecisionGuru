import { useId, useState, useMemo, useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ComposedChart, Line, Area, ReferenceArea, ReferenceLine, ReferenceDot, CartesianGrid,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Brush,
} from 'recharts';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { api, type ValuationBand, type ValuationBandKey } from '../lib/api';
import { mergePriceWithSnapshots } from '../lib/valuationHistory';
import { fmtMoney, fmtDate, fmtPct } from '../lib/format';

/** Recharts stroke/fill props are SVG *presentation attributes*, where `var(--token)` does
 *  not resolve — and these tokens are Tailwind theme values, not CSS custom properties, so
 *  no such CSS var exists anyway. Passing `var(--…)` renders black on --bg (invisible), which
 *  is what left this chart blank. Mirror the tailwind.config hex here and pass literals. */
const C = {
  gain: '#31D6A0',
  loss: '#FF5D6C',
  warn: '#F0B34A',
  azure: '#3DA9FC',
  textFaint: '#5F6E82',
  hairline: '#243040',
  surface2: '#1A2331',
  bg: '#0A0E15',
} as const;

/** Flat per-zone fill + boundary-line styling. Uniform across the plot (no horizontal fade)
 *  so the zones fill the *whole* visible window at every timeframe — a fade tuned for the full
 *  10-year view left zoomed-in windows almost entirely unshaded. Reuses the reserved
 *  gain/loss/warn tokens: cheap = gain, expensive = loss, gold marks the overvalued step. */
const ZONE_STYLE = {
  buy: { color: C.gain, fill: 0.14, line: 0.5 },
  fair: { color: C.azure, fill: 0.07, line: 0.5 },
  over: { color: C.warn, fill: 0.13, line: 0.55 },
  sell: { color: C.loss, fill: 0.16, line: 0.6 },
} as const;

/** Band → semantic colour + copy. Reuses the reserved gain/loss/warn tokens: a cheap
 *  price is a gain, an expensive one a loss, with gold marking the overvalued step. */
export const BAND_META: Record<ValuationBandKey, { label: string; text: string; border: string; dot: string }> = {
  'undervalued': { label: 'Undervalued', text: 'text-gain', border: 'border-l-gain', dot: 'bg-gain' },
  'fair': { label: 'Fairly valued', text: 'text-text-muted', border: 'border-l-hairline-strong', dot: 'bg-text-faint' },
  'overvalued': { label: 'Overvalued', text: 'text-warn', border: 'border-l-warn', dot: 'bg-warn' },
  'significantly-overvalued': { label: 'Significantly overvalued', text: 'text-loss', border: 'border-l-loss', dot: 'bg-loss' },
};

export function BandBadge({ band, className }: { band: ValuationBandKey; className?: string }) {
  const m = BAND_META[band];
  return (
    <span className={clsx('chip !py-0 !px-2 inline-flex items-center gap-1.5', m.text, className)}>
      <span className={clsx('w-1.5 h-1.5 rounded-full', m.dot)} />
      {m.label}
    </span>
  );
}

type ChartType = 'line' | 'area' | 'dots';
type Scale = 'linear' | 'log';

/** Trailing-window presets. `months: null` = full history (Max). The Brush covers every
 *  window in between (4y, 2 months, a handful of days) that has no dedicated button. */
const RANGE_PRESETS: { key: string; label: string; months: number | null }[] = [
  { key: 'max', label: 'Max', months: null },
  { key: '5y', label: '5J', months: 60 },
  { key: '3y', label: '3J', months: 36 },
  { key: '1y', label: '1J', months: 12 },
  { key: '6m', label: '6M', months: 6 },
  { key: '3m', label: '3M', months: 3 },
  { key: '1m', label: '1M', months: 1 },
];

const CHART_TYPES: { key: ChartType; label: string }[] = [
  { key: 'line', label: 'Linie' },
  { key: 'area', label: 'Fläche' },
  { key: 'dots', label: 'Punkte' },
];

/** A single segmented-control button, matching the market-view tabs elsewhere. */
function SegBtn({
  active, onClick, children, title,
}: { active: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={clsx(
        'inline-flex items-center h-7 px-2.5 rounded-sm text-[12px] cursor-pointer',
        'border transition-colors duration-150 motion-reduce:transition-none',
        active
          ? 'border-azure/50 text-text bg-surface-2'
          : 'border-hairline text-text-muted hover:text-text hover:border-hairline-strong',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Price history with shaded valuation zones — the buy zone (≤ attractive entry price),
 * the fair range, the overvalued step and the sell zone (≥ fair value ×1.40) — plus the
 * current-price line and dashed entry-target / fair-value / sell-zone guides. Grounds the
 * abstract "band" in the security's actual price path. Native price units.
 *
 * A toolbar lets you narrow the window (trailing presets + a drag Brush for arbitrary
 * ranges), switch the mark (line / area / dots), pick a linear or log axis, and rebase to
 * % return from the first visible day. The Y-axis autoscales to the visible slice so tight
 * windows show real detail. Rebase hides the absolute-price zones (they no longer map).
 */
export function PriceBandChart({
  symbol, band, currency, height = 220, rate = null, displayCurrency = null,
}: {
  symbol: string;
  band: ValuationBand;
  currency?: string | null;
  height?: number;
  rate?: number | null;
  displayCurrency?: string | null;
}) {
  const { data: history, isLoading } = useQuery({
    queryKey: ['marketHistory', symbol],
    queryFn: () => api.marketHistory(symbol),
    staleTime: 60 * 60_000,
    retry: 1,
  });

  // Reconstructed valuation history — the stepped snapshot series this chart's zones are
  // built from. Fewer than two snapshots means there isn't enough fundamental history to
  // reconstruct a path, so the honest answer is "unavailable" rather than a flat guess.
  const { data: valHistory } = useQuery({
    queryKey: ['valuationHistory', symbol],
    queryFn: () => api.valuationHistory(symbol),
    staleTime: 60 * 60_000,
    retry: 1,
  });
  const snapshots = valHistory?.snapshots ?? [];
  const hasHistory = snapshots.length >= 2;

  // Unique, colon-free prefix so this instance's gradient ids never clash with another chart's.
  const uid = useId().replace(/:/g, '');
  const todayISO = new Date().toISOString().slice(0, 10);

  // Convert every monetary figure by the same scalar FX rate so the chart matches the
  // CHF headline; a scalar multiply preserves the zone shape and all relationships. When
  // no rate is supplied the chart stays in the native currency (unchanged behavior).
  const k = rate != null ? rate : 1;
  const ccy = ((rate != null && displayCurrency) ? displayCurrency : currency) || '';
  const entryTarget = band.entryTarget * k;
  const overvaluedAt = band.overvaluedAt * k;
  const sellZoneAt = band.sellZoneAt * k;
  const fairValue = band.fairValue * k;

  // Full converted price path (positive closes only). The backend already serves up to 10y,
  // so every preset and the Brush slice this in place — no refetch when the window changes.
  const full = useMemo(
    () => (history ?? []).map((h) => ({ date: h.date, close: h.close * k })).filter((d) => d.close > 0),
    [history, k],
  );

  // Per-date reconstructed valuation, aligned to every price point — the stepped source
  // the zone bands and FV spine below are drawn from (see lib/valuationHistory.ts).
  const merged = useMemo(
    () => mergePriceWithSnapshots(full, snapshots, k),
    [full, snapshots, k],
  );
  const coverageFrom = valHistory?.coverageFrom ?? null;

  // --- View controls ------------------------------------------------------------------
  const [chartType, setChartType] = useState<ChartType>('line');
  const [scale, setScale] = useState<Scale>('linear');
  const [rebase, setRebase] = useState(false);
  const [preset, setPreset] = useState<string>('max');
  // Visible window as [start, end] indices into `full`. The Brush drives these directly;
  // presets compute them from a trailing cutoff.
  const [range, setRange] = useState<{ start: number; end: number }>({ start: 0, end: 0 });

  // Whenever the underlying series changes size (data lands, symbol switches), reset to Max.
  useEffect(() => {
    setRange({ start: 0, end: Math.max(0, full.length - 1) });
    setPreset('max');
  }, [full.length]);

  const applyPreset = (key: string, months: number | null) => {
    setPreset(key);
    if (months == null || full.length === 0) {
      setRange({ start: 0, end: Math.max(0, full.length - 1) });
      return;
    }
    const cutoff = dayjs().subtract(months, 'month');
    let start = full.findIndex((d) => !dayjs(d.date).isBefore(cutoff));
    if (start < 0) start = 0;
    // Always keep at least two points so the line has something to draw.
    if (start > full.length - 2) start = Math.max(0, full.length - 2);
    setRange({ start, end: full.length - 1 });
  };

  // Rebase turns absolute prices into % return from the first *visible* day; log makes no
  // sense on a signed % series, so it falls back to linear there.
  const effScale: Scale = rebase ? 'linear' : scale;
  const base = full.length ? full[Math.min(range.start, full.length - 1)].close : 0;
  const plot = useMemo(
    () => full.map((d, i) => {
      const m = merged[i];
      return {
        date: d.date,
        value: rebase && base ? (d.close / base - 1) * 100 : d.close,
        fairValue: m?.fairValue ?? null,
        entryTarget: m?.entryTarget ?? null,
        overvaluedAt: m?.overvaluedAt ?? null,
        sellZoneAt: m?.sellZoneAt ?? null,
        // Stacked-area *thicknesses* (the gap between adjacent thresholds), not absolute
        // edges — Recharts stacks by summing dataKeys, so each layer must carry only the
        // slice it contributes, cumulative bottom-up: buy -> fair -> over -> sell.
        buyBand: m?.entryTarget ?? null,
        fairBand: m && m.entryTarget != null && m.overvaluedAt != null
          ? m.overvaluedAt - m.entryTarget : null,
        overBand: m && m.overvaluedAt != null && m.sellZoneAt != null
          ? m.sellZoneAt - m.overvaluedAt : null,
        // Sell zone has no natural upper edge — extend it well above the sell threshold so
        // the fill reaches the top of whatever Y-domain the price data settles on; Recharts
        // clips the stacked area to the plotting rect, so overshoot is harmless.
        sellBand: m?.sellZoneAt != null ? m.sellZoneAt * 0.6 : null,
      };
    }),
    [full, rebase, base, merged],
  );

  // Y-domain autoscales to the *visible* slice (the user's choice), so tight windows show
  // real detail. In price mode it is then stretched to bracket the visible price against the
  // *reconstructed* zone thresholds for that same window — the nearest edge below and above
  // the price's min/max — so the current zone stays fully marked with its neighbours as
  // context. Because the thresholds step over time, the bracket pool is every distinct edge
  // value the merged series took across the visible window (not one constant per boundary),
  // via the min/max each threshold field reached there. With no reconstructed history the
  // pool is empty and the domain simply tracks the price — never the flat `band` snapshot.
  const [lo, hi] = useMemo<[number, number]>(() => {
    const s = Math.min(range.start, plot.length - 1);
    const e = Math.min(range.end, plot.length - 1);
    const vals = plot.slice(s, e + 1).map((d) => d.value).filter((v) => Number.isFinite(v));
    if (!vals.length) return [0, 1];
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    if (rebase) {
      const pad = Math.max((mx - mn) * 0.08, 1);
      return [mn - pad, mx + pad];
    }
    let thresholds: number[] = [];
    if (hasHistory) {
      const ms = Math.min(range.start, merged.length - 1);
      const me = Math.min(range.end, merged.length - 1);
      const visible = merged.slice(ms, me + 1);
      const edgesOf = (key: 'entryTarget' | 'overvaluedAt' | 'sellZoneAt') => visible
        .map((m) => m[key])
        .filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
      thresholds = (['entryTarget', 'overvaluedAt', 'sellZoneAt'] as const)
        .flatMap((key) => {
          const es = edgesOf(key);
          return es.length ? [Math.min(...es), Math.max(...es)] : [];
        })
        .sort((a, b) => a - b);
    }
    const below = thresholds.filter((t) => t <= mn).pop(); // nearest edge ≤ visible min
    const above = thresholds.find((t) => t >= mx);         // nearest edge ≥ visible max
    const dLo = below != null ? Math.min(mn, below) : mn;
    const dHi = above != null ? Math.max(mx, above) : mx;
    return [dLo * 0.98, dHi * 1.02];
  }, [plot, range, rebase, hasHistory, merged]);

  // No price path to draw yet — show a labelled placeholder instead of an empty chart.
  // (The backfill runs in the background; the line lands on a later poll.)
  if (full.length < 2) {
    return (
      <div>
        <div
          className="flex items-center justify-center text-[12px] text-text-faint border border-dashed border-hairline rounded"
          style={{ height }}
        >
          {isLoading ? 'Loading price history…' : 'Price history not cached yet — the zones will fill in shortly.'}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-text-faint">
          <LegendDot cls="bg-gain" label={`Buy ≤ ${fmtMoney(entryTarget, ccy)}`} />
          <LegendDot cls="bg-azure/40" label="Fair range" />
          <LegendDot cls="bg-warn" label={`Overvalued ≥ ${fmtMoney(overvaluedAt, ccy)}`} />
          <LegendDot cls="bg-loss" label={`Sell zone ≥ ${fmtMoney(sellZoneAt, ccy)}`} />
          <span className="ml-auto">
            fair value {fmtMoney(fairValue, ccy)} · MoS {fmtPct(band.marginOfSafetyPct, 0)}
          </span>
        </div>
        <p className="mt-1.5 text-[10px] leading-snug text-text-faint/90 italic">
          Zones reflect today's fair value ({fmtDate(todayISO)}).
        </p>
      </div>
    );
  }

  const lastIdx = full.length - 1;
  const windowHasLatest = range.end >= lastIdx;
  const lastDate = full[lastIdx].date;
  const lastValue = plot[lastIdx].value;
  // Pre-coverage span — before the earliest reconstructed snapshot, only greyed out (never
  // the flat `band` zones): there simply isn't enough fundamental history to reconstruct a
  // path there.
  const showPreCoverage = hasHistory && !!coverageFrom && full[0].date < coverageFrom;

  return (
    <div>
      {/* Toolbar — window presets, mark type, and scale / rebase toggles. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-2.5">
        <div className="flex gap-1" role="group" aria-label="Zeitraum">
          {RANGE_PRESETS.map((p) => (
            <SegBtn key={p.key} active={preset === p.key} onClick={() => applyPreset(p.key, p.months)}
              title={`Zeitraum ${p.label}`}>
              {p.label}
            </SegBtn>
          ))}
        </div>
        <div className="flex gap-1 ml-auto" role="group" aria-label="Darstellung">
          {CHART_TYPES.map((t) => (
            <SegBtn key={t.key} active={chartType === t.key} onClick={() => setChartType(t.key)}>
              {t.label}
            </SegBtn>
          ))}
        </div>
        <div className="flex gap-1" role="group" aria-label="Skala">
          <SegBtn active={effScale === 'linear' && !rebase} onClick={() => { setRebase(false); setScale('linear'); }}
            title="Lineare Achse">Linear</SegBtn>
          <SegBtn active={effScale === 'log' && !rebase} onClick={() => { setRebase(false); setScale('log'); }}
            title="Logarithmische Achse">Log</SegBtn>
          <SegBtn active={rebase} onClick={() => setRebase((v) => !v)}
            title="Auf 0 % zum Startdatum normieren">% Rebase</SegBtn>
        </div>
      </div>

      <div style={{ width: '100%', height: height + 34 }}>
        <ResponsiveContainer>
          <ComposedChart data={plot} margin={{ top: 6, right: 46, bottom: 0, left: 0 }}>
            {/* Zone/line fade gradients: transparent in the past (left), full at today (right). */}
            <defs>
              {/* Top-down fill for the area mark. */}
              <linearGradient id={`${uid}-area`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.azure} stopOpacity={0.35} />
                <stop offset="100%" stopColor={C.azure} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            {/* Subtle horizontal grid, kept behind the bands so it never competes. */}
            <CartesianGrid stroke={C.hairline} strokeDasharray="2 4" strokeOpacity={0.5} vertical={false} />
            {/* Pre-coverage span — greyed, no zone fills — before the earliest reconstructed
                snapshot. Rendered only alongside real history, never as a `band` fallback. */}
            {!rebase && showPreCoverage && (
              <ReferenceArea x1={full[0].date} x2={coverageFrom!} y1={lo} y2={hi}
                fill={C.hairline} fillOpacity={0.4} ifOverflow="hidden" stroke="none"
                label={{ value: 'insufficient fundamental history', position: 'insideTopLeft',
                  fill: C.textFaint, fontSize: 9 }} />
            )}
            {/* Stepped zone bands, reconstructed per-date from the fundamentals then in force —
                stacked bottom-up (buy → fair → over → sell) so each layer is drawn as the
                *thickness* between adjacent thresholds, not an absolute edge. Stepped (never
                interpolated) because a real report lands on one day, not gradually. Hidden in
                rebase mode, where absolute-price levels no longer map onto a % series, and
                whenever there isn't enough fundamental history to reconstruct a path. */}
            {!rebase && hasHistory && (
              <>
                <Area type="stepAfter" dataKey="buyBand" stackId="zones" stroke="none"
                  fill={ZONE_STYLE.buy.color} fillOpacity={ZONE_STYLE.buy.fill} isAnimationActive={false} />
                <Area type="stepAfter" dataKey="fairBand" stackId="zones" stroke="none"
                  fill={ZONE_STYLE.fair.color} fillOpacity={ZONE_STYLE.fair.fill} isAnimationActive={false} />
                <Area type="stepAfter" dataKey="overBand" stackId="zones" stroke="none"
                  fill={ZONE_STYLE.over.color} fillOpacity={ZONE_STYLE.over.fill} isAnimationActive={false} />
                <Area type="stepAfter" dataKey="sellBand" stackId="zones" stroke="none"
                  fill={ZONE_STYLE.sell.color} fillOpacity={ZONE_STYLE.sell.fill} isAnimationActive={false} />
                {/* Stepped Fair Value spine — the reconstructed FV as it stood at each date. */}
                <Line type="stepAfter" dataKey="fairValue" stroke={C.textFaint} strokeWidth={1.6}
                  strokeDasharray="2 3" dot={false} isAnimationActive={false} />
              </>
            )}
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: C.textFaint }}
              tickFormatter={(d) => fmtDate(d).replace(/ \d{4}$/, '')} minTickGap={48}
              stroke={C.hairline} />
            <YAxis domain={[lo, hi]} allowDataOverflow scale={effScale}
              tick={{ fontSize: 10, fill: C.textFaint }} width={rebase ? 46 : 52} stroke={C.hairline}
              tickFormatter={(v) => (rebase ? `${v > 0 ? '+' : ''}${Math.round(v)}%` : fmtMoney(v, ccy, false))} />
            <Tooltip
              contentStyle={{ background: C.surface2, border: `1px solid ${C.hairline}`,
                borderRadius: 6, fontSize: 12 }}
              labelStyle={{ color: C.textFaint }}
              formatter={(v: number) => (rebase
                ? [`${v >= 0 ? '+' : ''}${v.toFixed(1)}%`, 'Rendite']
                : [fmtMoney(v, ccy), 'Price'])}
              labelFormatter={(d) => fmtDate(d as string)} />
            {/* Zero baseline in rebase mode — the reference every % return is measured from. */}
            {rebase && <ReferenceLine y={0} stroke={C.textFaint} strokeOpacity={0.6} strokeDasharray="2 3" />}
            {chartType === 'area' && (
              <Area type="monotone" dataKey="value" stroke={C.azure} strokeWidth={2}
                fill={`url(#${uid}-area)`} dot={false} isAnimationActive={false} />
            )}
            {chartType === 'line' && (
              <Line type="monotone" dataKey="value" stroke={C.azure} strokeWidth={2.2} dot={false}
                isAnimationActive={false} />
            )}
            {chartType === 'dots' && (
              <Line type="monotone" dataKey="value" stroke="none"
                dot={{ r: 1.6, fill: C.azure, stroke: 'none' }} isAnimationActive={false} />
            )}
            {/* "Today" divider + latest marker — only when the window still includes the last day. */}
            {windowHasLatest && (
              <ReferenceLine x={lastDate} stroke={C.textFaint} strokeOpacity={0.55} strokeDasharray="3 3"
                label={{ value: 'today', position: 'top', fill: C.textFaint, fontSize: 9 }} />
            )}
            {windowHasLatest && (
              <ReferenceDot x={lastDate} y={lastValue} r={3.5} fill={C.azure}
                stroke={C.bg} strokeWidth={1.5} ifOverflow="extendDomain" />
            )}
            {/* Drag to narrow to any window — covers the odd spans (4y, 2 months, a few days). */}
            <Brush dataKey="date" height={22} travellerWidth={8} gap={4}
              stroke={C.hairline} fill={C.surface2} startIndex={range.start} endIndex={range.end}
              tickFormatter={(d) => fmtDate(String(d)).replace(/ \d{4}$/, '')}
              onChange={(r) => {
                if (r && typeof r.startIndex === 'number' && typeof r.endIndex === 'number'
                    && r.endIndex > r.startIndex) {
                  setRange({ start: r.startIndex, end: r.endIndex });
                  setPreset('custom');
                }
              }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {rebase ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-text-faint">
          <span>% return since {fmtDate(full[Math.min(range.start, lastIdx)].date)} · fair-value zones hidden in rebase</span>
          <span className="ml-auto">fair value {fmtMoney(fairValue, ccy)} · MoS {fmtPct(band.marginOfSafetyPct, 0)}</span>
        </div>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-text-faint">
          <LegendDot cls="bg-gain" label={`Buy ≤ ${fmtMoney(entryTarget, ccy)}`} />
          <LegendDot cls="bg-azure/40" label="Fair range" />
          <LegendDot cls="bg-warn" label={`Overvalued ≥ ${fmtMoney(overvaluedAt, ccy)}`} />
          <LegendDot cls="bg-loss" label={`Sell zone ≥ ${fmtMoney(sellZoneAt, ccy)}`} />
          <span className="ml-auto">
            fair value {fmtMoney(fairValue, ccy)} · MoS {fmtPct(band.marginOfSafetyPct, 0)}
          </span>
        </div>
      )}
      <p className="mt-1.5 text-[10px] leading-snug text-text-faint/90 italic">
        {hasHistory
          ? "Valuation zones are reconstructed from the fundamentals reported at each date — they step when a new annual report lands. Scrub to any point to see the Fair Value and zones as they stood then."
          : "Historical valuation unavailable — insufficient fundamental history for this security."}
      </p>
    </div>
  );
}

function LegendDot({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={clsx('w-2 h-2 rounded-sm', cls)} />
      {label}
    </span>
  );
}
