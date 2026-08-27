import {
  LayoutDashboard,
  GitCompareArrows,
  Scale,
  Sparkles,
  Upload,
  Plus,
  Settings,
  TrendingUpDown,
  Compass,
  Telescope,
  ClipboardList,
  Eye,
} from 'lucide-react';
import clsx from 'clsx';
import { useApp } from '../store';
import { MarketHoursStrip } from './MarketHoursStrip';

const NAV = [
  { view: 'dashboard', label: 'Overview', icon: LayoutDashboard },
  { view: 'decisions', label: 'Decisions', icon: Compass },
  { view: 'advisory', label: 'Advisory', icon: Sparkles },
  { view: 'research', label: 'Research', icon: Telescope },
  { view: 'watchlist', label: 'Watchlist', icon: Eye },
  { view: 'scenarios', label: 'Scenarios', icon: GitCompareArrows },
  { view: 'plans', label: 'Plans', icon: ClipboardList },
] as const;

export function Sidebar() {
  const { view, setView, openModal } = useApp();

  return (
    <aside className="w-60 shrink-0 bg-bg-elev border-r border-hairline flex flex-col h-full">
      <div className="px-5 py-5 border-b border-hairline">
        <div className="flex items-center gap-2">
          <TrendingUpDown size={20} className="text-azure" />
          <span className="font-display text-lg font-semibold tracking-tight">
            Decision<span className="text-azure">Guru</span>
          </span>
        </div>
        <p className="text-[11px] text-text-faint mt-1">Portfolio overview · after Swiss tax</p>
      </div>

      <nav className="p-3 flex flex-col gap-1">
        {NAV.map((n) => {
          const Icon = n.icon;
          const active = view === n.view || (n.view === 'dashboard' && view === 'position');
          return (
            <button
              key={n.view}
              onClick={() => setView(n.view)}
              className={clsx(
                'flex items-center gap-3 px-3 h-9 rounded text-sm transition-colors text-left',
                active ? 'bg-surface-2 text-text' : 'text-text-muted hover:text-text hover:bg-surface-2/60',
              )}
            >
              <Icon size={16} className={active ? 'text-azure' : ''} />
              {n.label}
            </button>
          );
        })}
        {/* Comparison is a modal (secondary destination, not the landing page). */}
        <button
          onClick={() => openModal({ kind: 'compare', instrumentIds: [] })}
          className="flex items-center gap-3 px-3 h-9 rounded text-sm transition-colors text-left text-text-muted hover:text-text hover:bg-surface-2/60"
        >
          <Scale size={16} />
          Comparison
        </button>
      </nav>

      <div className="p-3 mt-2 flex flex-col gap-2">
        <div className="eyebrow px-2 mb-1">Add data</div>
        <button className="btn-secondary w-full justify-start" onClick={() => openModal({ kind: 'import' })}>
          <Upload size={15} /> Import data
        </button>
        <button className="btn-secondary w-full justify-start" onClick={() => openModal({ kind: 'manual-add' })}>
          <Plus size={15} /> Add position
        </button>
      </div>

      <div className="mt-auto">
        <MarketHoursStrip />
      </div>

      <div className="p-3 border-t border-hairline">
        <button className="btn-ghost w-full justify-start" onClick={() => openModal({ kind: 'settings' })}>
          <Settings size={15} /> Tax & settings
        </button>
        <p className="text-[10px] text-text-faint px-2 mt-3 leading-relaxed">
          Not financial advice. Figures are model estimates — private-investor Swiss tax
          assumptions apply.
        </p>
      </div>
    </aside>
  );
}
