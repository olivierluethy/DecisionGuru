import { Suspense, lazy } from 'react';
import { useApp } from '../store';
import { ImportModal } from './ImportModal';
import { ManualAddModal } from './ManualAddModal';
import { AddTransactionModal } from './AddTransactionModal';
import { EditInstrumentModal } from './EditInstrumentModal';
import { SettingsModal } from './SettingsModal';
import { CompareModal } from './CompareModal';
import { CashDetailModal } from './CashDetailModal';
import { RecoveryModal } from './RecoveryModal';
import { CreatePlanModal } from './CreatePlanModal';
import { TimelineModal } from './TimelineModal';
import { ReplayModal } from './ReplayModal';
import { OpportunityModal } from './OpportunityModal';
import { ShareModal } from './ShareModal';
/* pdf.js and docx-preview together weigh more than the rest of the app. Loading them only
   when a preview is actually opened keeps them out of the initial bundle entirely. */
const DocumentPreviewModal = lazy(() =>
  import('./DocumentPreviewModal').then((m) => ({ default: m.DocumentPreviewModal })));

export function ModalHost() {
  const modal = useApp((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case 'compare':
      return <CompareModal instrumentIds={modal.instrumentIds} />;
    case 'cash-detail':
      return <CashDetailModal />;
    case 'timeline':
      return <TimelineModal />;
    case 'import':
      return <ImportModal />;
    case 'manual-add':
      return <ManualAddModal />;
    case 'add-transaction':
      return <AddTransactionModal instrumentId={modal.instrumentId} />;
    case 'edit-instrument':
      return <EditInstrumentModal instrumentId={modal.instrumentId} />;
    case 'settings':
      return <SettingsModal />;
    case 'recovery':
      return <RecoveryModal instrumentId={modal.instrumentId} />;
    case 'create-plan':
      return <CreatePlanModal sellInstrumentIds={modal.sellInstrumentIds} targets={modal.targets} />;
    case 'replay':
      return <ReplayModal symbol={modal.symbol} name={modal.name} />;
    case 'opportunity':
      return <OpportunityModal symbol={modal.symbol} name={modal.name} price={modal.price} currency={modal.currency} />;
    case 'doc-preview':
      return (
        <Suspense fallback={<PreviewLoading />}>
          <DocumentPreviewModal doc={modal.doc} />
        </Suspense>
      );
    case 'export':
      return <ShareModal context={modal.context} instrumentId={modal.instrumentId} symbol={modal.symbol} name={modal.name} />;
    default:
      return null;
  }
}

/** Holds the screen while the viewer chunk arrives — the modal shell is part of that chunk,
 *  so this is a bare overlay rather than a Modal. */
function PreviewLoading() {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(6,9,14,0.66)] backdrop-blur-[2px]">
      <span className="text-sm text-text-muted">Loading the document viewer…</span>
    </div>
  );
}
