import { useQuery } from '@tanstack/react-query';
import { Check, X, TrendingDown, TrendingUp, AlertTriangle } from 'lucide-react';
import { api, type Verdict } from '../lib/api';
import { Spinner, InfoTooltip } from './ui';
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
  dcf: 'DCF · earnings',
  fcf: 'DCF · free cash flow',
};

const RATING_CLS: Record<string, string> = {
  strong: 'text-gain', adequate: 'text-text', weak: 'text-loss', stretched: 'text-loss',
  high: 'text-loss', moderate: 'text-warn', low: 'text-gain', unknown: 'text-text-faint',
  'debt-free': 'text-gain', 'prefer-etf': 'text-warn',
};
const ratingCls = (r?: string | null) => RATING_CLS[r ?? 'unknown'] ?? 'text-text';

function Metric({ label, rating, detail }: { label: string; rating: string; detail: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-text-muted">{label}</span>
      <span className={`ml-auto font-medium capitalize ${ratingCls(rating)}`}>{rating}</span>
      <span className="font-mono text-text-faint tnum">{detail}</span>
    </div>
  );
}

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
  // Display currency (CHF): when an FX rate resolved, render every figure converted to the
  // base currency as the PRIMARY number, with the native value as a faint secondary — so
  // the price and the fair value are never shown in different currencies. When no rate
  // resolved, fall back to native for everything (never mixed). MoS is currency-invariant,
  // so multiplying every figure by the same rate preserves all relationships.
  const dc = data.displayCurrency ?? null;
  const fxRate = dc && dc.fxRate != null ? dc.fxRate : null;
  const dispCcy = fxRate != null ? dc!.code : ccy;
  const money = (v: number | null | undefined) =>
    v == null ? '—' : fmtMoney(fxRate != null ? v * fxRate : v, dispCcy);
  // When the security already trades in the display currency (e.g. a CHF-listed stock,
  // rate 1.0), the "converted" value equals the native one — don't show a redundant
  // secondary or an "FX CHF→CHF 1.0000" footer.
  const converting = fxRate != null && dispCcy !== ccy;
  const nativeSub = (v: number | null | undefined) =>
    converting && v != null ? fmtMoney(v, ccy) : null;
  const px = data.price ?? price;
  // Qualify a non-live price ("prev close · <date>"). Caller-supplied freshness wins;
  // otherwise use whatever the server attached when it resolved the price itself.
  const freshLabel = priceFreshnessLabel(
    priceFreshness ?? data.priceFreshness,
    priceAsOf ?? data.priceAsOf,
  );
  const mid = data.intrinsic.mid;
  const mos = data.marginOfSafety; // + = undervalued vs models (fair/price − 1)
  // The verdict WORD comes from the band's threshold zones; the number is stated factually so
  // the two can never contradict (a price 0–20% above fair is "Fairly valued", NOT "Overvalued
  // by X%"). The "above fair value" figure uses premiumToFair (price/fair − 1) — the same basis
  // the sell-signal panel and dashboard use — so the same holding never shows two different
  // overvaluation numbers across surfaces.
  const bandKey = data.band?.band ?? null;
  const premium = data.band?.premiumToFair ?? null; // +ve = price above fair value
  const isExpensive = bandKey === 'overvalued' || bandKey === 'significantly-overvalued';
  // A price below fair value always has a (real) margin of safety, even inside the fair band —
  // that is NOT a contradiction with a "Fairly valued" badge. The contradiction we fix is the
  // reverse: the text said "Overvalued by X%" whenever price was above fair, even when the band
  // (which needs +20%) still reads "fair". So the "overvalued" WORD appears only when the band
  // agrees; a price above fair but inside the fair band is stated neutrally.
  const showMoS = mos != null && mos > 0;
  const showOvervalued = mos != null && mos <= 0 && isExpensive;

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

  // ---- Area 2/3/4: the conservative Graham/Buffett engine's decision -------------------
  // `reliableValue === false` ⇒ NO RELIABLE FAIR VALUE: the engine abstained, so no fair
  // value, band, MoS or zone chart may be drawn — only the reason. Book/NAV is a distinct
  // framework (financials/REITs): 'below/near NAV', never a green 'undervalued'. The earnings
  // framework keeps intrinsic value, confidence and margin of safety as SEPARATE concepts.
  const reliable = data.reliableValue !== false; // default true for pre-Area-2 payloads
  const framework = data.valuationFramework ?? null;
  const bookNav = data.bookNav ?? null;
  const isBookNav = framework === 'book_nav' || bookNav != null;
  const ep = data.earningPower ?? null;
  const GROWTH_BASIS_LABEL: Record<string, string> = {
    none: 'no growth credited',
    supported: 'growth supported by the record',
    'high-capped': 'exceptional growth — capped, treat with caution',
  };
  // The dedicated "No reliable fair value" panel already states the reason, so drop the
  // duplicate engine flag from the generic caution list when we abstain.
  const shownFlags = reliable
    ? data.flags
    : data.flags.filter((f) => !f.startsWith('No reliable fair value'));

  return (
    <div className="space-y-5">
      {/* The unified verdict — same badge and rationale every surface renders. */}
      {rec && (
        <div className="card !p-4 flex items-start gap-3 flex-wrap">
          <VerdictBadge verdict={rec.verdict} action={rec.action} confidence={rec.confidence} withIcon />
          <VerdictRationale verdict={rec} className="flex-1 min-w-[220px]" />
        </div>
      )}
      {/* Confidence + why the estimate may not be trustworthy */}
      <div className="flex items-center gap-2 text-[11px]">
        <span className="eyebrow">Estimate reliability</span>
        <span className={`font-medium ${conf.cls}`}>{conf.label}</span>
      </div>
      {shownFlags.length > 0 && (
        <div className="card !p-3 border-l-2 border-l-warn bg-warn/5">
          <div className="flex items-start gap-2">
            <AlertTriangle size={15} className="text-warn shrink-0 mt-0.5" />
            <div className="text-[13px] text-text-muted space-y-1">
              <div className="font-medium text-text">Treat these numbers with caution</div>
              <ul className="list-disc pl-4 space-y-0.5">
                {shownFlags.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
      {/* NO RELIABLE FAIR VALUE — the conservative engine abstained rather than fake a
          number (cross-listing, no cash conversion, deep cyclical trough, corrupt book,
          too little profitable history). Show the reason; draw no fair value, band or chart. */}
      {!reliable && (
        <div className="card !p-4 border-l-2 border-l-warn bg-warn/5">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-warn shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="font-semibold text-text">No reliable fair value</div>
              <p className="text-[13px] text-text-muted leading-relaxed">
                We can’t stand behind an intrinsic value for {symbol} on the data we have
                {data.reliabilityReason ? <> — {data.reliabilityReason}</> : null}. Rather than
                fake a precise number, the engine abstains: there is no margin of safety to act
                on, so this is neither a buy nor a valuation-driven sell.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Book / NAV framework (financials & REITs): a discount to NAV is a starting point,
          not a green "undervalued". Surface the leverage / asset-mark caveat; never auto-buy. */}
      {reliable && isBookNav && bookNav && (
        <div className="card !p-4 border-l-2 border-l-hairline-strong">
          <div className="flex items-center justify-between mb-1">
            <div className="eyebrow">Net asset value (book)</div>
            {bookNav.priceToNav != null && (
              <span
                className={`text-[11px] font-medium ${bookNav.priceToNav < 1 ? 'text-text' : 'text-warn'}`}
              >
                {bookNav.priceToNav < 1 ? 'Below NAV' : bookNav.priceToNav > 1 ? 'Above NAV' : 'Near NAV'}
              </span>
            )}
          </div>
          <div className="font-mono text-2xl font-semibold tnum">
            {money(bookNav.navPerShare)}
            {nativeSub(bookNav.navPerShare) && (
              <span className="ml-2 text-sm font-normal text-text-faint">{nativeSub(bookNav.navPerShare)}</span>
            )}
            <span className="ml-2 text-sm font-normal text-text-faint">/ sh</span>
          </div>
          {bookNav.priceToNav != null && (
            <div className="text-[12px] text-text-muted mt-1">
              Price / NAV <span className="font-mono tnum">{bookNav.priceToNav.toFixed(2)}×</span> at{' '}
              {money(px)} today
            </div>
          )}
          <p className="text-[11px] text-text-faint mt-2 leading-relaxed">{bookNav.caveat}</p>
        </div>
      )}

      {/* Verdict headline: intrinsic value vs price (earnings framework, reliable only) */}
      {reliable && !isBookNav && (
      <div className="grid sm:grid-cols-[minmax(200px,1fr)_2fr] gap-5">
        <div className={`card !p-4 border-l-2 ${showOvervalued ? 'border-l-loss' : showMoS ? 'border-l-gain' : 'border-l-hairline-strong'}`}>
          <div className="flex items-center justify-between mb-1">
            <div className="eyebrow">Fair value (est.)</div>
            {data.band && <BandBadge band={data.band.band} />}
          </div>
          <div className="font-mono text-2xl font-semibold tnum">
            {money(mid)}
            {nativeSub(mid) && <span className="ml-2 text-sm font-normal text-text-faint">{nativeSub(mid)}</span>}
          </div>
          {data.intrinsic.low != null && data.intrinsic.high != null && (
            <div className="text-[11px] text-text-faint mt-0.5">
              range {money(data.intrinsic.low)} – {money(data.intrinsic.high)}
            </div>
          )}
          {mos != null && bandKey && (
            <div className={`mt-2 text-sm font-medium ${showOvervalued ? 'text-loss' : showMoS ? 'text-gain' : 'text-text-muted'}`}>
              {showMoS ? (
                <><TrendingUp size={14} className="inline mr-1" />Margin of safety {fmtPct(mos, 1)}</>
              ) : showOvervalued ? (
                <><TrendingDown size={14} className="inline mr-1" />Overvalued by {fmtPct(premium ?? 0, 1)}</>
              ) : (
                <>Trading {fmtPct(premium ?? 0, 1)} above fair value</>
              )}
              {lowConf && <span className="text-text-faint font-normal"> · indicative only</span>}
            </div>
          )}
          <div className="text-[11px] text-text-faint mt-1">
            at {money(px)} today
            {nativeSub(px) && <span className="ml-1 text-text-faint">({nativeSub(px)})</span>}
            {freshLabel && <span className="ml-1">· {freshLabel}</span>}
          </div>
          {data.entryTarget != null && (
            <div className="mt-2 pt-2 border-t border-hairline text-[12px] text-text-muted">
              Attractive entry price{' '}
              <span className="font-mono text-gain tnum">{money(data.entryTarget)}</span>
              <span className="text-text-faint"> · fair value less a {fmtPct(data.band?.marginOfSafetyPct ?? 0, 0)} margin of safety</span>
            </div>
          )}
          {converting && (
            <div className="text-[10px] text-text-faint mt-1">
              FX {ccy}→{dc!.code} {fxRate!.toFixed(4)}{dc!.fxAsOf ? ` · ${dc!.fxAsOf}` : ''}
            </div>
          )}
          {dc && dc.fxRate == null && ccy !== 'CHF' && (
            <div className="text-[10px] text-warn mt-1">CHF conversion unavailable — shown in {ccy}</div>
          )}
        </div>

        <div className="text-sm text-text-muted leading-relaxed">
          <div className="flex flex-wrap gap-x-5 gap-y-2 mb-3">
            {Object.entries(data.models).map(([k, v]) => (
              <div key={k}>
                <div className="eyebrow mb-0.5">{MODEL_LABELS[k] ?? k}</div>
                <div className="font-mono text-text tnum">{money(v)}</div>
              </div>
            ))}
          </div>
          <p>
            At {px != null ? money(px) : 'today’s price'} the market is pricing in about{' '}
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
      )}

      {/* Area 3/4: intrinsic value · confidence · margin of safety kept SEPARATE — never
          merged into one "Fair" label. The no-growth value is the conservative anchor; the
          fair value adds only justified growth; an assumption-sensitive discount is flagged
          "Not a conservative buy". */}
      {reliable && !isBookNav && ep && (
        <div className="card !p-4 space-y-3">
          <div className="eyebrow">Intrinsic value · confidence · margin of safety</div>
          <div className="grid sm:grid-cols-3 gap-4">
            <div>
              <div className="eyebrow mb-0.5">Intrinsic value · no growth</div>
              <div className="font-mono text-lg tnum text-text">{money(ep.noGrowthValue)}</div>
              <div className="text-[11px] text-text-faint mt-0.5">the conservative anchor</div>
            </div>
            <div>
              <div className="eyebrow mb-0.5">Margin of safety</div>
              <div className={`font-mono text-lg tnum ${showMoS ? 'text-gain' : showOvervalued ? 'text-loss' : 'text-text-muted'}`}>
                {mos != null ? fmtPct(mos, 1) : '—'}
              </div>
              <div className="text-[11px] text-text-faint mt-0.5">
                {showMoS ? 'discount to fair value' : 'no discount at today’s price'}
              </div>
            </div>
            <div>
              <div className="eyebrow mb-0.5">Confidence</div>
              <div className={`font-medium ${conf.cls}`}>{conf.label.replace(' confidence', '')}</div>
              <div className="text-[11px] text-text-faint mt-0.5">
                {ep.assumptionSensitive ? 'assumption-sensitive' : 'basis reliable'}
              </div>
            </div>
          </div>
          {/* The growth assumption, stated as an internal guardrail — never a Graham/Buffett rule */}
          <div className="pt-2 border-t border-hairline text-[12px] text-text-muted leading-relaxed">
            <span className="font-medium text-text">Growth assumed: {fmtPct(ep.growthAssumption, 1)}/yr</span>
            {' '}· {GROWTH_BASIS_LABEL[ep.growthBasis] ?? ep.growthBasis}. {ep.growthReason}
            <div className="text-[11px] text-text-faint mt-1">
              Earning power built on {ep.measure} of {money(ep.normalizedLevel)}/sh.
            </div>
          </div>
          {/* Sensitivity: does the credited growth move the verdict off the no-growth anchor? */}
          {ep.assumptionSensitive && (
            <div className="border-l-2 border-l-warn bg-warn/5 !p-3 rounded-r text-[12px]">
              <div className="font-medium text-warn mb-0.5">Not a conservative buy</div>
              <p className="text-text-muted leading-relaxed">
                The discount only appears once growth is credited — the fair value is
                assumption-sensitive, so this is held, not bought. Fair value at{' '}
                <span className="font-mono tnum">0%</span> {money(ep.sensitivity.at0)} ·{' '}
                <span className="font-mono tnum">{fmtPct(ep.growthAssumption, 0)}</span>{' '}
                {money(ep.sensitivity.atGrowth)} ·{' '}
                <span className="font-mono tnum">+3pp</span> {money(ep.sensitivity.atGrowthPlus)}.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Bear / base / bull valuation range — no single "magic" fair value (Engine 2.0) */}
      {data.scenarios && data.valuationRange && (
        <div className="card !p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="eyebrow">Valuation range · bear / base / bull</div>
            {data.valuationUncertainty && (
              <span
                className={`text-[11px] font-medium ${
                  data.valuationUncertainty === 'high'
                    ? 'text-loss'
                    : data.valuationUncertainty === 'moderate'
                      ? 'text-warn'
                      : 'text-gain'
                }`}
              >
                {data.valuationUncertainty} uncertainty
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            {(['bear', 'base', 'bull'] as const).map((k) => {
              const sc = data.scenarios![k];
              return (
                <div key={k}>
                  <div className="eyebrow mb-0.5 capitalize">{k}</div>
                  <div className="font-mono text-lg tnum text-text">
                    {sc.intrinsicValue != null ? money(sc.intrinsicValue) : '—'}
                  </div>
                  <div
                    className={`text-[11px] ${sc.marginOfSafety != null && sc.marginOfSafety >= 0 ? 'text-gain' : 'text-loss'}`}
                  >
                    {sc.marginOfSafety != null ? `${fmtPct(sc.marginOfSafety, 0)} MoS` : ''}
                  </div>
                  <div className="text-[10px] text-text-faint mt-0.5">
                    g {fmtPct(sc.assumptions.growth, 0)} · r {fmtPct(sc.assumptions.discountRate, 0)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Cash economics — owner earnings / free cash flow, not just accounting EPS */}
      {(data.ownerEarningsPerShare != null || data.fcfPerShare != null) && (
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {data.ownerEarningsPerShare != null && (
            <div>
              <div className="eyebrow mb-0.5">Owner earnings / sh</div>
              <div className="font-mono text-text tnum">{money(data.ownerEarningsPerShare)}</div>
            </div>
          )}
          {data.fcfPerShare != null && (
            <div>
              <div className="eyebrow mb-0.5">FCF / sh</div>
              <div className="font-mono text-text tnum">{money(data.fcfPerShare)}</div>
            </div>
          )}
          {data.fcfYield != null && (
            <div>
              <div className="eyebrow mb-0.5">FCF yield</div>
              <div className="font-mono text-text tnum">{fmtPct(data.fcfYield, 1)}</div>
            </div>
          )}
        </div>
      )}

      {/* Price history with shaded buy / fair / overvalued / sell zones. Never drawn for the
          book-NAV framework: a discount to NAV must not be painted as a green "buy" zone. */}
      {reliable && !isBookNav && data.band && (
        <div className="card !p-4">
          <div className="flex items-center gap-1.5 mb-2">
            <div className="eyebrow">Price vs fair-value zones</div>
            <InfoTooltip
              label="How to read this chart"
              text={
                <span className="space-y-1.5 block">
                  <span className="block">
                    The blue line is the share’s <b>market price</b> over time — not your holding’s value or what you paid.
                  </span>
                  <span className="block">
                    The shaded bands are the fair-value zones: <b className="text-gain">buy</b> (cheap) ·
                    {' '}fair · <b className="text-warn">overvalued</b> · <b className="text-loss">sell</b>. Where the
                    line sits tells you the verdict — today’s zones and fair value are exactly the estimate shown above,
                    so the current point never contradicts it.
                  </span>
                  <span className="block">
                    Earlier steps are rebuilt from each past annual report (the zones step when a new report lands). The
                    final step is today’s <b>live</b> estimate — it uses current earnings, so it can differ from the last
                    reported year.
                  </span>
                </span>
              }
            />
          </div>
          <PriceBandChart symbol={symbol} band={data.band} currency={ccy} rate={fxRate} displayCurrency={dc?.code ?? null} />
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

      {/* Business quality & financial strength — Buffett-grade, measurable-or-unknown */}
      {(data.qualityAssessment || data.financialStrength) && (
        <div className="card !p-4 space-y-2">
          <div className="eyebrow mb-1">Business quality & financial strength</div>
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 text-[13px]">
            {data.qualityAssessment && (
              <>
                <Metric
                  label="Return on invested capital"
                  rating={data.qualityAssessment.roic.rating}
                  detail={data.qualityAssessment.roic.value != null ? fmtPct(data.qualityAssessment.roic.value, 0) : 'n/a'}
                />
                <Metric
                  label="Cash conversion (FCF/NI)"
                  rating={data.qualityAssessment.fcfConversion.rating}
                  detail={data.qualityAssessment.fcfConversion.value != null ? fmtPct(data.qualityAssessment.fcfConversion.value, 0) : 'n/a'}
                />
                <Metric
                  label="Interest coverage"
                  rating={data.qualityAssessment.interestCoverage.rating}
                  detail={data.qualityAssessment.interestCoverage.value != null ? `${data.qualityAssessment.interestCoverage.value.toFixed(1)}×` : 'n/a'}
                />
                <Metric
                  label="Economic moat"
                  rating={data.qualityAssessment.moat.signal}
                  detail={data.qualityAssessment.moat.signal.replace('measurable-', '').replace('-', ' ')}
                />
              </>
            )}
            {data.financialStrength && (
              <Metric
                label="Balance sheet"
                rating={data.financialStrength.debtState}
                detail={
                  data.financialStrength.netDebtToEbitda != null
                    ? `net debt ${data.financialStrength.netDebtToEbitda.toFixed(1)}× EBITDA`
                    : data.financialStrength.debtState
                }
              />
            )}
          </div>
          {data.qualityAssessment?.moat.evidence?.length ? (
            <div className="text-[11px] text-text-faint">
              Moat signals: {data.qualityAssessment.moat.evidence.join(' · ')}
            </div>
          ) : null}
        </div>
      )}

      <p className="text-[11px] text-text-faint">
        Estimates from cached fundamentals — DCF at {fmtPct(data.assumptions.discountRate, 0)} discount,{' '}
        {fmtPct(data.assumptions.terminalGrowth, 1)} terminal growth over {data.assumptions.years}y. A model, not
        advice; garbage-in applies if the inputs are stale.
      </p>
    </div>
  );
}
