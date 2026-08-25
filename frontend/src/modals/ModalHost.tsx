import { useApp } from '../store';
import { ImportModal } from './ImportModal';
import { ManualAddModal } from './ManualAddModal';
import { AddTransactionModal } from './AddTransactionModal';
import { EditInstrumentModal } from './EditInstrumentModal';
import { SettingsModal } from './SettingsModal';

export function ModalHost() {
  const modal = useApp((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
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
    default:
      return null;
  }
}
