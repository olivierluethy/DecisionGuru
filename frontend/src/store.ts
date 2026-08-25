import { create } from 'zustand';

export type View = 'dashboard' | 'position' | 'scenarios';

export type ModalKind =
  | { kind: 'import' }
  | { kind: 'manual-add' }
  | { kind: 'add-transaction'; instrumentId: number }
  | { kind: 'edit-instrument'; instrumentId: number }
  | { kind: 'settings' }
  | { kind: 'scenario'; scenarioId?: number }
  | { kind: 'export'; context: 'portfolio' | 'position'; instrumentId?: number }
  | null;

interface AppState {
  view: View;
  selectedInstrumentId: number | null;
  modal: ModalKind;
  preTax: boolean;
  benchmark: string;

  setView: (v: View) => void;
  selectInstrument: (id: number) => void;
  openModal: (m: ModalKind) => void;
  closeModal: () => void;
  setPreTax: (v: boolean) => void;
  setBenchmark: (s: string) => void;
}

export const useApp = create<AppState>((set) => ({
  view: 'dashboard',
  selectedInstrumentId: null,
  modal: null,
  preTax: false,
  benchmark: 'VWRL.SW',

  setView: (view) => set({ view }),
  selectInstrument: (id) => set({ selectedInstrumentId: id, view: 'position' }),
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),
  setPreTax: (preTax) => set({ preTax }),
  setBenchmark: (benchmark) => set({ benchmark }),
}));
