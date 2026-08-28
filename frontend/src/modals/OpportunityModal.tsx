import { ArrowUpRight, Clock, Share2 } from 'lucide-react';
import { useApp } from '../store';
import { Modal } from '../components/Modal';
import { ValueAnalysis } from '../components/ValueAnalysis';
import { ListingRecommendation } from '../components/ListingRecommendation';
import { PortfolioFit } from '../components/PortfolioFit';
import { researchHref } from '../lib/router';
import { yahooUrl, googleUrl, finanzenUrl } from '../lib/externalLinks';

/**
 * Opportunity detail — the fair-value read for a screened name without leaving Discover.
 * Reuses ValueAnalysis (fair value, band, attractive entry price, margin of safety, the
 * price-vs-fair-value zones and the Buffett quality scorecard). "Open in Research" leads
 * to the full workup; a clock opens the point-in-time replay.
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
  return (
    <Modal
      title={symbol}
      subtitle={name ?? 'Fair value & value-investing read'}
      onClose={closeModal}
      size="lg"
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
      <ValueAnalysis symbol={symbol} price={price ?? null} currency={currency} />

      {/* Does buying this fit the portfolio? Direct + indirect ETF exposure. */}
      <div className="mt-6 pt-5 border-t border-hairline">
        <PortfolioFit symbol={symbol} />
      </div>

      {/* Which exchange to actually buy — the right listing for a CHF portfolio. */}
      <div className="mt-6 pt-5 border-t border-hairline">
        <ListingRecommendation symbol={symbol} name={name} />
      </div>

      {/* Outbound research — hide a destination whose URL can't be built reliably. */}
      {(() => {
        const y = yahooUrl(symbol);
        const g = googleUrl(symbol);
        const f = finanzenUrl(symbol);
        if (!y && !g && !f) return null;
        return (
          <div className="mt-6 pt-5 border-t border-hairline">
            <p className="eyebrow mb-2">Want to learn more about this investment?</p>
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
                  Open in finanzen.net
                </a>
              )}
            </div>
          </div>
        );
      })()}
    </Modal>
  );
}
