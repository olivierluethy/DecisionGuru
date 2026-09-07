import { useId, useState, useMemo, useEffect, useRef, type ReactNode, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ComposedChart, Line, Area, ReferenceArea, ReferenceLine, ReferenceDot, CartesianGrid,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Brush,
} from 'recharts';
import clsx from 'clsx';
import dayjs from 'dayjs';
import {
  api, type ValuationBand, type ValuationBandKey, type ValuationSnapshot, type ValuationDriverDelta,
} from '../lib/api';
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
  const snapshotsRaw = valHistory?.snapshots ?? [];
  // Why there are no reconstructed zones. When the backend deliberately WITHHELD the series
  // (e.g. an ADR whose trading currency differs from its reporting currency — reconstructed
  // per-share zones can't be placed on the trading-currency price without mixing currency and
  // share basis), it sends a specific `note`; show that honest reason instead of the generic
  // insufficient-history line, so the chart never silently contradicts the live headline.
  const unavailableReason = valHistory?.unavailableReason ?? null;
  const historyNote = unavailableReason
    ? (valHistory?.note ?? 'Historical valuation zones are unavailable for this listing.')
    : 'Historical valuation unavailable — insufficient fundamental history for this security.';

  // Unique, colon-free prefix so this instance's gradient ids never clash with another chart's.
  const uid = useId().replace(/:/g, '');

  // Convert every monetary figure by the same scalar FX rate so the chart matches the
  // CHF headline; a scalar multiply preserves the zone shape and all relationships. When
  // no rate is supplied the chart stays in the native currency (unchanged behavior).
  const k = rate != null ? rate : 1;
  const ccy = ((rate != null && displayCurrency) ? displayCurrency : currency) || '';
  // The chart's CURRENT-day fair value + zones (right-edge labels, top badge, snapshot card,
  // footer legend, and the final stepped zone segment) come from `lastSnap` — which is the
  // synthetic live snapshot appended just below, i.e. the SAME live valuation the headline
  // shows. So the chart's "today" verdict can never contradict the headline. The RECONSTRUCTED
  // annual snapshots (computed from different inputs) drive only the PAST steps and the
  // scrub-to-history inspection. `band` is the live valuation, passed straight through.

  // Full converted price path (positive closes only). The backend already serves up to 10y,
  // so every preset and the Brush slice this in place — no refetch when the window changes.
  const full = useMemo(
    () => (history ?? []).map((h) => ({ date: h.date, close: h.close * k })).filter((d) => d.close > 0),
    [history, k],
  );

  // The live valuation as a synthetic "today" snapshot — the SAME estimate the headline shows,
  // so the chart's zones/verdict/labels can never contradict it. Two modes:
  //  • WITH a reconstructed series (>=2 annual snaps): append it at the LAST price date, so it
  //    forms the final step of the stepped historical zones.
  //  • WITHOUT one (an ADR whose reconstruction was withheld, or too little fundamental history):
  //    place it at the FIRST price date, so TODAY's zones render as flat reference bands across
  //    the whole window. The current Buy/Fair/Overvalued/Sell levels are correct in the price's
  //    own currency even for an ADR — only the *per-year history* isn't reconstructable there,
  //    so the chart still shows where the price sits vs today's fair value rather than nothing.
  const hasReconstruction = snapshotsRaw.length >= 2;
  const liveSnap = useMemo<ValuationSnapshot | null>(() => {
    if (full.length === 0) return null;
    const d = hasReconstruction ? full[full.length - 1].date : full[0].date;
    return {
      asOf: d,
      effectiveDateSource: 'live',
      fiscalPeriodEnd: null,
      filingDate: null,
      fiscalYear: Number(d.slice(0, 4)),
      fairValue: band.fairValue,
      entryTarget: band.entryTarget,
      overvaluedAt: band.overvaluedAt,
      sellZoneAt: band.sellZoneAt,
      inputs: { eps: null, bvps: null, fcfPerShare: null, growth: 0 },
      models: {},
      drivers: null,
    };
  }, [hasReconstruction, full, band]);
  const snapshots = useMemo(
    () => (liveSnap ? (hasReconstruction ? [...snapshotsRaw, liveSnap] : [liveSnap]) : snapshotsRaw),
    [snapshotsRaw, liveSnap, hasReconstruction],
  );
  // Zones render whenever today's live band is mapped onto the price path (always, once prices
  // exist): STEPPED when reconstructed history exists, otherwise FLAT at today's levels.
  // `hasReconstruction` gates only the history-specific chrome — the per-year steps' transition
  // markers, the pre-coverage band, and scrubbing to a past valuation.
  const hasZones = liveSnap != null;

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

  // Scrub cursor — the date the snapshot card and vertical marker follow. `null` means "no
  // explicit selection", in which case it defaults to today (see `activeDate` below) whenever
  // the visible window still includes it. `pinned` freezes the cursor so it survives the mouse
  // leaving the chart; keyboard nav (Step 3) works the same whether or not anything is pinned.
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);

  // Whenever the underlying series changes size (data lands, symbol switches), reset to Max —
  // and drop any pinned/selected date, so a symbol swap without remount can't carry a stale
  // selection (e.g. a pinned transition detail) into a different security's history.
  useEffect(() => {
    setRange({ start: 0, end: Math.max(0, full.length - 1) });
    setPreset('max');
    setSelectedDate(null);
    setPinned(false);
  }, [full.length]);

  // rAF-coalesced Brush updates: a fast drag fires onChange many times per frame; we keep
  // only the latest indices and commit the range once per paint, so the main chart re-renders
  // at most ~60/s instead of on every emitted event. The Brush's own travellers still track
  // the pointer natively (their position is internal to Recharts), so the drag stays smooth.
  const brushRaf = useRef<number | null>(null);
  const brushNext = useRef<{ start: number; end: number } | null>(null);
  useEffect(() => () => { if (brushRaf.current != null) cancelAnimationFrame(brushRaf.current); }, []);

  // date -> index into `full`, so keyboard nav and the snapshot card's "price on that date"
  // lookup are O(1) instead of re-scanning the whole series on every scrub/arrow-key.
  const dateIndex = useMemo(() => new Map(full.map((d, i) => [d.date, i])), [full]);

  // Valuation-transition markers — one per snapshot that carries a before/after `drivers`
  // chain (every step after the first; the first snapshot has nothing to compare against).
  // Snapped to the first actual trading day on/after the snapshot's effective date (`asOf`
  // isn't a price-calendar date — it's a filing/period-end date) so the marker always lands
  // on a real point of the plotted series (a category axis needs an exact match) and lines up
  // with where the stepped FV spine actually jumps to this snapshot's value.
  //
  // De-duplicated by snapped date, and each date resolved via the SAME `snapshotAt` lookup the
  // click handler's derived panel uses (activeSnap = snapshotAt(snapshots, activeDate)) — a
  // guard against two snapshots ever snapping to the same trading day (no trading day between
  // their `asOf` values). That can't happen with annual filings on a traded security today, but
  // without this, a collision would let a marker and the panel it opens disagree on whose
  // drivers to show (the panel always wins with `snapshotAt`'s latest-match rule, so pinning the
  // marker list to that same rule keeps them from ever contradicting each other).
  const transitions = useMemo(() => {
    const snappedDates = new Set<string>();
    snapshots.filter((s) => s.drivers != null).forEach((s) => {
      const onto = full.find((f) => f.date >= s.asOf);
      if (onto) snappedDates.add(onto.date);
    });
    return Array.from(snappedDates)
      .map((date) => {
        const snap = snapshotAt(snapshots, date);
        return snap?.drivers ? { date, snap } : null;
      })
      .filter((t): t is { date: string; snap: ValuationSnapshot } => t != null);
  }, [snapshots, full]);

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
  // Absolute plot rows, built ONCE per data change and independent of the visible window.
  // Dragging the Brush only moves `range`; keeping this heavy (~2500-row) build off `range`
  // is what stops the slider from stuttering — previously `base` (a function of range.start)
  // was a dependency, so every drag tick rebuilt the entire series. `value` carries the
  // absolute close here; rebase remaps it in the light pass just below.
  const plotAbs = useMemo(
    () => full.map((d, i) => {
      const m = merged[i];
      return {
        date: d.date,
        close: d.close,
        value: d.close,
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
    [full, merged],
  );
  // Rebase turns absolute prices into % return from the first *visible* day. When NOT
  // rebasing (the common case, and the only one that shows zones) `plot` is the stable
  // `plotAbs` reference, so a Brush drag never re-derives it.
  const base = full.length ? full[Math.min(range.start, full.length - 1)].close : 0;
  const plot = useMemo(
    () => (rebase && base ? plotAbs.map((d) => ({ ...d, value: (d.close / base - 1) * 100 })) : plotAbs),
    [plotAbs, rebase, base],
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
    if (hasZones) {
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
  }, [plot, range, rebase, hasZones, merged]);

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
  const showPreCoverage = hasReconstruction && !!coverageFrom && full[0].date < coverageFrom;

  // Scrub cursor — defaults to today whenever the visible window still includes it, so the
  // snapshot card shows something useful before the user ever hovers. `activeSnap` is the
  // reconstructed valuation in force on `activeDate` (null pre-coverage, or with no history).
  const activeDate = selectedDate ?? (windowHasLatest ? lastDate : null);
  const activeSnap = activeDate ? snapshotAt(snapshots, activeDate) : null;
  const activeIdx = activeDate ? dateIndex.get(activeDate) : undefined;
  const priceAtActive = activeIdx != null ? full[activeIdx].close : null;

  // The transition detail panel (Step 2) compares against the *previous* snapshot's fiscal
  // year — the report the active snapshot's before-values were reported under.
  const activeSnapIdx = activeSnap ? snapshots.indexOf(activeSnap) : -1;
  const prevSnap = activeSnapIdx > 0 ? snapshots[activeSnapIdx - 1] : null;

  // Current-day emphasis (Step 4) — the LAST snapshot (the live one, when appended), drawn at
  // full opacity against the quieter historical steps, never as a flat zone spanning history.
  const lastSnap = snapshots.length ? snapshots[snapshots.length - 1] : null;
  // Price vs fair value TODAY, worded exactly like the headline card: the verdict word comes
  // from the band's zones, the number is the headline's own figure. Undervalued → "margin of
  // safety" (mos = fair/price − 1, recovered from premiumToFair as 1/(1+p) − 1); overvalued →
  // "overvalued" by the true premiumToFair (price/fair − 1, the same basis the sell panel uses);
  // the fair zone states the premium/discount neutrally. This replaces the former "MoS 30%"
  // (the *configured* buy-discount — a different quantity that shared the "MoS" label).
  const premiumToFair = band.premiumToFair;
  const mosToday = premiumToFair != null && Number.isFinite(premiumToFair) && 1 + premiumToFair > 0
    ? 1 / (1 + premiumToFair) - 1
    : null;
  const isExpensiveZone = band.band === 'overvalued' || band.band === 'significantly-overvalued';
  const priceVsFairLabel = mosToday != null && mosToday > 0
    ? `${fmtPct(mosToday, 0)} margin of safety`
    : isExpensiveZone
      ? `overvalued ${fmtPct(premiumToFair ?? 0, 0)}`
      : premiumToFair == null || !Number.isFinite(premiumToFair)
        ? null
        : `${fmtPct(premiumToFair, 0)} above fair`;

  const onChartMouseMove = (state: { activeLabel?: string }) => {
    if (!pinned && state?.activeLabel) setSelectedDate(state.activeLabel);
  };

  const onBrushChange = (r: { startIndex?: number; endIndex?: number }) => {
    if (r && typeof r.startIndex === 'number' && typeof r.endIndex === 'number'
        && r.endIndex > r.startIndex) {
      brushNext.current = { start: r.startIndex, end: r.endIndex };
      if (brushRaf.current == null) {
        brushRaf.current = requestAnimationFrame(() => {
          brushRaf.current = null;
          if (brushNext.current) {
            setRange(brushNext.current);
            setPreset('custom');
          }
        });
      }
    }
  };

  // Clicking a transition marker pins the detail view on that snapshot (Step 1) — a click is
  // a deliberate pick, never just a hover, so it stays put until explicitly closed.
  const onSelectTransition = (date: string) => {
    setSelectedDate(date);
    setPinned(true);
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
    <div>
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
          {windowHasLatest && hasZones && lastSnap && (
            <div className="chip absolute top-0 right-2 z-10 pointer-events-none !bg-surface-2/90">
              Fair value {fmtMoney(lastSnap.fairValue * k, ccy)}{priceVsFairLabel ? ` · ${priceVsFairLabel}` : ''}
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
                  label={{ value: `price only · zones from ${fmtDate(coverageFrom!)}`,
                    position: 'insideTopLeft', fill: C.textFaint, fontSize: 9 }} />
              )}
              {/* Stepped zone bands, reconstructed per-date from the fundamentals then in force —
                  stacked bottom-up (buy → fair → over → sell) so each layer is drawn as the
                  *thickness* between adjacent thresholds, not an absolute edge. Stepped (never
                  interpolated) because a real report lands on one day, not gradually. Hidden in
                  rebase mode, where absolute-price levels no longer map onto a % series, and
                  whenever there isn't enough fundamental history to reconstruct a path. */}
              {/* Zone bands + FV spine. STEPPED per-date when reconstructed history exists, else
                  FLAT at today's live levels (a single "today" snapshot spanning the window) so an
                  ADR / thin-history name still shows where the price sits vs today's fair value.
                  Hidden only in rebase mode, where absolute-price levels no longer map. */}
              {!rebase && hasZones && (
                <>
                  <Area type="stepAfter" dataKey="buyBand" stackId="zones" stroke="none"
                    fill={ZONE_STYLE.buy.color} fillOpacity={ZONE_STYLE.buy.fill} isAnimationActive={false} />
                  <Area type="stepAfter" dataKey="fairBand" stackId="zones" stroke="none"
                    fill={ZONE_STYLE.fair.color} fillOpacity={ZONE_STYLE.fair.fill} isAnimationActive={false} />
                  <Area type="stepAfter" dataKey="overBand" stackId="zones" stroke="none"
                    fill={ZONE_STYLE.over.color} fillOpacity={ZONE_STYLE.over.fill} isAnimationActive={false} />
                  <Area type="stepAfter" dataKey="sellBand" stackId="zones" stroke="none"
                    fill={ZONE_STYLE.sell.color} fillOpacity={ZONE_STYLE.sell.fill} isAnimationActive={false} />
                  {/* Fair Value spine — stepped reconstruction, or a flat line at today's FV. */}
                  <Line type="stepAfter" dataKey="fairValue" stroke={C.textFaint} strokeWidth={1.6}
                    strokeDasharray="2 3" dot={false} isAnimationActive={false} />
                </>
              )}
              {/* Valuation-transition markers — one per reconstructed snapshot with a before/after
                  `drivers` chain (never the flat live-only mode, which has no transitions). */}
              {!rebase && hasReconstruction && transitions.map(({ date, snap }) => (
                <ReferenceDot
                  key={snap.asOf}
                  x={date}
                  y={snap.fairValue * k}
                  r={pinned && selectedDate === date ? 5 : 3.5}
                  fill={pinned && selectedDate === date ? C.azure : C.surface2}
                  stroke={C.azure}
                  strokeWidth={1.5}
                  ifOverflow="hidden"
                  style={{ cursor: 'pointer' }}
                  onClick={() => onSelectTransition(date)}
                />
              ))}
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
              {windowHasLatest && !rebase && hasZones && lastSnap && (
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
                onChange={onBrushChange} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {/* Footer legend — driven by the LAST reconstructed snapshot (`lastSnap`), never the
            live `band` prop: `band.*` reflects today's inputs recomputed fresh, which can
            drift slightly from the reconstructed snapshot's own stored zone edges (same
            fundamentals, but the two paths aren't guaranteed to land on identical floating-
            point results) — showing `band.*` here previously contradicted the right-edge
            labels, the top badge and the snapshot card, which all read `lastSnap`. Only the
            MoS *percentage* still comes from `band` (a config value, not a reconstructed one). */}
        {rebase ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-text-faint">
            <span>% return since {fmtDate(full[Math.min(range.start, lastIdx)].date)} · fair-value zones hidden in rebase</span>
            {hasZones && lastSnap && (
              <span className="ml-auto">fair value {fmtMoney(lastSnap.fairValue * k, ccy)}{priceVsFairLabel ? ` · ${priceVsFairLabel}` : ''}</span>
            )}
          </div>
        ) : hasZones && lastSnap ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-text-faint">
            <LegendDot cls="bg-gain" label={`Buy ≤ ${fmtMoney(lastSnap.entryTarget * k, ccy)}`} />
            <LegendDot cls="bg-azure/40" label="Fair range" />
            <LegendDot cls="bg-warn" label={`Overvalued ≥ ${fmtMoney(lastSnap.overvaluedAt * k, ccy)}`} />
            <LegendDot cls="bg-loss" label={`Sell zone ≥ ${fmtMoney(lastSnap.sellZoneAt * k, ccy)}`} />
            <span className="ml-auto">
              fair value {fmtMoney(lastSnap.fairValue * k, ccy)}{priceVsFairLabel ? ` · ${priceVsFairLabel}` : ''}
            </span>
          </div>
        ) : null}
        <p className="mt-1.5 text-[10px] leading-snug text-text-faint/90 italic">
          {hasReconstruction
            ? `Valuation zones are reconstructed from the fundamentals reported at each date — they step when a new annual report lands.${
                showPreCoverage && coverageFrom
                  ? ` The full price history is shown; zones begin ${fmtDate(coverageFrom)} (no earlier fundamentals).`
                  : ''
              } Scrub to any point to see the Fair Value and zones as they stood then.`
            : hasZones
              ? `The bands are today's fair-value zones (flat reference lines). ${
                  unavailableReason
                    ? "Per-year history isn't reconstructed for this cross-listing (it reports in a different currency than it trades in) — the live zones above are computed for this listing directly."
                    : "There isn't enough fundamental history to reconstruct how the zones evolved over time."
                }`
              : historyNote}
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
        hasHistory={hasZones}
        liveOnly={hasZones && !hasReconstruction}
        emptyNote={historyNote}
      />
    </div>
    {/* Transition detail panel (Step 2) — only when a transition marker (or the keyboard/
        Enter pin on a transition date) is pinned. Presents strictly the observable
        before/after chain carried on the snapshot's `drivers`: Fundamentals -> Model
        outputs -> Fair Value -> Zones. Never a causal "input X caused Y% of FV" claim —
        the data doesn't support one. */}
    {pinned && activeSnap?.drivers && (
      <TransitionPanel
        snap={activeSnap}
        prevYear={prevSnap?.fiscalYear ?? null}
        k={k}
        ccy={ccy}
        onClose={() => { setPinned(false); setSelectedDate(null); }}
      />
    )}
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
  activeDate, activeSnap, price, k, ccy, coverageFrom, pinned, hasHistory, liveOnly, emptyNote,
}: {
  activeDate: string | null;
  activeSnap: ValuationSnapshot | null;
  price: number | null;
  k: number;
  ccy: string;
  coverageFrom: string | null;
  pinned: boolean;
  /** Live-only mode: today's zones are shown as flat bands (no reconstructed per-year history —
   *  e.g. an ADR). The card then reads the SAME (current) fair value at every scrub point, so it
   *  says so rather than implying the level was reconstructed as-of that past date. */
  liveOnly: boolean;
  /** Honest "no reconstructed valuation" copy from the parent — the backend's specific reason
   *  (e.g. an ADR currency/share-basis mismatch) when the series was withheld, else the
   *  generic insufficient-history line. Shown when there's no snapshot to display. */
  emptyNote: string;
  /** Fewer than two reconstructable snapshots (see `hasHistory` at the call site): even when
   *  `activeSnap` itself is non-null (e.g. exactly one snapshot exists and covers the active
   *  date), there isn't enough fundamental history to call this a reconstructed *path* — show
   *  the same "unavailable" message the chart's zones/spine/footer are already gated on,
   *  rather than a populated valuation that contradicts them. */
  hasHistory: boolean;
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
      {!hasHistory || activeSnap == null ? (
        <p className="text-text-faint">
          {hasHistory && coverageFrom
            ? `No reconstructed valuation before ${fmtDate(coverageFrom)}.`
            : emptyNote}
        </p>
      ) : (
        <div className="space-y-1.5">
          {liveOnly && (
            <p className="text-[10px] text-text-faint leading-snug pb-1">
              Today's zones (no per-year history for this listing) — the fair value is the current estimate at every point.
            </p>
          )}
          <Row label="Price" value={fmtMoney(price, ccy)} />
          <Row label={liveOnly ? 'Fair Value (today)' : 'Fair Value'} value={fmtMoney(fv, ccy)} />
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

/** One labelled group in the {@link TransitionPanel} (Fundamentals / Model outputs / Result). */
function DriverGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-text-faint text-[10px] uppercase tracking-wide mb-1.5">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

/** A `before → after` fundamentals row: the raw reconstructed input plus the ↑/↓ `dir` and
 *  `pctLabel(deltaPct)` the snapshot carries — never a re-derived number. */
function DriverRow({
  label, d, fmt,
}: { label: string; d: ValuationDriverDelta; fmt: (v: number) => string }) {
  const arrow = d.dir === 'up' ? '↑' : d.dir === 'down' ? '↓' : null;
  const arrowCls = d.dir === 'up' ? 'text-gain' : d.dir === 'down' ? 'text-loss' : 'text-text-faint';
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-text-muted">{label}</span>
      <span className="text-text font-medium text-right whitespace-nowrap">
        {d.before != null ? fmt(d.before) : '—'} → {d.after != null ? fmt(d.after) : '—'}
        {arrow && <span className={clsx('ml-1.5', arrowCls)}>{arrow}</span>}
        <span className="text-text-faint ml-1">({pctLabel(d.deltaPct)})</span>
      </span>
    </div>
  );
}

/** A `before → after` model-output row. Models that didn't produce a usable estimate on one
 *  side (`valid === false` — e.g. negative EPS breaks the Graham Number) show a muted "n/a"
 *  rather than a bogus number; models that fed the median Fair Value get a quiet "in median" tag. */
function ModelRow({
  label, d, k, ccy,
}: { label: string; d: ValuationDriverDelta; k: number; ccy: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-text-muted inline-flex items-center gap-1.5">
        {label}
        {d.contributed && (
          <span className="chip !py-0 !px-1 !text-[9px] text-azure/80">in median</span>
        )}
      </span>
      {d.valid === false ? (
        <span className="text-text-faint">n/a</span>
      ) : (
        <span className="text-text font-medium whitespace-nowrap">
          {d.before != null ? fmtMoney(d.before * k, ccy) : '—'} → {d.after != null ? fmtMoney(d.after * k, ccy) : '—'}
        </span>
      )}
    </div>
  );
}

/**
 * The pinned transition-detail view (Task 11) — opened by clicking a transition marker on the
 * FV spine (or Enter/Space-pinning the keyboard cursor on a transition date). Walks the
 * observable Fundamentals -> Model outputs -> Fair Value -> Zones chain the snapshot's
 * `drivers` carry, strictly as recorded — nothing here claims one input "caused" a given share
 * of the Fair Value change, only that both moved and by how much.
 */
function TransitionPanel({
  snap, prevYear, k, ccy, onClose,
}: {
  snap: ValuationSnapshot;
  prevYear: number | null;
  k: number;
  ccy: string;
  onClose: () => void;
}) {
  const d = snap.drivers;
  if (!d) return null;
  const money = (v: number) => fmtMoney(v * k, ccy);

  return (
    <div className="mt-3 rounded border border-azure/50 bg-surface-2 p-3 text-[11px]">
      <div className="flex items-center justify-between gap-2 mb-3">
        <span className="text-text font-medium">
          Fair Value {pctLabel(d.fairValue.deltaPct)}
          <span className="text-text-faint font-normal">
            {' · FY'}{prevYear ?? '—'}{' → FY'}{snap.fiscalYear}{' report'}
          </span>
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close transition detail"
          aria-label="Close transition detail"
          className="text-text-faint hover:text-text cursor-pointer leading-none text-[14px] px-1"
        >
          ×
        </button>
      </div>
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
        <DriverGroup title="Fundamentals">
          <DriverRow label="EPS (reconstructed)" d={d.inputs.eps} fmt={money} />
          <DriverRow label="FCF/share" d={d.inputs.fcfPerShare} fmt={money} />
          <DriverRow label="Book value" d={d.inputs.bvps} fmt={money} />
          <DriverRow label="Growth" d={d.inputs.growth} fmt={(v) => fmtPct(v)} />
        </DriverGroup>
        <DriverGroup title="Model outputs">
          <ModelRow label="Graham Number" d={d.models.grahamNumber} k={k} ccy={ccy} />
          <ModelRow label="Graham Growth" d={d.models.grahamGrowth} k={k} ccy={ccy} />
          <ModelRow label="Earnings DCF" d={d.models.dcf} k={k} ccy={ccy} />
          <ModelRow label="FCF DCF" d={d.models.fcf} k={k} ccy={ccy} />
        </DriverGroup>
        <DriverGroup title="Result">
          <Row
            label="Fair Value"
            value={`${d.fairValue.before != null ? money(d.fairValue.before) : '—'} → ${d.fairValue.after != null ? money(d.fairValue.after) : '—'}`}
          />
          <Row label="Δ Fair Value" value={pctLabel(d.fairValue.deltaPct)} muted />
          <div className="pt-1.5 mt-1 border-t border-hairline space-y-1">
            <Row label="Buy ≤" value={`${money(d.zones.entryTarget.before)} → ${money(d.zones.entryTarget.after)}`} muted />
            <Row label="Overvalued ≥" value={`${money(d.zones.overvaluedAt.before)} → ${money(d.zones.overvaluedAt.after)}`} muted />
            <Row label="Sell ≥" value={`${money(d.zones.sellZoneAt.before)} → ${money(d.zones.sellZoneAt.after)}`} muted />
          </div>
        </DriverGroup>
      </div>
    </div>
  );
}
