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

export function ModalHost() {
  const modal = useApp((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case 'compare':
      return <CompareModal instrumentIds={modal.instrumentIds} />;
    case 'cash-detail':
      return <CashDetailModal />;
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
    default:
      return null;
  }
}
