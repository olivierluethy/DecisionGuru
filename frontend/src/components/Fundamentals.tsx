import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../lib/api';
import { Stat, Spinner, MiniBar, Skeleton } from './ui';
import { fmtPct, fmtNum } from '../lib/format';

/** Compact currency-scaled number: 250.3B / 41.2M / 1'234. */
function big(v: number | null | undefined, ccy = ''): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const s = a >= 1e12 ? `${(v / 1e12).toFixed(2)}T` : a >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : fmtNum(v);
  return ccy ? `${ccy} ${s}` : s;
}
function ratio(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(1);
}
/** yfinance is inconsistent about dividendYield (fraction vs already-%) — normalise. */
function yieldPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return fmtPct(v > 1 ? v / 100 : v, 2);
}

/** Faint uppercase group label that segments the metric sheet into readable chapters. */
function GroupLabel({ children }: { children: ReactNode }) {
  return <div className="eyebrow text-text-faint mb-2.5">{children}</div>;
}

/**
 * A ratio/margin shown as a labelled horizontal bar — the value stays exact and
 * legible while the bar makes it instantly comparable to its siblings. `value`
 * is a fraction (0.23 → “23.0%”); the bar is scaled against `max` (default 100%).
 */
function MarginRow({
  label,
  value,
  sub,
  max = 1,
  barClass = 'bg-gain',
}: {
  label: string;
  value: number | null | undefined;
  sub?: string;
  max?: number;
  barClass?: string;
}) {
  const has = value != null && Number.isFinite(value);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-text-muted">{label}</span>
        <span className="font-mono text-sm tnum text-text">
          {has ? fmtPct(value, 1) : '—'}
          {sub && <span className="text-text-faint ml-1.5 text-[11px]">{sub}</span>}
        </span>
      </div>
      <MiniBar value={has ? Math.max(0, value) : 0} max={max} barClass={has ? barClass : 'bg-hairline'} className="mt-1.5" />
    </div>
  );
}

