import { useQuery } from '@tanstack/react-query';
import { Check, X, TrendingDown, TrendingUp, AlertTriangle } from 'lucide-react';
import { api, type Verdict } from '../lib/api';
import { Spinner } from './ui';
import { BandBadge, PriceBandChart } from './ValuationBand';
import { VerdictBadge, VerdictRationale } from './Verdict';
import { fmtPct, fmtMoney, priceFreshnessLabel } from '../lib/format';

const CONF_META: Record<string, { label: string; cls: string }> = {
  high: { label: 'High confidence', cls: 'text-gain' },
  medium: { label: 'Medium confidence', cls: 'text-warn' },
  low: { label: 'Low confidence', cls: 'text-loss' },
};

const MODEL_LABELS: Record<string, string> = {
  grahamNumber: 'Graham number',
  grahamGrowth: 'Graham (growth)',
  dcf: 'DCF · owner earnings',
};

/**
 * Value-investing verdict for a single stock: intrinsic-value range vs price, margin of
 * safety, the growth the price assumes, a Buffett quality scorecard, and — given the gap
 * to a benchmark — whether catching up is realistic. Estimates only, clearly caveated.
 */
export function ValueAnalysis({
  symbol,
  price,
  currency,
  catchUpPct,
  benchmarkSymbol,
  priceAsOf,
  priceFreshness,
  verdict,
}: {
  symbol: string;
  price: number | null;
  currency?: string | null;
  /** How far the stock must climb to draw level with the primary benchmark (fraction). */
  catchUpPct?: number | null;
  benchmarkSymbol?: string | null;
  /** Freshness of the resolved price, so the verdict can qualify a non-live price. */
  priceAsOf?: string | null;
  priceFreshness?: 'live' | 'delayed' | 'prev-close' | 'none' | null;
  /** Held-position verdict to show instead of the valuation-only one (same verdict key,
   *  but carries the benchmark conflict note) — passed by the per-position detail page. */
  verdict?: Verdict | null;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['valuation', symbol, price],
    queryFn: () => api.valuation(symbol, price, currency),
    staleTime: 60 * 60_000,
    retry: 1,
  });

  if (isLoading) return <Spinner label="Valuing the business…" />;
  if (isError || !data || !data.hasData) {
    return <p className="text-sm text-text-faint">Not enough fundamentals to value {symbol} yet.</p>;
  }

  const ccy = data.currency || currency || '';
  const px = data.price ?? price;
  // Qualify a non-live price ("prev close · <date>"). Caller-supplied freshness wins;
  // otherwise use whatever the server attached when it resolved the price itself.
  const freshLabel = priceFreshnessLabel(
    priceFreshness ?? data.priceFreshness,
    priceAsOf ?? data.priceAsOf,
  );
  const mid = data.intrinsic.mid;
  const mos = data.marginOfSafety; // + = undervalued vs models
  const overvalued = mos != null && mos < 0;

  const horizon = data.assumptions.years;
  const requiredCagr = catchUpPct != null && catchUpPct > 0 ? Math.pow(1 + catchUpPct, 1 / horizon) - 1 : null;
  const supportable = data.supportableReturn;
  const canCompete = requiredCagr != null ? supportable >= requiredCagr : null;

  const impliedDemanding =
    data.impliedGrowth != null && data.growthRaw != null && data.impliedGrowth > data.growthRaw + 0.02;
  const lowConf = data.confidence !== 'high';
  const conf = CONF_META[data.confidence] ?? CONF_META.low;
  // The one canonical verdict: a held-position verdict wins (it carries the benchmark
  // conflict note); otherwise the valuation-only verdict the endpoint attached.
  const rec = verdict ?? data.recommendation ?? null;

  return (
    <div className="space-y-5">
      {/* The unified verdict — same badge and rationale every surface renders. */}
      {rec && (
        <div className="card !p-4 flex items-start gap-3 flex-wrap">
          <VerdictBadge verdict={rec.verdict} confidence={rec.confidence} withIcon />
          <VerdictRationale verdict={rec} className="flex-1 min-w-[220px]" />
        </div>
      )}
      {/* Confidence + why the estimate may not be trustworthy */}
      <div className="flex items-center gap-2 text-[11px]">
        <span className="eyebrow">Estimate reliability</span>
        <span className={`font-medium ${conf.cls}`}>{conf.label}</span>
      </div>
      {data.flags.length > 0 && (
        <div className="card !p-3 border-l-2 border-l-warn bg-warn/5">
          <div className="flex items-start gap-2">
            <AlertTriangle size={15} className="text-warn shrink-0 mt-0.5" />
            <div className="text-[13px] text-text-muted space-y-1">
              <div className="font-medium text-text">Treat these numbers with caution</div>
              <ul className="list-disc pl-4 space-y-0.5">
                {data.flags.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
      {/* Verdict headline: intrinsic value vs price */}
      <div className="grid sm:grid-cols-[minmax(200px,1fr)_2fr] gap-5">
        <div className={`card !p-4 border-l-2 ${overvalued ? 'border-l-loss' : 'border-l-gain'}`}>
          <div className="flex items-center justify-between mb-1">
            <div className="eyebrow">Fair value (est.)</div>
            {data.band && <BandBadge band={data.band.band} />}
          </div>
          <div className="font-mono text-2xl font-semibold tnum">
            {mid != null ? fmtMoney(mid, ccy) : '—'}
          </div>
          {data.intrinsic.low != null && data.intrinsic.high != null && (
            <div className="text-[11px] text-text-faint mt-0.5">
              range {fmtMoney(data.intrinsic.low, ccy)} – {fmtMoney(data.intrinsic.high, ccy)}
            </div>
          )}
          {mos != null && (
            <div className={`mt-2 text-sm font-medium ${overvalued ? 'text-loss' : 'text-gain'}`}>
              {overvalued ? (
                <><TrendingDown size={14} className="inline mr-1" />Overvalued by {fmtPct(-mos, 1)}</>
              ) : (
                <><TrendingUp size={14} className="inline mr-1" />Margin of safety {fmtPct(mos, 1)}</>
              )}
              {lowConf && <span className="text-text-faint font-normal"> · indicative only</span>}
            </div>
          )}
          <div className="text-[11px] text-text-faint mt-1">
            at {px != null ? fmtMoney(px, ccy) : '—'} today
            {freshLabel && <span className="ml-1">· {freshLabel}</span>}
          </div>
          {data.entryTarget != null && (
            <div className="mt-2 pt-2 border-t border-hairline text-[12px] text-text-muted">
              Attractive entry price{' '}
              <span className="font-mono text-gain tnum">{fmtMoney(data.entryTarget, ccy)}</span>
              <span className="text-text-faint"> · fair value less a {fmtPct(data.band?.marginOfSafetyPct ?? 0, 0)} margin of safety</span>
            </div>
          )}
        </div>

        <div className="text-sm text-text-muted leading-relaxed">
          <div className="flex flex-wrap gap-x-5 gap-y-2 mb-3">
            {Object.entries(data.models).map(([k, v]) => (
              <div key={k}>
                <div className="eyebrow mb-0.5">{MODEL_LABELS[k] ?? k}</div>
                <div className="font-mono text-text tnum">{fmtMoney(v, ccy)}</div>
              </div>
            ))}
          </div>
          <p>
            At {px != null ? fmtMoney(px, ccy) : 'today’s price'} the market is pricing in about{' '}
            <span className={impliedDemanding ? 'text-loss' : 'text-text'}>
              {data.impliedGrowth != null ? `${fmtPct(data.impliedGrowth, 1)}/yr` : 'unclear'}
            </span>{' '}
            earnings growth, while the business has actually grown{' '}
            <span className="text-text">{data.growthRaw != null ? `${fmtPct(data.growthRaw, 1)}/yr` : 'n/a'}</span>.{' '}
            {impliedDemanding
              ? 'The price demands more growth than the company is delivering.'
              : 'The price is not demanding relative to its record.'}
          </p>
        </div>
      </div>

      {/* Price history with shaded buy / fair / overvalued / sell zones */}
      {data.band && (
        <div className="card !p-4">
          <div className="eyebrow mb-2">Price vs fair-value zones</div>
          <PriceBandChart symbol={symbol} band={data.band} currency={ccy} />
        </div>
      )}

      {/* Can it compete with the ETF? */}
      {requiredCagr != null && benchmarkSymbol && (
        <div className={`card !p-4 border-l-2 ${canCompete ? 'border-l-gain' : 'border-l-loss'}`}>
          <div className="eyebrow mb-1">Can {symbol} still catch {benchmarkSymbol}?</div>
          <p className="text-sm text-text-muted leading-relaxed">
            Just to draw level with {benchmarkSymbol} within {horizon} years, {symbol} would have to compound{' '}
            <span className="font-mono text-loss">+{fmtPct(requiredCagr, 1)}/yr</span>. Its fundamentals support
            roughly <span className="font-mono text-text">{fmtPct(supportable, 1)}/yr</span> (earnings growth +
            dividend).{' '}
            <span className={canCompete ? 'text-gain' : 'text-loss'}>
              {canCompete
                ? 'That is within reach — catching up is plausible.'
                : 'That is far beyond what the business is doing — on these numbers, catching up looks unrealistic.'}
            </span>
            {lowConf && (
              <span className="text-text-faint">
                {' '}Caveat: the fundamentals above are flagged low-confidence, so weigh this against a normalised
                earnings view before acting.
              </span>
            )}
          </p>
        </div>
      )}

      {/* Buffett quality scorecard */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="eyebrow">Quality scorecard · Buffett-style</div>
          <div className="text-sm font-mono tnum text-text">
            {data.quality.score}/{data.quality.max}
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
          {data.quality.checks.map((c) => (
            <div key={c.label} className="flex items-center gap-2 text-[13px]">
              {c.pass ? (
                <Check size={14} className="text-gain shrink-0" />
              ) : (
                <X size={14} className="text-loss shrink-0" />
              )}
              <span className={c.pass ? 'text-text-muted' : 'text-text-muted'}>{c.label}</span>
              <span className="ml-auto font-mono text-text-faint tnum">{c.detail}</span>
            </div>
          ))}
        </div>
      </div>

      <p className="text-[11px] text-text-faint">
        Estimates from cached fundamentals — DCF at {fmtPct(data.assumptions.discountRate, 0)} discount,{' '}
        {fmtPct(data.assumptions.terminalGrowth, 1)} terminal growth over {data.assumptions.years}y. A model, not
        advice; garbage-in applies if the inputs are stale.
      </p>
    </div>
  );
}
