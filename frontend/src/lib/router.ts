// Hash-based deep-linking for DecisionGuru.
//
// The Zustand store stays the single source of truth for navigation. This module
// binds the URL hash to that store two-way:
//   store change  → hash (history.pushState)
//   hash change   → store (back/forward, manual edit, opening a shared link)
//
// Hash routing is deliberate: it needs no server rewrite rules, survives a refresh
// on any static host, carries no hardcoded host/port, and reconstructs the full
// view when a link is opened in a fresh tab or on another device (stories 4/5/6).

import { useApp, type View } from '../store';

type Parsed = {
  view: View;
  selectedInstrumentId?: number | null;
  researchSymbol?: string | null;
};

// Views that map to a bare path segment (no entity id/symbol in the URL).
const SIMPLE_PATHS: Record<Exclude<View, 'position' | 'research' | 'dashboard'>, string> = {
  scenarios: 'scenarios',
  advisory: 'advisory',
  decisions: 'decisions',
  plans: 'plans',
  watchlist: 'watchlist',
  screener: 'screener',
  alerts: 'alerts',
};

/** Build the canonical hash for the current store state. */
function hashForState(s: ReturnType<typeof useApp.getState>): string {
  switch (s.view) {
    case 'dashboard':
      return '#/';
    case 'position':
      return s.selectedInstrumentId != null ? `#/position/${s.selectedInstrumentId}` : '#/';
    case 'research':
      return s.researchSymbol ? `#/research/${encodeURIComponent(s.researchSymbol)}` : '#/research';
    default:
      return `#/${SIMPLE_PATHS[s.view]}`;
  }
}

/** Parse the current location hash into the navigation fields it encodes. */
function parseHash(): Parsed {
  const raw = window.location.hash.replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean); // '#/position/5' → ['position','5']
  const head = parts[0] ?? '';

  switch (head) {
    case '':
    case 'overview':
    case 'dashboard':
      return { view: 'dashboard' };
    case 'position': {
      const id = Number(parts[1]);
      return parts[1] && Number.isFinite(id)
        ? { view: 'position', selectedInstrumentId: id }
        : { view: 'dashboard' };
    }
    case 'research':
      return { view: 'research', researchSymbol: parts[1] ? decodeURIComponent(parts[1]) : null };
    case 'scenarios':
    case 'advisory':
    case 'decisions':
    case 'plans':
    case 'watchlist':
    case 'screener':
    case 'alerts':
      return { view: head };
    default:
      return { view: 'dashboard' };
  }
}

/** Push parsed hash values into the store, touching only fields that changed. */
function applyHashToStore(): void {
  const parsed = parseHash();
  const s = useApp.getState();
  const patch: Partial<Parsed> = {};

  if (parsed.view !== s.view) patch.view = parsed.view;
  if ('selectedInstrumentId' in parsed && parsed.selectedInstrumentId !== s.selectedInstrumentId) {
    patch.selectedInstrumentId = parsed.selectedInstrumentId;
  }
  if ('researchSymbol' in parsed && parsed.researchSymbol !== s.researchSymbol) {
    patch.researchSymbol = parsed.researchSymbol;
  }

  if (Object.keys(patch).length) useApp.setState(patch);
}

let started = false;

/** Wire up two-way sync. Call once at startup, before/around first render. */
export function initRouter(): void {
  if (started) return;
  started = true;

  // Adopt whatever the initial URL asks for (a shared/bookmarked deep link).
  applyHashToStore();

  // Normalize an empty hash so the address bar always reflects the view.
  const initial = hashForState(useApp.getState());
  if (window.location.hash !== initial) {
    window.history.replaceState(null, '', initial);
  }

  // Back/forward and manual hash edits flow URL → store. (pushState below does
  // NOT fire these, so there is no feedback loop.) Both events are idempotent.
  window.addEventListener('hashchange', applyHashToStore);
  window.addEventListener('popstate', applyHashToStore);

  // Store → URL. Fires on every state change but only writes when the derived
  // hash actually differs, so modal/benchmark/preTax churn is ignored for free.
  useApp.subscribe((s) => {
    const desired = hashForState(s);
    if (window.location.hash !== desired) {
      window.history.pushState(null, '', desired);
    }
  });
}
