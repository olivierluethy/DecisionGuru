import { ArrowUpRight, Clock } from 'lucide-react';
import { useApp } from '../store';
import { Modal } from '../components/Modal';
import { ValueAnalysis } from '../components/ValueAnalysis';

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
  const { closeModal, researchSymbolView, openModal } = useApp();
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
          <button className="btn-secondary" onClick={closeModal}>Close</button>
          <button className="btn-primary" onClick={() => { closeModal(); researchSymbolView(symbol); }}>
            <ArrowUpRight size={15} /> Open in Research
          </button>
        </>
      }
    >
      <ValueAnalysis symbol={symbol} price={price ?? null} currency={currency} />
    </Modal>
  );
}
