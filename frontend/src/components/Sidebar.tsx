import type { LucideIcon } from 'lucide-react';
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
  CalendarClock,
  Telescope,
  ClipboardList,
  Eye,
  Globe2,
  Bell,
} from 'lucide-react';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { useApp, type View } from '../store';
import { api } from '../lib/api';
import { MarketHoursStrip } from './MarketHoursStrip';
import { InstallAppButton } from './InstallAppButton';

type NavItem = { label: string; icon: LucideIcon; view: View } | { label: string; icon: LucideIcon; view?: undefined };

/**
 * Two groups, and the split is the product's own: the top half is about the money
 * you already hold, the bottom half about the market you're reading. Labels earn
 * their height by telling you that; they are not decoration.
 */
const NAV: { label: string; items: readonly NavItem[] }[] = [
  {
    label: 'Portfolio',
    items: [
      { view: 'dashboard', label: 'Overview', icon: LayoutDashboard },
      { view: 'decisions', label: 'Decisions', icon: Compass },
      { view: 'forecasts', label: 'Forecasts', icon: CalendarClock },
      { view: 'advisory', label: 'Advisory', icon: Sparkles },
      { view: 'scenarios', label: 'Scenarios', icon: GitCompareArrows },
      { view: 'plans', label: 'Plans', icon: ClipboardList },
    ],
  },
  {
    label: 'Market',
    items: [
      { view: 'research', label: 'Research', icon: Telescope },
      { view: 'watchlist', label: 'Watchlist', icon: Eye },
      { view: 'screener', label: 'Discover', icon: Globe2 },
      { view: 'alerts', label: 'Alerts', icon: Bell },
      // Comparison is a modal (a secondary destination, not a landing page).
      { label: 'Comparison', icon: Scale },
    ],
  },
];

export function Sidebar() {
  const { view, setView, openModal, navOpen, setNavOpen, openResearchSearch } = useApp();
  // Any destination choice also closes the mobile drawer (no-op on desktop).
  const go = (fn: () => void) => {
    fn();
    setNavOpen(false);
  };
  // Poll the unread badge so it reflects background-scan alerts without a manual refresh.
  const unread = useQuery({
    queryKey: ['unread-count'],
    queryFn: api.unreadCount,
    refetchInterval: 60_000,
  });
  const unreadCount = unread.data?.unreadCount ?? 0;

  return (
    <aside
      className={clsx(
        'w-60 shrink-0 bg-bg-elev border-r border-hairline flex flex-col h-full z-40',
        'fixed inset-y-0 left-0 transition-transform lg:static lg:translate-x-0',
        navOpen ? 'translate-x-0' : '-translate-x-full',
      )}
    >
      {/* Brand lockup — pinned, so the rail always identifies itself. */}
      <div className="shrink-0 flex items-center justify-between gap-2 px-4 h-14 border-b border-hairline">
        <div className="flex items-center gap-2 min-w-0">
          <TrendingUpDown size={19} className="text-azure shrink-0" />
          <span className="font-display text-[17px] font-semibold tracking-tight truncate">
            Decision<span className="text-azure">Guru</span>
          </span>
        </div>
        {/* The bell → alert centre, with the app's one permitted red badge. */}
        <button
          onClick={() => go(() => setView('alerts'))}
          title="Alerts & notifications"
          aria-label={unreadCount > 0 ? `Alerts — ${unreadCount} unread` : 'Alerts'}
          className="relative shrink-0 p-1.5 -mr-1.5 rounded text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
        >
          <Bell size={17} className={unreadCount > 0 ? 'text-azure' : ''} />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 rounded-full bg-loss text-bg text-[9px] font-semibold flex items-center justify-center tnum">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>
      </div>

      {/* The rail's own scroll well. `min-h-full` on the inner column lets the
          markets strip sit at the bottom when there's slack and simply flow when
          there isn't — no fixed heights, any viewport. */}
      <div className="flex-1 pane scroll-slim">
        <div className="flex flex-col min-h-full px-2.5 py-2.5">
          <nav aria-label="Main">
            {NAV.map((group, gi) => (
              <div key={group.label} className={gi > 0 ? 'mt-3.5' : undefined}>
                <div className="eyebrow px-2.5 pb-1.5">{group.label}</div>
                <div className="flex flex-col gap-px">
                  {group.items.map((item) => (
                    <NavRow
                      key={item.label}
                      item={item}
                      active={
                        item.view != null &&
                        (view === item.view || (item.view === 'dashboard' && view === 'position'))
                      }
                      onSelect={() =>
                        go(() =>
                          item.view === 'research'
                            // Always land on the search page (keeping recents), so the nav
                            // gives a fresh start instead of re-showing the last company.
                            ? openResearchSearch()
                            : item.view
                              ? setView(item.view)
                              : openModal({ kind: 'compare', instrumentIds: [] }),
                        )
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
          </nav>

          <div className="mt-3.5">
            <div className="eyebrow px-2.5 pb-1.5">Add data</div>
            <div className="flex flex-col gap-1.5">
              <button
                className="btn-secondary w-full justify-start lg:h-8"
                onClick={() => go(() => openModal({ kind: 'import' }))}
              >
                <Upload size={15} /> Import data
              </button>
              <button
                className="btn-secondary w-full justify-start lg:h-8"
                onClick={() => go(() => openModal({ kind: 'manual-add' }))}
              >
                <Plus size={15} /> Add position
              </button>
            </div>
          </div>

          <div className="mt-auto pt-3">
            <MarketHoursStrip />
          </div>
        </div>
      </div>

      {/* Pinned foot: settings stay one click away from anywhere in the rail. */}
      <div className="shrink-0 px-2.5 py-2.5 border-t border-hairline">
        {/* Only rendered once the browser says the app qualifies for installation. */}
        <InstallAppButton />
        <button
          className="btn-ghost w-full justify-start lg:h-8"
          onClick={() => go(() => openModal({ kind: 'settings' }))}
        >
          <Settings size={15} /> Tax &amp; settings
        </button>
        <p className="text-[10px] text-text-faint px-2.5 mt-2 leading-relaxed">
          Not financial advice — model estimates on Swiss private-investor assumptions.
        </p>
      </div>
    </aside>
  );
}

/**
 * One destination. The active row is marked by a 2px azure rule flush to the rail's
 * inner edge — the same "azure means you are here" grammar the metric cards use for
 * "azure means you", and it costs no vertical space in a rail this dense.
 */
function NavRow({
  item,
  active,
  onSelect,
}: {
  item: NavItem;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      onClick={onSelect}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'group relative flex items-center gap-2.5 h-9 lg:h-8 pl-3 pr-2.5 rounded-sm',
        'text-[13px] text-left transition-colors',
        active
          ? 'bg-surface-2 text-text font-medium'
          : 'text-text-muted hover:text-text hover:bg-surface-2/50',
      )}
    >
      <span
        aria-hidden
        className={clsx(
          'absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-azure transition-opacity',
          active ? 'opacity-100' : 'opacity-0',
        )}
      />
      <Icon
        size={15}
        className={clsx(
          'shrink-0 transition-colors',
          active ? 'text-azure' : 'text-text-faint group-hover:text-text-muted',
        )}
      />
      <span className="truncate">{item.label}</span>
    </button>
  );
}