export function Fundamentals({
  symbol,
  domicile,
  name,
  currency,
}: {
  symbol: string;
  domicile?: string | null;
  name?: string | null;
  currency?: string | null;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['fundamentals', symbol],
    queryFn: () => api.fundamentals(symbol, domicile, name),
    staleTime: 60 * 60_000,
    retry: 1,
  });

  if (isLoading) {
    return (
      <div className="space-y-5">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-6 w-24" />
            </div>
          ))}
        </div>
        <Spinner label="Loading fundamentals… (first fetch can take a moment)" />
      </div>
    );
  }
  const snap = data?.snapshot;
  if (isError || !snap) {
    return (
      <p className="text-sm text-text-faint">
        No fundamentals available for {symbol} yet — the first fetch pulls them from the provider and
        caches; try again in a moment.
      </p>
    );
  }
  const ccy = data?.financialCurrency || currency || '';
  const iw = data?.indexWeight;
  const hist = (data?.history ?? []).slice(-5);
  const peakRev = Math.max(...hist.map((h) => h.revenue ?? 0), 1);

  return (
    <div className="space-y-6">
      {/* Identity + index weight */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm text-text">
            {snap.sector ?? '—'}
            {snap.industry ? <span className="text-text-faint"> · {snap.industry}</span> : null}
          </div>
          {snap.country && <div className="text-[11px] text-text-faint mt-0.5">{snap.country}</div>}
        </div>
        {iw && iw.weightPct != null && (
          <div className="text-right rounded border border-gold/25 bg-gold/5 px-3 py-2">
            <div className="eyebrow mb-0.5 text-gold/70">Weight in {iw.index}</div>
            <div className="font-mono text-2xl font-semibold tnum text-gold">{fmtPct(iw.weightPct, 2)}</div>
            <div className="text-[10px] text-text-faint">via {iw.etf}</div>
          </div>
        )}
      </div>

      {/* Valuation grid */}
      <div>
        <GroupLabel>Valuation</GroupLabel>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-3">
          <Stat label="Market cap" value={big(snap.marketCap, ccy)} />
          <Stat label="P/E (trailing)" value={ratio(snap.trailingPE)} sub={snap.forwardPE != null ? `fwd ${ratio(snap.forwardPE)}` : undefined} />
          <Stat label="Price / book" value={ratio(snap.priceToBook)} />
          <Stat label="Price / sales" value={ratio(snap.priceToSales)} />
          <Stat label="Dividend yield" value={yieldPct(snap.dividendYield)} sub={snap.payoutRatio != null ? `payout ${fmtPct(snap.payoutRatio, 2)}` : undefined} />
          <Stat label="EPS (trailing)" value={snap.trailingEps != null ? `${ccy} ${fmtNum(snap.trailingEps)}` : '—'} />
          <Stat label="Revenue (ttm)" value={big(snap.totalRevenue, ccy)} sub={snap.revenueGrowth != null ? `${fmtPct(snap.revenueGrowth, 2)} YoY` : undefined} />
          <Stat label="Beta" value={ratio(snap.beta)} />
        </div>
      </div>

      {/* Profitability — margins & returns as comparable bars */}
      <div>
        <GroupLabel>Profitability</GroupLabel>
        <div className="grid sm:grid-cols-2 gap-x-8 gap-y-3.5">
          <MarginRow label="Gross margin" value={snap.grossMargins} barClass="bg-gain" />
          <MarginRow label="Operating margin" value={snap.operatingMargins} barClass="bg-gain" />
          <MarginRow label="Net margin" value={snap.profitMargins} barClass="bg-azure" />
          {/* ROE can run past 100%; scale the bar to 1.0 and let the exact figure carry the rest. */}
          <MarginRow label="Return on equity" value={snap.returnOnEquity} barClass="bg-azure" />
        </div>
      </div>

      {/* Multi-year income statement */}
      {hist.length > 1 && (
        <div>
          <GroupLabel>Revenue &amp; net margin · last {hist.length} years</GroupLabel>
          <div className="flex items-end gap-3">
            {hist.map((h, i) => {
              const latest = i === hist.length - 1;
              return (
                <div key={h.year} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                  <div className={`text-[10px] tnum ${latest ? 'text-gain' : 'text-text-faint'}`}>
                    {h.netMargin != null ? fmtPct(h.netMargin, 1) : '—'}
                  </div>
                  <div className="w-full h-24 flex items-end">
                    <div
                      className={`w-full rounded-t transition-all ${latest ? 'bg-gradient-to-t from-azure/40 to-azure' : 'bg-azure/45'}`}
                      style={{ height: `${Math.max(3, ((h.revenue ?? 0) / peakRev) * 100)}%` }}
                      title={`Revenue ${big(h.revenue, ccy)} · net income ${big(h.netIncome, ccy)}`}
                    />
                  </div>
                  <div className={`text-[11px] font-mono tnum ${latest ? 'text-text' : 'text-text-muted'}`}>{big(h.revenue)}</div>
                  <div className="text-[10px] text-text-faint tnum">{h.year}</div>
                </div>
              );
            })}
          </div>
          <div className="text-[10px] text-text-faint mt-2">
            Bar height = revenue ({ccy}); figure above = net margin that year. Hover for net income.
          </div>
        </div>
      )}

      {/* Analyst view + business summary */}
      {(snap.recommendationKey || snap.targetMeanPrice != null) && (
        <div className="flex flex-wrap items-center gap-4 text-sm border-t border-hairline pt-4">
          {snap.recommendationKey && (
            <span>
              <span className="text-text-faint">Analyst consensus </span>
              <span className="text-text capitalize">{snap.recommendationKey.replace(/_/g, ' ')}</span>
            </span>
          )}
          {snap.targetMeanPrice != null && (
            <span>
              <span className="text-text-faint">Mean target </span>
              <span className="font-mono text-text">{ccy} {fmtNum(snap.targetMeanPrice)}</span>
              {snap.numberOfAnalystOpinions != null && (
                <span className="text-text-faint"> ({snap.numberOfAnalystOpinions} analysts)</span>
              )}
            </span>
          )}
        </div>
      )}
      {snap.longBusinessSummary && (
        <p className="text-[13px] text-text-muted leading-relaxed max-w-4xl">{snap.longBusinessSummary}</p>
      )}
      {iw && iw.weightPct == null && (
        <p className="text-[11px] text-text-faint">Not among the SMI’s top holdings.</p>
      )}
    </div>
  );
}
