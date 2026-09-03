import type { RefObject } from 'react';
import clsx from 'clsx';
import { TrendingUp, TrendingDown, Scale, AlertTriangle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { MarketPosition as MarketPositionData, MarketQuadrant } from '../lib/api';
import { MarketScatter, type MarketScatterPoint } from './MarketScatter';
import { MiniBar } from './ui';
import { useApp } from '../store';

/**
 * Market position — the answer to "is another company in this market the better bet?".
 *
 * Value alone can call a company attractive while every competitor compounds faster; that
 * is how you end up holding the cheap laggard. This card puts both axes side by side as
 * percentiles inside the company's own market, names the corner it sits in, and — when
 * they exist — names the peers that beat it on BOTH axes. It states the finding; it never
 * tells anyone what to buy.
 *
 * The plane itself lives in MarketScatter; this card only frames it. Hover state is owned
 * one level up in MarketAnalysis so the comparables table, this chart and the floating
 * mini-map all point at the same company at the same time.
 */

const QUADRANTS: Record<MarketQuadrant, {
  label: string; tone: string; border: string; icon: LucideIcon; blurb: string;
}> = {
  'cheap-and-leading': {
    label: 'Cheap and leading', tone: 'text-gain', border: 'border-l-gain', icon: TrendingUp,
    blurb: 'Attractively valued for this market and growing faster than the median company in it — the value read and the market read agree.',
  },
  'cheap-but-lagging': {
    label: 'Cheap, but lagging its market', tone: 'text-warn', border: 'border-l-warn', icon: AlertTriangle,
    blurb: 'Attractively valued, yet competitors in the same market are compounding faster. Cheap can mean cheap for a reason — the discount may be the market pricing a company that is falling behind.',
  },
  'expensive-but-leading': {
    label: 'Leading, but richly priced', tone: 'text-azure', border: 'border-l-azure', icon: Scale,
    blurb: 'Growing faster than the median company here, but priced above it too — you are paying up for the lead rather than being handed it.',
  },
  'expensive-and-lagging': {
    label: 'Expensive and lagging', tone: 'text-loss', border: 'border-l-loss', icon: TrendingDown,
    blurb: 'Priced above the median company in this market while growing slower than it — both reads point the same way.',
  },
};

const VALUE_BASIS: Record<string, string> = {
  'margin-of-safety': 'margin of safety vs. estimated fair value',
  'earnings-yield': 'earnings yield (E/P) — no fair value derivable for most of this market',
  'book-yield': 'book yield (B/P) — neither fair value nor earnings available for most of this market',
};

export function MarketPosition({
  position, points, range, active, onActiveChange, chartRef,
}: {
  position: MarketPositionData;
  /** Plotted companies, derived once by the parent and shared with the mini-map. */
  points: MarketScatterPoint[];
  range: string;
  /** Symbol currently pointed at, from anywhere in the section. */
  active: string | null;
  onActiveChange: (symbol: string | null) => void;
  /** Observed by the parent to know when this chart has scrolled out of view. */
  chartRef?: RefObject<HTMLDivElement>;
}) {
  const openModal = useApp((s) => s.openModal);
  const q = position.quadrant ? QUADRANTS[position.quadrant] : null;
  const Icon = q?.icon;

  return (
    <div className={`card !p-4 border-l-2 ${q ? q.border : 'border-l-hairline'}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="eyebrow mb-1">Market position · value × strength</div>
          {q && Icon ? (
            <div className={`font-semibold flex items-center gap-2 ${q.tone}`}>
              <Icon size={16} /> {q.label}
            </div>
          ) : (
            <div className="font-semibold text-text-muted">Not enough data to place this company</div>
          )}
          {position.rank != null && (
            <p className="text-sm text-text-muted mt-1">
              Ranked <span className="text-text font-mono tnum">#{position.rank}</span> of{' '}
              <span className="font-mono tnum">{position.of}</span> companies in its market over {range}.
            </p>
          )}
          {q && <p className="text-sm text-text-muted mt-1 max-w-[62ch]">{q.blurb}</p>}
        </div>

        {/* The two axes as plain meters — the numbers the corner label is derived from. */}
        <div className="w-[190px] shrink-0 space-y-2.5">
          <AxisMeter label="Value" pct={position.valuePct} barClass="bg-azure" />
          <AxisMeter label="Market strength" pct={position.strengthPct} barClass="bg-gold" />
        </div>
      </div>

      {/* Where everyone in this market sits. Quadrants are split at the market median (50). */}
      {points.length > 2 && (
        <div ref={chartRef} className="mt-4">
          <div style={{ width: '100%', height: 200 }}>
            <MarketScatter
              points={points}
              active={active}
              onActiveChange={onActiveChange}
              onOpen={(p) => openModal({ kind: 'opportunity', symbol: p.symbol, name: p.name })}
              variant="full"
            />
          </div>
          <p className="text-[11px] text-text-faint mt-1">
            Each dot is a company in this market; azure is this one. Top-right is cheap and strong,
            top-left cheap but lagging. Hover a row in the comparables table below to find that
            company here — and hover a dot to find its row. Click a dot to open it.
          </p>
        </div>
      )}

      {/* The peers that beat this company on BOTH axes — the only unambiguous "better positioned". */}
      {position.strongerAlternatives.length > 0 && (
        <div className="mt-4 pt-3 border-t border-hairline">
          <div className="eyebrow mb-2">Better positioned on both axes</div>
          <div className="flex flex-wrap gap-2">
            {position.strongerAlternatives.map((a) => (
              <button
                key={a.symbol}
                type="button"
                onClick={() => openModal({ kind: 'opportunity', symbol: a.symbol, name: a.name, currency: a.currency })}
                onMouseEnter={() => onActiveChange(a.symbol)}
                onMouseLeave={() => onActiveChange(null)}
                className={clsx(
                  'chip cursor-pointer transition-colors duration-150 motion-reduce:transition-none',
                  active === a.symbol
                    ? '!border-gold/60 !text-text bg-gold/10'
                    : 'hover:border-hairline-strong',
                )}
                title={`Open ${a.symbol}`}
              >
                <span className="font-mono text-text">{a.symbol}</span>
                {a.name && <span className="text-text-faint truncate max-w-[140px]">{a.name}</span>}
                <span className="text-text-muted tnum">
                  V {a.valuePct?.toFixed(0)} · S {a.strengthPct?.toFixed(0)}
                </span>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-text-faint mt-2">
            Cheaper <em>and</em> stronger than this company over {range}. A finding, not a recommendation.
          </p>
        </div>
      )}

      <p className="text-[11px] text-text-faint mt-3">
        Percentiles are ranks inside this market ({position.of} scored companies), not absolute
        scores. Strength = {Math.round(position.basis.weights.return * 100)}% {range} price return,{' '}
        {Math.round(position.basis.weights.revenueGrowth * 100)}% revenue growth,{' '}
        {Math.round(position.basis.weights.profitMargins * 100)}% net margin.
        {position.basis.valueBasis && <> Value = {VALUE_BASIS[position.basis.valueBasis]}.</>}
      </p>
    </div>
  );
}

function AxisMeter({ label, pct, barClass }: { label: string; pct: number | null; barClass: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="eyebrow">{label}</span>
        <span className="font-mono tnum text-sm text-text">
          {pct == null ? '—' : `${pct.toFixed(0)}`}
          <span className="text-text-faint text-[11px]">/100</span>
        </span>
      </div>
      <MiniBar value={pct ?? 0} max={100} barClass={barClass} className="mt-1" />
    </div>
  );
}
