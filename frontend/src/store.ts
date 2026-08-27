import { create } from 'zustand';

export type View =
  | 'dashboard'
  | 'position'
  | 'scenarios'
  | 'advisory'
  | 'decisions'
  | 'research'
  | 'plans'
  | 'watchlist'
  | 'screener'
  | 'alerts';

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
  | { kind: 'timeline' }
  | { kind: 'recovery'; instrumentId: number }
  | { kind: 'create-plan'; sellInstrumentIds?: number[]; targets?: Array<{ symbol: string; name?: string; allocationPct: number }> }
  | { kind: 'plan-compare'; planId: number }
  | { kind: 'replay'; symbol: string; name?: string | null }
  | { kind: 'opportunity'; symbol: string; name?: string | null; price?: number | null; currency?: string | null }
  | null;

interface AppState {
  view: View;
  selectedInstrumentId: number | null;
  /** Symbol shown in the Research view — held in the store so it can be deep-linked. */
  researchSymbol: string | null;
  modal: ModalKind;
  preTax: boolean;
  benchmark: string;
  /** Instruments ticked for an ad-hoc basket comparison on the portfolio. */
  compareSelection: number[];

  setView: (v: View) => void;
  selectInstrument: (id: number) => void;
  setResearchSymbol: (s: string | null) => void;
  /** Jump straight to the Research view for a given symbol (deep-link friendly). */
  researchSymbolView: (s: string) => void;
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
  researchSymbol: null,
  modal: null,
  preTax: false,
  benchmark: 'VWRL.SW',
  compareSelection: [],

  setView: (view) => set({ view }),
  selectInstrument: (id) => set({ selectedInstrumentId: id, view: 'position' }),
  setResearchSymbol: (researchSymbol) => set({ researchSymbol }),
  researchSymbolView: (researchSymbol) => set({ researchSymbol, view: 'research' }),
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
