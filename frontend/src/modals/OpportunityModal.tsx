import { useRef, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowUpRight, Building2, Clock, ExternalLink, Gem, PieChart, Radar, Share2,
} from 'lucide-react';
import { useApp } from '../store';
import { api } from '../lib/api';
import { Modal } from '../components/Modal';
import { SectionHeader } from '../components/ui';
import { ModalSectionRail } from '../components/ModalSectionRail';
import type { NavSection } from '../components/SectionNav';
import { ValueAnalysis } from '../components/ValueAnalysis';
import { ListingRecommendation } from '../components/ListingRecommendation';
import { PortfolioFit } from '../components/PortfolioFit';
import { MarketAnalysis } from '../components/MarketAnalysis';
import { VerdictBadge } from '../components/Verdict';
import { BandBadge } from '../components/ValuationBand';
import { researchHref } from '../lib/router';
import { yahooUrl, googleUrl, finanzenUrl } from '../lib/externalLinks';
import { fmtMoney, fmtPct } from '../lib/format';

/**
 * Opportunity detail — the full value-investing read for a single name without leaving the
 * current view. A sticky left rail lets the reader jump between the four chapters (verdict &
 * fair value, portfolio fit, market, listing) while a compact "at a glance" strip up top
 * carries the headline call. Every chapter reuses the app's SectionHeader so the eye learns
 * one rhythm; "Open Research" leads to the full workup and a clock opens the replay.
 */
