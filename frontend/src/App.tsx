import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './views/Dashboard';
import { PositionDetail } from './views/PositionDetail';
import { Scenarios } from './views/Scenarios';
import { Advisory } from './views/Advisory';
import { Decisions } from './views/Decisions';
import { Research } from './views/Research';
import { Plans } from './views/Plans';
import { Watchlist } from './views/Watchlist';
import { ModalHost } from './modals/ModalHost';
import { useApp } from './store';
import { api } from './lib/api';

export default function App() {
  const view = useApp((s) => s.view);
  const setBenchmark = useApp((s) => s.setBenchmark);

  // Sync the default benchmark from persisted settings once.
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  useEffect(() => {
    if (settings?.defaultBenchmarkSymbol) setBenchmark(settings.defaultBenchmarkSymbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.defaultBenchmarkSymbol]);

  return (
    <div className="flex h-full bg-bg text-text">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        {view === 'dashboard' && <Dashboard />}
        {view === 'position' && <PositionDetail />}
        {view === 'scenarios' && <Scenarios />}
        {view === 'advisory' && <Advisory />}
        {view === 'decisions' && <Decisions />}
        {view === 'research' && <Research />}
        {view === 'plans' && <Plans />}
        {view === 'watchlist' && <Watchlist />}
      </main>
      <ModalHost />
    </div>
  );
}
