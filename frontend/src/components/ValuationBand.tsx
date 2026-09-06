import { useId, useState, useMemo, useEffect, type ReactNode, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ComposedChart, Line, Area, ReferenceArea, ReferenceLine, ReferenceDot, CartesianGrid,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Brush,
} from 'recharts';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { api, type ValuationBand, type ValuationBandKey, type ValuationSnapshot } from '../lib/api';
import { mergePriceWithSnapshots, snapshotAt, pctLabel } from '../lib/valuationHistory';
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

/** Per-zone fill colour + opacity for the stepped valuation-zone Areas (buy/fair/over/sell),
 *  reconstructed per-date from the fundamentals then in force. Uniform across the plot (no
 *  horizontal fade) so a step reads at every timeframe — a fade tuned for the full 10-year view
 *  left zoomed-in windows almost entirely unshaded. Reuses the reserved gain/loss/warn tokens:
 *  cheap = gain, expensive = loss, gold marks the overvalued step. Deliberately quiet — the
 *  current day's edges are re-emphasized separately (right-edge labels + badge, full opacity)
 *  so today's thresholds stay legible against this muted historical fill. */
const ZONE_STYLE = {
  buy: { color: C.gain, fill: 0.14 },
  fair: { color: C.azure, fill: 0.07 },
  over: { color: C.warn, fill: 0.13 },
  sell: { color: C.loss, fill: 0.16 },
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
 * Price history with valuation zones reconstructed per-date from the fundamentals reported at
 * each historical filing — the buy zone (≤ that date's entry target), the fair range, the
 * overvalued step and the sell zone (≥ that date's sell-zone threshold) — stepped over time
 * (never interpolated, since a report lands on one day, not gradually) alongside a dashed Fair
 * Value spine. Grounds the abstract "band" in the security's actual price path, as it actually
 * stood at each point in time. Native price units.
 *
 * A toolbar lets you narrow the window (trailing presets + a drag Brush for arbitrary
 * ranges), switch the mark (line / area / dots), pick a linear or log axis, and rebase to
 * % return from the first visible day. The Y-axis autoscales to the visible slice so tight
 * windows show real detail. Rebase hides the absolute-price zones (they no longer map).
 *
 * Hovering — or scrubbing with Arrow keys, no pointer required — moves a cursor across the
 * chart and drives a snapshot card with that date's price, Fair Value, discount to FV and
 * zone verdict; Enter/Space pins the cursor in place, Escape clears the selection. The
 * current day's zone edges are re-emphasized at full opacity (right-edge labels + a small
 * "Fair value · MoS" badge) against the deliberately quieter historical steps.
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

  // Scrub cursor — the date the snapshot card and vertical marker follow. `null` means "no
  // explicit selection", in which case it defaults to today (see `activeDate` below) whenever
  // the visible window still includes it. `pinned` freezes the cursor so it survives the mouse
  // leaving the chart; keyboard nav (Step 3) works the same whether or not anything is pinned.
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);

  // date -> index into `full`, so keyboard nav and the snapshot card's "price on that date"
  // lookup are O(1) instead of re-scanning the whole series on every scrub/arrow-key.
  const dateIndex = useMemo(() => new Map(full.map((d, i) => [d.date, i])), [full]);

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

  // Scrub cursor — defaults to today whenever the visible window still includes it, so the
  // snapshot card shows something useful before the user ever hovers. `activeSnap` is the
  // reconstructed valuation in force on `activeDate` (null pre-coverage, or with no history).
  const activeDate = selectedDate ?? (windowHasLatest ? lastDate : null);
  const activeSnap = activeDate ? snapshotAt(snapshots, activeDate) : null;
  const activeIdx = activeDate ? dateIndex.get(activeDate) : undefined;
  const priceAtActive = activeIdx != null ? full[activeIdx].close : null;

  // Current-day emphasis (Step 4) — the LAST snapshot, drawn at full opacity against the
  // quieter historical steps, never as a flat zone spanning history.
  const lastSnap = snapshots.length ? snapshots[snapshots.length - 1] : null;
  const lastSnapMoS = lastSnap && lastSnap.fairValue ? 1 - lastSnap.entryTarget / lastSnap.fairValue : null;

  const onChartMouseMove = (state: { activeLabel?: string }) => {
    if (!pinned && state?.activeLabel) setSelectedDate(state.activeLabel);
  };

  // Keyboard nav — must work without hover (a11y). ArrowLeft/Right step through `full` from
  // whatever is currently active (defaulting to the last point), clamped at the ends;
  // Enter/Space pins/unpins the cursor; Escape drops back to the default (today).
  const onChartKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const curIdx = activeDate ? (dateIndex.get(activeDate) ?? lastIdx) : lastIdx;
      const nextIdx = e.key === 'ArrowLeft' ? Math.max(0, curIdx - 1) : Math.min(lastIdx, curIdx + 1);
      setSelectedDate(full[nextIdx].date);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setPinned((p) => !p);
    } else if (e.key === 'Escape') {
      setSelectedDate(null);
      setPinned(false);
    }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-4 items-start">
      <div className="flex-1 min-w-0">
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

        <div
          className={clsx(
            'relative rounded outline-none',
            'focus-visible:ring-1 focus-visible:ring-azure/60',
          )}
          style={{ width: '100%', height: height + 34 }}
          tabIndex={0}
          role="application"
          aria-label="Kursverlauf mit Bewertungszonen. Pfeiltasten bewegen den Cursor, Eingabetaste fixiert ihn, Escape hebt die Auswahl auf."
          onKeyDown={onChartKeyDown}
        >
          {windowHasLatest && lastSnap && (
            <div className="chip absolute top-0 right-2 z-10 pointer-events-none !bg-surface-2/90">
              Fair value {fmtMoney(lastSnap.fairValue * k, ccy)} · MoS {fmtPct(lastSnapMoS, 0)}
            </div>
          )}
          <ResponsiveContainer>
            <ComposedChart data={plot} margin={{ top: 6, right: 46, bottom: 0, left: 0 }}
              onMouseMove={onChartMouseMove}>
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
              {/* Scrub cursor — the date the snapshot card is showing, driven by hover or the
                  keyboard (Arrow keys). Solid + brighter than the "today" divider when pinned. */}
              {activeDate && (
                <ReferenceLine x={activeDate} stroke={C.azure} strokeOpacity={pinned ? 0.85 : 0.5}
                  strokeDasharray={pinned ? undefined : '2 2'} ifOverflow="hidden" />
              )}
              {/* Current-day zone-edge labels — driven by the LAST snapshot, at full opacity, so
                  today's thresholds stay legible against the deliberately quiet historical steps
                  (ZONE_STYLE fill opacities). Never a flat zone spanning history — just the three
                  edges as they stand today, pinned to the right-hand (today) edge of the plot. */}
              {windowHasLatest && !rebase && lastSnap && (
                <>
                  <ReferenceDot x={lastDate} y={lastSnap.entryTarget * k} r={2.5}
                    fill={ZONE_STYLE.buy.color} stroke="none" ifOverflow="hidden"
                    label={{ value: 'Buy', position: 'right', fill: ZONE_STYLE.buy.color,
                      fontSize: 9, fontWeight: 600 }} />
                  <ReferenceDot x={lastDate} y={lastSnap.overvaluedAt * k} r={2.5}
                    fill={ZONE_STYLE.over.color} stroke="none" ifOverflow="hidden"
                    label={{ value: 'Over', position: 'right', fill: ZONE_STYLE.over.color,
                      fontSize: 9, fontWeight: 600 }} />
                  <ReferenceDot x={lastDate} y={lastSnap.sellZoneAt * k} r={2.5}
                    fill={ZONE_STYLE.sell.color} stroke="none" ifOverflow="hidden"
                    label={{ value: 'Sell', position: 'right', fill: ZONE_STYLE.sell.color,
                      fontSize: 9, fontWeight: 600 }} />
                </>
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
      <SnapshotCard
        activeDate={activeDate}
        activeSnap={activeSnap}
        price={priceAtActive}
        k={k}
        ccy={ccy}
        coverageFrom={coverageFrom}
        pinned={pinned}
      />
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

/** A row in the {@link SnapshotCard}: a label/value pair, dimmed for the zone-edge reference
 *  rows so the headline price/FV/verdict numbers above them keep the visual emphasis. */
function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={clsx('flex items-center justify-between gap-2', muted ? 'text-text-faint' : 'text-text')}>
      <span className={muted ? '' : 'text-text-muted'}>{label}</span>
      <span className={muted ? '' : 'font-medium'}>{value}</span>
    </div>
  );
}