export function OpportunityModal({
  symbol, name, price, currency,
}: {
  symbol: string;
  name?: string | null;
  price?: number | null;
  currency?: string | null;
}) {
  const { closeModal, openModal } = useApp();
  const bodyRef = useRef<HTMLDivElement>(null);

  // Shared with ValueAnalysis via the identical query key — the summary reads from cache,
  // so the hero costs no extra request.
  const { data: val } = useQuery({
    queryKey: ['valuation', symbol, price ?? null],
    queryFn: () => api.valuation(symbol, price ?? null, currency),
    staleTime: 60 * 60_000,
    retry: 1,
  });

  const g = googleUrl(symbol);
  const y = yahooUrl(symbol);
  const f = finanzenUrl(symbol);
  const hasLinks = !!(g || y || f);

  const sections: NavSection[] = [
    { id: 'op-verdict', label: 'Verdict & value', icon: Gem },
    { id: 'op-fit', label: 'Portfolio fit', icon: PieChart },
    { id: 'op-market', label: 'Market', icon: Radar },
    { id: 'op-listing', label: 'Where to buy', icon: Building2 },
  ];
  if (hasLinks) sections.push({ id: 'op-links', label: 'Research links', icon: ExternalLink });

  return (
    <Modal
      title={symbol}
      subtitle={name ?? 'Fair value & value-investing read'}
      onClose={closeModal}
      size="xl"
      bodyClassName="p-0"
      bodyRef={bodyRef}
      footer={
        <>
          <button className="btn-ghost mr-auto" onClick={() => openModal({ kind: 'replay', symbol, name })}>
            <Clock size={15} /> Point-in-time replay
          </button>
          <button className="btn-secondary" onClick={() => openModal({ kind: 'export', context: 'symbol', symbol, name })}>
            <Share2 size={15} /> Share
          </button>
          <button className="btn-secondary" onClick={closeModal}>Close</button>
          {/* Research is an addressable route — open the full workup in a new tab. */}
          <a
            className="btn-primary"
            href={researchHref(symbol)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ArrowUpRight size={15} /> Open Research
          </a>
        </>
      }
    >
      <div className="flex">
        <ModalSectionRail sections={sections} scrollRef={bodyRef} />

        <div className="flex-1 min-w-0 px-5 py-5 space-y-7">
          <OpportunitySummary data={val} price={price ?? null} currency={currency} />

          <section id="op-verdict" className="scroll-mt-5 space-y-4">
            <SectionHeader
              icon={Gem}
              title="Verdict & fair value"
              info="An intrinsic-value estimate versus today's price: fair-value range, margin of safety, the growth the price implies, and a Buffett-style quality scorecard. Estimates from cached fundamentals — a model, not advice."
            />
            <ValueAnalysis symbol={symbol} price={price ?? null} currency={currency} />
          </section>

          {/* Does buying this fit the portfolio? Direct + indirect ETF exposure. */}
          <section id="op-fit" className="scroll-mt-5 space-y-4 border-t border-hairline pt-6">
            <SectionHeader
              icon={PieChart}
              title="Portfolio fit"
              info="How much of this company you already hold — directly and through your ETFs — and whether adding it would diversify or concentrate your portfolio."
            />
            <PortfolioFit symbol={symbol} hideEyebrow />
          </section>

          {/* Market analysis — sector, competitors & relative performance. */}
          <section id="op-market" className="scroll-mt-5 space-y-4 border-t border-hairline pt-6">
            <SectionHeader
              icon={Radar}
              title="Market analysis"
              info="How the stock has done against its sector and closest peers, a comparables table ranked by size, and the opportunity-cost read versus its valuation."
            />
            <MarketAnalysis symbol={symbol} />
          </section>

          {/* Which exchange to actually buy — the right listing for a CHF portfolio. */}
          <section id="op-listing" className="scroll-mt-5 space-y-4 border-t border-hairline pt-6">
            <SectionHeader
              icon={Building2}
              title="Where to buy"
              info="Which exchange listing fits a CHF portfolio best, and the other listings alongside it so you don't buy the wrong line."
            />
            <ListingRecommendation symbol={symbol} name={name} />
          </section>

          {/* Outbound research — the section only exists when a destination can be built. */}
          {hasLinks && (
            <section id="op-links" className="scroll-mt-5 space-y-3 border-t border-hairline pt-6">
              <SectionHeader
                icon={ExternalLink}
                title="Research links"
                info="Open this name on external finance sites for deeper research."
              />
              <div className="flex gap-2 flex-wrap">
                {g && (
                  <a className="btn-secondary" href={g} target="_blank" rel="noopener noreferrer">
                    Open in Google Finance
                  </a>
                )}
                {y && (
                  <a className="btn-secondary" href={y} target="_blank" rel="noopener noreferrer">
                    Open in Yahoo Finance
                  </a>
                )}
                {f && (
                  <a className="btn-secondary" href={f} target="_blank" rel="noopener noreferrer">
                    Open in finanzen.ch
                  </a>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * "At a glance" — the headline call up top so the reader never has to hunt for it: verdict,
 * fair value with its band, margin of safety, and today's price. Reads from the shared
 * valuation cache; renders nothing until there's a real read to show (the verdict chapter
 * below still explains the loading/empty state in full).
 */
function OpportunitySummary({
  data, price, currency,
}: {
  data: Awaited<ReturnType<typeof api.valuation>> | undefined;
  price: number | null;
  currency?: string | null;
}) {
  if (!data || !data.hasData) return null;

  const dc = data.displayCurrency ?? null;
  const fxRate = dc && dc.fxRate != null ? dc.fxRate : null;
  const ccy = data.currency || currency || '';
  const dispCcy = fxRate != null ? dc!.code : ccy;
  const money = (v: number | null | undefined) =>
    v == null ? '—' : fmtMoney(fxRate != null ? v * fxRate : v, dispCcy);

  const mid = data.intrinsic.mid;
  const mos = data.marginOfSafety;
  const overvalued = mos != null && mos < 0;
  const px = data.price ?? price ?? null;
  const rec = data.recommendation ?? null;

  return (
    <div className="card !p-4 flex flex-wrap items-center gap-x-7 gap-y-4">
      {rec && (
        <div className="shrink-0">
          <VerdictBadge verdict={rec.verdict} action={rec.action} confidence={rec.confidence} withIcon />
        </div>
      )}
      <HeroStat label="Fair value" value={money(mid)} extra={data.band && <BandBadge band={data.band.band} />} />
      {mos != null && (
        <HeroStat
          label={overvalued ? 'Overvalued by' : 'Margin of safety'}
          value={fmtPct(overvalued ? -mos : mos, 1)}
          valueClass={overvalued ? 'text-loss' : 'text-gain'}
        />
      )}
      <HeroStat label="Price today" value={money(px)} />
    </div>
  );
}

function HeroStat({
  label, value, valueClass, extra,
}: {
  label: string;
  value: ReactNode;
  valueClass?: string;
  extra?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="eyebrow mb-1.5">{label}</div>
      <div className="flex items-center gap-2">
        <span className={clsx('font-mono text-xl font-semibold tnum leading-none', valueClass)}>{value}</span>
        {extra}
      </div>
    </div>
  );
}
