import { useMemo, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bell, BellOff, Sparkles, TrendingDown, TrendingUp, RefreshCw, Trash2, Check, X, Plus, Radar,
} from 'lucide-react';
import clsx from 'clsx';
import { api, type PriceAlert, type AppNotification } from '../lib/api';
import { useApp } from '../store';
import { ExportAction } from '../components/ExportAction';
import { Spinner, EmptyState, Tabs } from '../components/ui';
import { fmtMoney, fmtDate } from '../lib/format';

/** Parse the API's timestamps, which arrive either ISO-Z or as naive UTC "YYYY-MM-DD HH:MM:SS". */
function parseTs(iso: string): number {
  return new Date(iso.includes('Z') || iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').getTime();
}

function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - parseTs(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Day bucket label for the feed: recent days read as words, older ones as a date. */
function dayLabel(iso: string): string {
  const d = new Date(parseTs(iso));
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(d)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const NOTIF_ICON = {
  alert: Bell,
  opportunity: Sparkles,
  scan: Radar,
} as const;

type Tab = 'notifications' | 'price-alerts';
type Filter = 'all' | 'unread';

export function Alerts() {
  const qc = useQueryClient();
  const researchSymbolView = useApp((s) => s.researchSymbolView);
  const [tab, setTab] = useState<Tab>('notifications');
  const [filter, setFilter] = useState<Filter>('all');
  const [newSymbol, setNewSymbol] = useState('');
  const [newKind, setNewKind] = useState<'buy' | 'sell'>('buy');

  const notif = useQuery({ queryKey: ['notifications'], queryFn: () => api.listNotifications(60) });
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api.listAlerts() });
  const scan = useQuery({ queryKey: ['scan-status'], queryFn: api.scanStatus });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['notifications'] });
    qc.invalidateQueries({ queryKey: ['alerts'] });
    qc.invalidateQueries({ queryKey: ['scan-status'] });
    qc.invalidateQueries({ queryKey: ['unread-count'] });
  };

  const runScan = useMutation({ mutationFn: api.runScan, onSuccess: invalidateAll });
  const markRead = useMutation({ mutationFn: (id?: number) => api.markNotificationsRead(id), onSuccess: invalidateAll });
  const createAlert = useMutation({
    mutationFn: () => api.createAlert({ symbol: newSymbol.trim().toUpperCase(), kind: newKind }),
    onSuccess: () => { setNewSymbol(''); invalidateAll(); },
  });
  const delAlert = useMutation({ mutationFn: (id: number) => api.deleteAlert(id), onSuccess: invalidateAll });
  const dismiss = useMutation({ mutationFn: (id: number) => api.dismissAlert(id), onSuccess: invalidateAll });

  const notifications = notif.data?.notifications ?? [];
  const unread = notif.data?.unreadCount ?? 0;
  const allAlerts = alerts.data ?? [];
  const triggered = allAlerts.filter((a) => a.status === 'triggered');
  const active = allAlerts.filter((a) => a.status === 'active');
  const last = scan.data?.lastScan;

  const shown = filter === 'unread' ? notifications.filter((n) => !n.read) : notifications;
  // Group the feed by day — the one structural device a notification list actually
  // earns, because "when" is how you read an inbox.
  const days = useMemo(() => {
    const out: { label: string; items: AppNotification[] }[] = [];
    for (const n of shown) {
      const label = dayLabel(n.createdAt);
      const tail = out[out.length - 1];
      if (tail?.label === label) tail.items.push(n);
      else out.push({ label, items: [n] });
    }
    return out;
  }, [shown]);

  return (
    <div id="view-alerts" className="p-6 max-w-[1120px] mx-auto">
      {/* Sticky page head: the title, the scan control and the tabs stay reachable
          however far the panel below is scrolled. Full-bleed so it meets the pane's
          edges rather than floating inside the page gutter. */}
      <div className="sticky top-0 z-20 -mx-6 -mt-6 mb-5 px-6 pt-5 bg-bg/90 backdrop-blur-md border-b border-hairline">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h1 className="font-display text-2xl font-semibold flex items-center gap-2">
            <Bell size={21} className="text-azure" /> Alerts
          </h1>
          <div className="flex items-center gap-3">
            <div className="text-right text-[11px] text-text-faint leading-tight">
              <div>{last ? `Last scan ${ago(last.finishedAt)}` : 'Not scanned yet'}</div>
              {/* The cadence line is context, not news — it yields its row on a phone. */}
              <div className="hidden sm:block">
                every {scan.data?.intervalHours ?? 6}h · {last ? `${last.alertsFired} fired, ${last.new} new` : '—'}
              </div>
            </div>
            <button className="btn-secondary" disabled={runScan.isPending} onClick={() => runScan.mutate()}>
              <RefreshCw size={15} className={runScan.isPending ? 'animate-spin' : ''} /> Scan now
            </button>
            <ExportAction target={() => document.getElementById('view-alerts')} title="Alerts" filename="alerts" className="btn-secondary shrink-0" label="PDF / Word" />
          </div>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-x-4">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'notifications', label: 'Notifications', count: notifications.length, icon: Bell },
              { value: 'price-alerts', label: 'Price alerts', count: triggered.length + active.length, icon: TrendingUp },
            ]}
          />
          {tab === 'notifications' && notifications.length > 0 && (
            <div className="flex items-center gap-1 pb-1.5">
              {(['all', 'unread'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={clsx(
                    'h-7 px-2.5 rounded-sm text-[12px] capitalize transition-colors',
                    filter === f ? 'bg-surface-2 text-text' : 'text-text-muted hover:text-text',
                  )}
                >
                  {f}
                  {f === 'unread' && <span className="ml-1.5 font-mono tnum text-text-faint">{unread}</span>}
                </button>
              ))}
              {unread > 0 && (
                <button className="btn-ghost !h-7 text-[12px] ml-1" onClick={() => markRead.mutate(undefined)}>
                  <Check size={13} /> Mark all read
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {tab === 'notifications' ? (
        <div id="panel-notifications" role="tabpanel" aria-labelledby="tab-notifications">
          {notif.isLoading ? (
            <Spinner />
          ) : notifications.length === 0 ? (
            <div className="rounded border border-dashed border-hairline">
            <EmptyState
              icon={Bell}
              title="Nothing to report yet"
              hint="Triggered price alerts and the opportunities the background scan surfaces land here. Run a scan to fill the feed."
              action={
                <button className="btn-secondary" disabled={runScan.isPending} onClick={() => runScan.mutate()}>
                  <RefreshCw size={15} className={runScan.isPending ? 'animate-spin' : ''} /> Scan now
                </button>
              }
            />
            </div>
          ) : shown.length === 0 ? (
            <div className="rounded border border-dashed border-hairline">
            <EmptyState
              icon={Check}
              title="All caught up"
              hint="Nothing unread."
              action={
                <button className="btn-secondary" onClick={() => setFilter('all')}>
                  Show all {notifications.length}
                </button>
              }
            />
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {days.map((day) => (
                <section key={day.label}>
                  <div className="flex items-center gap-3 mb-1.5">
                    <span className="eyebrow shrink-0">{day.label}</span>
                    <span className="h-px flex-1 bg-hairline" aria-hidden />
                    <span className="text-[11px] text-text-faint tnum shrink-0">{day.items.length}</span>
                  </div>
                  <ul className="border border-hairline rounded divide-y divide-hairline overflow-hidden">
                    {day.items.map((n) => (
                      <NotificationRow
                        key={n.id}
                        n={n}
                        onOpen={() => {
                          if (n.symbol) researchSymbolView(n.symbol);
                          if (!n.read) markRead.mutate(n.id);
                        }}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div id="panel-price-alerts" role="tabpanel" aria-labelledby="tab-price-alerts">
          {/* Composer — the page's one input, so it leads. */}
          <div className="card mb-5">
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={newSymbol}
                onChange={(e) => setNewSymbol(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && newSymbol.trim()) createAlert.mutate(); }}
                placeholder="Symbol e.g. NESN.SW"
                aria-label="Symbol to watch"
                className="input w-[220px] font-mono"
              />
              <div className="inline-flex rounded border border-hairline bg-surface-2 p-0.5">
                {(['buy', 'sell'] as const).map((k) => (
                  <button key={k} onClick={() => setNewKind(k)}
                    className={clsx('px-3 h-7 text-[12px] rounded-sm capitalize transition-colors',
                      newKind === k ? (k === 'buy' ? 'bg-gain text-bg' : 'bg-loss text-bg') + ' font-medium' : 'text-text-muted hover:text-text')}>
                    {k}
                  </button>
                ))}
              </div>
              <button className="btn-primary" disabled={!newSymbol.trim() || createAlert.isPending}
                onClick={() => createAlert.mutate()}>
                <Plus size={15} /> Add alert
              </button>
              <p className="text-[11px] text-text-faint flex-1 min-w-[240px] leading-snug sm:pl-2">
                The target defaults to the computed fair-value price — the attractive entry (buy) or the sell zone.
              </p>
            </div>
          </div>

          {alerts.isLoading ? (
            <Spinner />
          ) : triggered.length + active.length === 0 ? (
            <div className="rounded border border-dashed border-hairline">
              <EmptyState
                icon={BellOff}
                title="No price alerts yet"
                hint="Add a symbol above and DecisionGuru watches it against its fair value. Names on your watchlist get an automatic buy target."
              />
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {triggered.length > 0 && (
                <AlertGroup label="Triggered" count={triggered.length}>
                  {triggered.map((a) => (
                    <AlertCard key={a.id} a={a} onDelete={() => delAlert.mutate(a.id)}
                      onDismiss={() => dismiss.mutate(a.id)} onOpen={() => researchSymbolView(a.symbol)} />
                  ))}
                </AlertGroup>
              )}
              {active.length > 0 && (
                <AlertGroup label="Active" count={active.length}>
                  {active.map((a) => (
                    <AlertCard key={a.id} a={a} onDelete={() => delAlert.mutate(a.id)}
                      onOpen={() => researchSymbolView(a.symbol)} />
                  ))}
                </AlertGroup>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A labelled band of alert cards. The grid uses the width the tab now has to itself. */
function AlertGroup({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return (
    <section>
      <div className="flex items-center gap-3 mb-2">
        <span className="eyebrow shrink-0">{label}</span>
        <span className="h-px flex-1 bg-hairline" aria-hidden />
        <span className="text-[11px] text-text-faint tnum shrink-0">{count}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
    </section>
  );
}

function NotificationRow({ n, onOpen }: { n: AppNotification; onOpen: () => void }) {
  const Icon = NOTIF_ICON[n.type] ?? Bell;
  const color = n.type === 'opportunity' ? 'text-gain' : n.type === 'alert' ? 'text-azure' : 'text-text-faint';
  return (
    <li>
      <button onClick={onOpen}
        className={clsx('relative w-full text-left pl-4 pr-3 py-2.5 flex gap-3 items-start transition-colors',
          n.read ? 'hover:bg-surface-2/40' : 'bg-azure/[0.045] hover:bg-azure/[0.08]')}>
        {/* Unread carries the same azure rule the sidebar uses for "here". */}
        {!n.read && <span aria-hidden className="absolute left-0 inset-y-0 w-0.5 bg-azure" />}
        <Icon size={15} className={clsx('shrink-0 mt-0.5', n.read ? 'text-text-faint' : color)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3">
            <span className={clsx('text-[13px] truncate', n.read ? 'text-text-muted' : 'text-text font-medium')}>
              {n.title}
            </span>
            {/* Meta clusters at the right edge: which name, and when. */}
            <span className="ml-auto flex items-baseline gap-2 shrink-0 font-mono text-[11px] text-text-faint">
              {n.symbol && <span className="hidden sm:inline">{n.symbol}</span>}
              <span className="tnum">{ago(n.createdAt)}</span>
            </span>
          </div>
          {n.body && <p className="text-[12px] text-text-muted mt-0.5 leading-snug line-clamp-2">{n.body}</p>}
        </div>
      </button>
    </li>
  );
}

function AlertCard({ a, onDelete, onDismiss, onOpen }: {
  a: PriceAlert; onDelete: () => void; onDismiss?: () => void; onOpen: () => void;
}) {
  const buy = a.kind === 'buy';
  const ccy = a.currency || '';
  const basis = (a.reasoning as { basis?: string } | null)?.basis;
  return (
    <div className={clsx('flex items-start gap-3 p-3 rounded border',
      a.status === 'triggered' ? 'border-warn/40 bg-warn/5' : 'border-hairline bg-surface-2/40')}>
      {buy ? <TrendingUp size={16} className="text-gain shrink-0 mt-0.5" /> : <TrendingDown size={16} className="text-loss shrink-0 mt-0.5" />}
      <button onClick={onOpen} className="flex-1 min-w-0 text-left">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-mono text-sm font-medium truncate">{a.symbol}</span>
          <span className={clsx('text-[10px] uppercase tracking-wide shrink-0', buy ? 'text-gain' : 'text-loss')}>{a.kind}</span>
          {a.auto && <span className="chip !py-0 !px-1.5 text-[9px] text-text-faint shrink-0">auto</span>}
        </div>
        {/* The rule this alert enforces — the one thing you came to check. */}
        <div className="text-[12px] text-text-muted mt-1 truncate">
          {a.direction === 'below' ? '≤ ' : '≥ '}
          <span className="font-mono tnum text-text">
            {a.targetPrice != null ? fmtMoney(a.targetPrice, ccy) : 'target pending'}
          </span>
          {a.lastPrice != null && (
            <span className="text-text-faint"> · now <span className="font-mono tnum">{fmtMoney(a.lastPrice, ccy)}</span></span>
          )}
        </div>
        <div className="text-[11px] mt-0.5 truncate">
          {a.triggeredAt
            ? <span className="text-warn">Fired {fmtDate(a.triggeredAt)}</span>
            : <span className="text-text-faint">{basis ?? 'Watching'}</span>}
        </div>
      </button>
      <div className="flex items-center shrink-0 -mt-0.5">
        {a.status === 'triggered' && onDismiss && (
          <button className="text-text-faint hover:text-text p-1" title="Dismiss" onClick={onDismiss}><X size={14} /></button>
        )}
        <button className="text-text-faint hover:text-loss p-1" title="Delete" onClick={onDelete}><Trash2 size={14} /></button>
      </div>
    </div>
  );
}
