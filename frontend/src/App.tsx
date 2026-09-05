import { useEffect, useRef } from 'react';
import { Menu } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './views/Dashboard';
import { PositionDetail } from './views/PositionDetail';
import { Scenarios } from './views/Scenarios';
import { Advisory } from './views/Advisory';
import { Decisions } from './views/Decisions';
import { Forecasts } from './views/Forecasts';
import { Research } from './views/Research';
import { Plans } from './views/Plans';
import { Watchlist } from './views/Watchlist';
import { Screener } from './views/Screener';
import { Alerts } from './views/Alerts';
import { ModalHost } from './modals/ModalHost';
import { ScrollToTop } from './components/ScrollToTop';
import { useApp } from './store';
import { api } from './lib/api';

export default function App() {
  const view = useApp((s) => s.view);
  const setBenchmark = useApp((s) => s.setBenchmark);
  const navOpen = useApp((s) => s.navOpen);
  const setNavOpen = useApp((s) => s.setNavOpen);
  const mainRef = useRef<HTMLElement>(null);

  // Sync the default benchmark from persisted settings once.
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  useEffect(() => {
    if (settings?.defaultBenchmarkSymbol) setBenchmark(settings.defaultBenchmarkSymbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.defaultBenchmarkSymbol]);

  // Lock background scroll while the mobile nav drawer is open.
  useEffect(() => {
    document.body.style.overflow = navOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [navOpen]);

  return (
    <div className="flex h-full overflow-hidden bg-bg text-text">
      <Sidebar />
      {navOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden
        />
      )}
      {/* The content well: its own column, its own scroll. Nothing here can move the rail. */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <header className="lg:hidden flex items-center gap-3 px-4 h-14 border-b border-hairline bg-bg-elev shrink-0">
          <button
            className="p-1.5 -ml-1.5 rounded text-text-muted hover:text-text hover:bg-surface-2"
            aria-label="Open navigation"
            onClick={() => setNavOpen(true)}
          >
            <Menu size={20} />
          </button>
          <span className="font-display text-base font-semibold tracking-tight">
            Decision<span className="text-azure">Guru</span>
          </span>
        </header>
        <main ref={mainRef} className="flex-1 pane">
          {view === 'dashboard' && <Dashboard />}
          {view === 'position' && <PositionDetail />}
          {view === 'scenarios' && <Scenarios />}
          {view === 'advisory' && <Advisory />}
          {view === 'decisions' && <Decisions />}
          {view === 'forecasts' && <Forecasts />}
          {view === 'research' && <Research />}
          {view === 'plans' && <Plans />}
          {view === 'watchlist' && <Watchlist />}
          {view === 'screener' && <Screener />}
          {view === 'alerts' && <Alerts />}
        </main>
      </div>
      <ScrollToTop scrollRef={mainRef} />
      <ModalHost />
    </div>
  );
}
