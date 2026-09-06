import { create } from 'zustand';
import type { ExportDoc } from './lib/exportDoc';

export type View =
  | 'dashboard'
  | 'position'
  | 'scenarios'
  | 'advisory'
  | 'decisions'
  | 'forecasts'
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
  | { kind: 'export'; context: 'portfolio' | 'position' | 'symbol'; instrumentId?: number; symbol?: string; name?: string | null }
  | { kind: 'compare'; instrumentIds: number[] }
  | { kind: 'cash-detail' }
  | { kind: 'timeline' }
  | { kind: 'recovery'; instrumentId: number }
  | { kind: 'create-plan'; sellInstrumentIds?: number[]; targets?: Array<{ symbol: string; name?: string; allocationPct: number }> }
  | { kind: 'plan-compare'; planId: number }
  | { kind: 'replay'; symbol: string; name?: string | null }
  | { kind: 'opportunity'; symbol: string; name?: string | null; price?: number | null; currency?: string | null }
  /** Preview a built document (PDF/Word) before downloading it. The doc travels by value:
   *  whoever opens the preview has already assembled the analysis it describes. */
  | { kind: 'doc-preview'; doc: ExportDoc }
  | null;

interface AppState {
  view: View;
  selectedInstrumentId: number | null;
  /** Symbol shown in the Research view — held in the store so it can be deep-linked. */
  researchSymbol: string | null;
  /** Recently-researched symbols (most-recent first), so the search landing can offer a
   *  one-click way back after "New search" or a Research nav click clears the current one. */
  researchRecents: string[];
  modal: ModalKind;
  preTax: boolean;
  benchmark: string;
  /** Instruments ticked for an ad-hoc basket comparison on the portfolio. */
  compareSelection: number[];
  /** Mobile navigation drawer open state (desktop sidebar is always visible). */
  navOpen: boolean;

  setView: (v: View) => void;
  selectInstrument: (id: number) => void;
  setResearchSymbol: (s: string | null) => void;
  /** Jump straight to the Research view for a given symbol (deep-link friendly). */
  researchSymbolView: (s: string) => void;
  /** Record a symbol as recently researched (dedup, most-recent first, capped). */
  pushResearchRecent: (s: string) => void;
  /** Open the Research view on its search landing (clears the current symbol but keeps
   *  the recents, so nothing is lost). Used by the sidebar "Research" nav item. */
  openResearchSearch: () => void;
  openModal: (m: ModalKind) => void;
  closeModal: () => void;
  setPreTax: (v: boolean) => void;
  setBenchmark: (s: string) => void;
  toggleCompare: (id: number) => void;
  clearCompare: () => void;
  setNavOpen: (v: boolean) => void;
}

export const useApp = create<AppState>((set) => ({
  view: 'dashboard',
  selectedInstrumentId: null,
  researchSymbol: null,
  researchRecents: [],
  modal: null,
  preTax: false,
  benchmark: 'VWRL.SW',
  compareSelection: [],
  navOpen: false,

  setView: (view) => set({ view }),
  setNavOpen: (navOpen) => set({ navOpen }),
  selectInstrument: (id) => set({ selectedInstrumentId: id, view: 'position' }),
  setResearchSymbol: (researchSymbol) => set({ researchSymbol }),
  researchSymbolView: (researchSymbol) => set({ researchSymbol, view: 'research' }),
  pushResearchRecent: (s) =>
    set((state) => ({
      researchRecents: [s, ...state.researchRecents.filter((x) => x !== s)].slice(0, 6),
    })),
  openResearchSearch: () => set({ view: 'research', researchSymbol: null }),
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

// Dev-only: expose the store so E2E tests (Playwright) can deep-link straight to a
// view/symbol without walking the whole UI. Stripped from production builds.
if (import.meta.env.DEV) {
  (window as unknown as { __app?: typeof useApp }).__app = useApp;
}
