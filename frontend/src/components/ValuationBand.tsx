import { useQuery } from '@tanstack/react-query';
import {
  ComposedChart, Line, ReferenceArea, ReferenceLine, XAxis, YAxis, Tooltip,
  ResponsiveContainer,
} from 'recharts';
import clsx from 'clsx';
import { api, type ValuationBand, type ValuationBandKey } from '../lib/api';
import { fmtMoney, fmtDate, fmtPct } from '../lib/format';

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
  symbol, band, currency, height = 220,
}: {
  symbol: string;
  band: ValuationBand;
  currency?: string | null;
  height?: number;
}) {
  const { data: history } = useQuery({
    queryKey: ['marketHistory', symbol],
    queryFn: () => api.marketHistory(symbol),
    staleTime: 60 * 60_000,
    retry: 1,
  });

  const ccy = currency || '';
  const closes = (history ?? []).map((h) => h.close).filter((c) => c > 0);
  const lastPrice = closes.length ? closes[closes.length - 1] : band.fairValue;

  // Y-domain wraps both the price path and every zone edge so the shading is visible.
  const candidates = [...closes, band.entryTarget, band.fairValue, band.overvaluedAt, band.sellZoneAt, lastPrice];
  const lo = Math.min(...candidates) * 0.92;
  const hi = Math.max(...candidates) * 1.06;
  const data = (history ?? []).map((h) => ({ date: h.date, close: h.close }));

  const zone = (y1: number, y2: number, fill: string, opacity: number, key: string) => (
    <ReferenceArea key={key} y1={Math.max(y1, lo)} y2={Math.min(y2, hi)} fill={fill}
      fillOpacity={opacity} ifOverflow="hidden" stroke="none" />
  );

  return (
    <div>
      <div style={{ width: '100%', height }}>
        <ResponsiveContainer>
          <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
            {/* Zones, cheapest at the bottom. */}
            {zone(0, band.entryTarget, 'var(--gain)', 0.12, 'buy')}
            {zone(band.entryTarget, band.overvaluedAt, 'var(--azure)', 0.05, 'fair')}
            {zone(band.overvaluedAt, band.sellZoneAt, 'var(--warn)', 0.1, 'over')}
            {zone(band.sellZoneAt, hi * 2, 'var(--loss)', 0.13, 'sell')}
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--text-faint)' }}
              tickFormatter={(d) => fmtDate(d).replace(/ \d{4}$/, '')} minTickGap={48}
              stroke="var(--hairline)" />
            <YAxis domain={[lo, hi]} tick={{ fontSize: 10, fill: 'var(--text-faint)' }}
              width={52} stroke="var(--hairline)" tickFormatter={(v) => fmtMoney(v, ccy, false)} />
            <Tooltip
              contentStyle={{ background: 'var(--surface-2)', border: '1px solid var(--hairline)',
                borderRadius: 6, fontSize: 12 }}
              labelStyle={{ color: 'var(--text-faint)' }}
              formatter={(v: number) => [fmtMoney(v, ccy), 'Price']}
              labelFormatter={(d) => fmtDate(d as string)} />
            <ReferenceLine y={band.entryTarget} stroke="var(--gain)" strokeDasharray="4 3" strokeOpacity={0.8} />
            <ReferenceLine y={band.fairValue} stroke="var(--text-faint)" strokeDasharray="2 3" />
            <ReferenceLine y={band.sellZoneAt} stroke="var(--loss)" strokeDasharray="4 3" strokeOpacity={0.8} />
            <Line type="monotone" dataKey="close" stroke="var(--azure)" strokeWidth={1.6} dot={false}
              isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-text-faint">
        <LegendDot cls="bg-gain" label={`Buy ≤ ${fmtMoney(band.entryTarget, ccy)}`} />
        <LegendDot cls="bg-azure/40" label="Fair range" />
        <LegendDot cls="bg-warn" label={`Overvalued ≥ ${fmtMoney(band.overvaluedAt, ccy)}`} />
        <LegendDot cls="bg-loss" label={`Sell zone ≥ ${fmtMoney(band.sellZoneAt, ccy)}`} />
        <span className="ml-auto">
          fair value {fmtMoney(band.fairValue, ccy)} · MoS {fmtPct(band.marginOfSafetyPct, 0)}
        </span>
      </div>
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
