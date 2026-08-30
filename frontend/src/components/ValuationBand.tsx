import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ComposedChart, Line, ReferenceArea, ReferenceLine, ReferenceDot, CartesianGrid,
  XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import clsx from 'clsx';
import { api, type ValuationBand, type ValuationBandKey } from '../lib/api';
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

/** Left→right fade gradients for the valuation zones and their boundary lines. The zones are a
 *  snapshot of *today's* fair value, so they are fully opaque at the right edge (now) and dissolve
 *  toward the left (the past) — the price line stays solid because it is real history. `z*` fill the
 *  areas, `l*` stroke the dashed threshold/fair-value lines (stronger max opacity). `userSpaceOnUse`
 *  with percentages spans the whole SVG width, so the flat horizontal lines fade too — an
 *  objectBoundingBox gradient collapses on a zero-height line and would hide it. */
const FADE_GRADS: { id: string; color: string; max: number }[] = [
  { id: 'zbuy', color: C.gain, max: 0.15 },
  { id: 'zfair', color: C.azure, max: 0.08 },
  { id: 'zover', color: C.warn, max: 0.14 },
  { id: 'zsell', color: C.loss, max: 0.18 },
  { id: 'lentry', color: C.gain, max: 0.85 },
  { id: 'lover', color: C.warn, max: 0.75 },
  { id: 'lsell', color: C.loss, max: 0.85 },
  { id: 'lfair', color: C.textFaint, max: 0.9 },
];

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

/**
 * Price history with shaded valuation zones — the buy zone (≤ attractive entry price),
 * the fair range, the overvalued step and the sell zone (≥ fair value ×1.40) — plus the
 * current-price line and dashed entry-target / fair-value / sell-zone guides. Grounds the
 * abstract "band" in the security's actual price path. Native price units.
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
  const closes = (history ?? []).map((h) => h.close * k).filter((c) => c > 0);

  // No price path to draw yet — show a labelled placeholder instead of an empty chart.
  // (The backfill runs in the background; the line lands on a later poll.)
  if (closes.length < 2) {
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
  const lastPrice = closes.length ? closes[closes.length - 1] : fairValue;

  // Y-domain wraps both the price path and every zone edge so the shading is visible.
  const candidates = [...closes, entryTarget, fairValue, overvaluedAt, sellZoneAt, lastPrice];
  const lo = Math.min(...candidates) * 0.92;
  const hi = Math.max(...candidates) * 1.06;
  const data = (history ?? []).map((h) => ({ date: h.date, close: h.close * k }));
  const lastDate = data.length ? data[data.length - 1].date : undefined;

  // Fill each zone with its left→right fade gradient (opacity is baked into the gradient stops).
  // An optional right-edge label turns the right margin into a legible "today's scale" column.
  const zone = (
    y1: number, y2: number, gradId: string, key: string,
    label?: string, labelColor?: string,
  ) => (
    <ReferenceArea key={key} y1={Math.max(y1, lo)} y2={Math.min(y2, hi)}
      fill={`url(#${uid}-${gradId})`} fillOpacity={1} ifOverflow="hidden" stroke="none"
      label={label ? { value: label, position: 'right', fill: labelColor, fontSize: 10 } : undefined} />
  );

  return (
    <div>
      <div style={{ width: '100%', height }}>
        <ResponsiveContainer>
          <ComposedChart data={data} margin={{ top: 6, right: 46, bottom: 0, left: 0 }}>
            {/* Zone/line fade gradients: transparent in the past (left), full at today (right). */}
            <defs>
              {FADE_GRADS.map((g) => (
                <linearGradient key={g.id} id={`${uid}-${g.id}`}
                  gradientUnits="userSpaceOnUse" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor={g.color} stopOpacity={0} />
                  <stop offset="72%" stopColor={g.color} stopOpacity={g.max * 0.06} />
                  <stop offset="100%" stopColor={g.color} stopOpacity={g.max} />
                </linearGradient>
              ))}
            </defs>
            {/* Subtle horizontal grid, kept behind the bands so it never competes. */}
            <CartesianGrid stroke={C.hairline} strokeDasharray="2 4" strokeOpacity={0.5} vertical={false} />
            {/* Zones, cheapest at the bottom — each fades into the past (see gradients above) and
                carries a right-edge tag, so the right margin reads as today's valuation scale. */}
            {zone(0, entryTarget, 'zbuy', 'buy', 'Buy', C.gain)}
            {zone(entryTarget, overvaluedAt, 'zfair', 'fair', 'Fair', C.textFaint)}
            {zone(overvaluedAt, sellZoneAt, 'zover', 'over', 'Over', C.warn)}
            {zone(sellZoneAt, hi * 2, 'zsell', 'sell', 'Sell', C.loss)}
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: C.textFaint }}
              tickFormatter={(d) => fmtDate(d).replace(/ \d{4}$/, '')} minTickGap={48}
              stroke={C.hairline} />
            <YAxis domain={[lo, hi]} tick={{ fontSize: 10, fill: C.textFaint }}
              width={52} stroke={C.hairline} tickFormatter={(v) => fmtMoney(v, ccy, false)} />
            <Tooltip
              contentStyle={{ background: C.surface2, border: `1px solid ${C.hairline}`,
                borderRadius: 6, fontSize: 12 }}
              labelStyle={{ color: C.textFaint }}
              formatter={(v: number) => [fmtMoney(v, ccy), 'Price']}
              labelFormatter={(d) => fmtDate(d as string)} />
            {/* Band-boundary dividers — faded like the zones, crisp only at today (right edge). */}
            <ReferenceLine y={entryTarget} stroke={`url(#${uid}-lentry)`} strokeDasharray="4 3" />
            <ReferenceLine y={overvaluedAt} stroke={`url(#${uid}-lover)`} strokeDasharray="4 3" />
            <ReferenceLine y={sellZoneAt} stroke={`url(#${uid}-lsell)`} strokeDasharray="4 3" />
            {/* Fair value: distinct dashed reference (value shown in the legend below). */}
            <ReferenceLine y={fairValue} stroke={`url(#${uid}-lfair)`} strokeDasharray="2 3" />
            <Line type="monotone" dataKey="close" stroke={C.azure} strokeWidth={2.2} dot={false}
              isAnimationActive={false} />
            {/* "Today" divider — separates real history from today's valuation scale; the fade points here. */}
            {lastDate !== undefined && (
              <ReferenceLine x={lastDate} stroke={C.textFaint} strokeOpacity={0.55} strokeDasharray="3 3"
                label={{ value: 'today', position: 'top', fill: C.textFaint, fontSize: 9 }} />
            )}
            {/* Latest price — bright marker so "where it is now" reads instantly. */}
            {lastDate !== undefined && (
              <ReferenceDot x={lastDate} y={lastPrice} r={3.5} fill={C.azure}
                stroke={C.bg} strokeWidth={1.5} ifOverflow="extendDomain" />
            )}
          </ComposedChart>
        </ResponsiveContainer>
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
        Zones are a snapshot of today's fair value ({fmtDate(todayISO)}). The price line is real history —
        earlier prices were valued against different fundamentals, so the zones fade into the past.
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
