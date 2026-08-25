import { create } from 'zustand';

export type View = 'dashboard' | 'position' | 'scenarios' | 'advisory';

export type ModalKind =
  | { kind: 'import' }
  | { kind: 'manual-add' }
  | { kind: 'add-transaction'; instrumentId: number }
  | { kind: 'edit-instrument'; instrumentId: number }
  | { kind: 'settings' }
  | { kind: 'scenario'; scenarioId?: number }
  | { kind: 'export'; context: 'portfolio' | 'position'; instrumentId?: number }
  | { kind: 'compare'; instrumentIds: number[] }
  | { kind: 'cash-detail' }
  | null;

interface AppState {
  view: View;
  selectedInstrumentId: number | null;
  modal: ModalKind;
  preTax: boolean;
  benchmark: string;
  /** Instruments ticked for an ad-hoc basket comparison on the portfolio. */
  compareSelection: number[];

  setView: (v: View) => void;
  selectInstrument: (id: number) => void;
  openModal: (m: ModalKind) => void;
  closeModal: () => void;
  setPreTax: (v: boolean) => void;
  setBenchmark: (s: string) => void;
  toggleCompare: (id: number) => void;
  clearCompare: () => void;
}

export const useApp = create<AppState>((set) => ({
  view: 'dashboard',
  selectedInstrumentId: null,
  modal: null,
  preTax: false,
  benchmark: 'VWRL.SW',
  compareSelection: [],

  setView: (view) => set({ view }),
  selectInstrument: (id) => set({ selectedInstrumentId: id, view: 'position' }),
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),
  setPreTax: (preTax) => set({ preTax }),
  setBenchmark: (benchmark) => set({ benchmark }),
  toggleCompare: (id) =>
    set((s) => ({
      compareSelection: s.compareSelection.includes(id)
        ? s.compareSelection.filter((x) => x !== id)
        : [...s.compareSelection, id],
    })),
  clearCompare: () => set({ compareSelection: [] }),
}));