/**
 * The scrub cursor's detail panel — date, market price, Fair Value, the discount/premium to
 * it, a zone-verdict badge (reusing {@link BandBadge}) and the four zone edges, all as they
 * stood on `activeDate`. Sits beside the chart on wide screens, stacked below it on narrow
 * ones (driven by the parent's `flex-col lg:flex-row` layout). Pre-coverage (or when there
 * isn't enough fundamental history at all) it honestly says so instead of guessing.
 */
function SnapshotCard({
  activeDate, activeSnap, price, k, ccy, coverageFrom, pinned,
}: {
  activeDate: string | null;
  activeSnap: ValuationSnapshot | null;
  price: number | null;
  k: number;
  ccy: string;
  coverageFrom: string | null;
  pinned: boolean;
}) {
  if (!activeDate) {
    return (
      <div className="w-full lg:w-60 shrink-0 rounded border border-hairline bg-surface-2 p-3 text-[11px] text-text-faint">
        Hover or scrub the chart to inspect a valuation snapshot.
      </div>
    );
  }

  const fv = activeSnap ? activeSnap.fairValue * k : null;
  const entry = activeSnap ? activeSnap.entryTarget * k : null;
  const over = activeSnap ? activeSnap.overvaluedAt * k : null;
  const sell = activeSnap ? activeSnap.sellZoneAt * k : null;
  const discount = price != null && fv ? price / fv - 1 : null;
  const zoneKey: ValuationBandKey | null = (price != null && entry != null && over != null && sell != null)
    ? (price <= entry ? 'undervalued' : price < over ? 'fair' : price < sell ? 'overvalued' : 'significantly-overvalued')
    : null;

  return (
    <div
      className={clsx(
        'w-full lg:w-60 shrink-0 rounded border bg-surface-2 p-3 text-[11px]',
        pinned ? 'border-azure/50' : 'border-hairline',
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-text-muted font-medium">{fmtDate(activeDate)}</span>
        {pinned && <span className="chip !py-0 !px-1.5 text-azure">pinned</span>}
      </div>
      {activeSnap == null ? (
        <p className="text-text-faint">
          {coverageFrom
            ? `No reconstructed valuation before ${fmtDate(coverageFrom)}.`
            : 'Historical valuation unavailable — insufficient fundamental history for this security.'}
        </p>
      ) : (
        <div className="space-y-1.5">
          <Row label="Price" value={fmtMoney(price, ccy)} />
          <Row label="Fair Value" value={fmtMoney(fv, ccy)} />
          <Row label="vs Fair Value" value={pctLabel(discount)} />
          {zoneKey && <div className="pt-0.5"><BandBadge band={zoneKey} /></div>}
          <div className="pt-2 mt-1.5 border-t border-hairline space-y-1">
            <Row label="Buy ≤" value={fmtMoney(entry, ccy)} muted />
            <Row label="Fair" value={`${fmtMoney(entry, ccy)}–${fmtMoney(over, ccy)}`} muted />
            <Row label="Overvalued ≥" value={fmtMoney(over, ccy)} muted />
            <Row label="Sell ≥" value={fmtMoney(sell, ccy)} muted />
          </div>
        </div>
      )}
    </div>
  );
}
