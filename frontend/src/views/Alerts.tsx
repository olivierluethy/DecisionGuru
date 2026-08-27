import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bell, Sparkles, TrendingDown, TrendingUp, RefreshCw, Trash2, Check, X, Plus, Radar,
} from 'lucide-react';
import clsx from 'clsx';
import { api, type PriceAlert, type AppNotification } from '../lib/api';
import { useApp } from '../store';
import { Spinner, EmptyState } from '../components/ui';
import { fmtMoney, fmtDate } from '../lib/format';

function ago(iso: string): string {
  const then = new Date(iso.includes('Z') || iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').getTime();
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const NOTIF_ICON = {
  alert: Bell,
  opportunity: Sparkles,
  scan: Radar,
} as const;

export function Alerts() {
  const qc = useQueryClient();
  const researchSymbolView = useApp((s) => s.researchSymbolView);
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

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <header className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="font-display text-2xl font-semibold flex items-center gap-2">
            <Bell size={22} className="text-azure" /> Alerts & notifications
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Fair-value price alerts and the opportunities the background scan surfaced.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right text-[11px] text-text-faint leading-tight">
            <div>{last ? `Last scan ${ago(last.finishedAt)}` : 'Not scanned yet'}</div>
            <div>every {scan.data?.intervalHours ?? 6}h · {last ? `${last.alertsFired} fired, ${last.new} new` : '—'}</div>
          </div>
          <button className="btn-secondary" disabled={runScan.isPending} onClick={() => runScan.mutate()}>
            <RefreshCw size={15} className={runScan.isPending ? 'animate-spin' : ''} /> Scan now
          </button>
        </div>
      </header>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Notification feed */}
        <section className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-base font-semibold flex items-center gap-2">
              Notifications
              {unread > 0 && <span className="chip !py-0 text-azure border-azure/40">{unread} new</span>}
            </h2>
            {unread > 0 && (
              <button className="btn-ghost !h-7 text-[12px]" onClick={() => markRead.mutate(undefined)}>
                <Check size={13} /> Mark all read
              </button>
            )}
          </div>
          {notif.isLoading ? (
            <Spinner />
          ) : notifications.length === 0 ? (
            <EmptyState title="Nothing yet" hint="Run a scan or add alerts — new opportunities and triggered alerts land here." />
          ) : (
            <ul className="divide-y divide-hairline -mx-1">
              {notifications.map((n) => (
                <NotificationRow key={n.id} n={n}
                  onOpen={() => { if (n.symbol) researchSymbolView(n.symbol); if (!n.read) markRead.mutate(n.id); }} />
              ))}
            </ul>
          )}
        </section>

        {/* Alerts management */}
        <section className="card">
          <h2 className="font-display text-base font-semibold mb-3">Price alerts</h2>

          {/* Add alert */}
          <div className="flex items-center gap-2 mb-4">
            <input
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && newSymbol.trim()) createAlert.mutate(); }}
              placeholder="Symbol e.g. NESN.SW"
              className="input flex-1"
            />
            <div className="inline-flex rounded border border-hairline bg-surface-2 p-0.5">
              {(['buy', 'sell'] as const).map((k) => (
                <button key={k} onClick={() => setNewKind(k)}
                  className={clsx('px-3 h-7 text-[12px] rounded-sm capitalize',
                    newKind === k ? (k === 'buy' ? 'bg-gain text-bg' : 'bg-loss text-bg') + ' font-medium' : 'text-text-muted')}>
                  {k}
                </button>
              ))}
            </div>
            <button className="btn-primary" disabled={!newSymbol.trim() || createAlert.isPending}
              onClick={() => createAlert.mutate()}>
              <Plus size={15} />
            </button>
          </div>
          <p className="text-[11px] text-text-faint -mt-2 mb-4">
            The target defaults to the computed fair-value price — the attractive entry (buy) or the sell zone.
          </p>

          {alerts.isLoading ? (
            <Spinner />
          ) : allAlerts.length === 0 ? (
            <p className="text-sm text-text-faint">No alerts yet. Add one above, or watch a name to get an auto buy target.</p>
          ) : (
            <div className="space-y-4">
              {triggered.length > 0 && (
                <div>
                  <div className="eyebrow mb-2">Triggered</div>
                  <div className="space-y-2">
                    {triggered.map((a) => (
                      <AlertRow key={a.id} a={a} onDelete={() => delAlert.mutate(a.id)}
                        onDismiss={() => dismiss.mutate(a.id)} onOpen={() => researchSymbolView(a.symbol)} />
                    ))}
                  </div>
                </div>
              )}
              <div>
                <div className="eyebrow mb-2">Active ({active.length})</div>
                <div className="space-y-2">
                  {active.map((a) => (
                    <AlertRow key={a.id} a={a} onDelete={() => delAlert.mutate(a.id)}
                      onOpen={() => researchSymbolView(a.symbol)} />
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function NotificationRow({ n, onOpen }: { n: AppNotification; onOpen: () => void }) {
  const Icon = NOTIF_ICON[n.type] ?? Bell;
  const color = n.type === 'opportunity' ? 'text-gain' : n.type === 'alert' ? 'text-azure' : 'text-text-faint';
  return (
    <li>
      <button onClick={onOpen}
        className={clsx('w-full text-left px-1 py-3 flex gap-3 hover:bg-surface-2/50 rounded transition-colors',
          !n.read && 'bg-azure/5')}>
        <Icon size={16} className={clsx('shrink-0 mt-0.5', color)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={clsx('text-sm truncate', n.read ? 'text-text-muted' : 'text-text font-medium')}>{n.title}</span>
            {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-azure shrink-0" />}
          </div>
          {n.body && <p className="text-[12px] text-text-muted mt-0.5 leading-snug">{n.body}</p>}
          <div className="text-[10px] text-text-faint mt-1">{ago(n.createdAt)}</div>
        </div>
      </button>
    </li>
  );
}

function AlertRow({ a, onDelete, onDismiss, onOpen }: {
  a: PriceAlert; onDelete: () => void; onDismiss?: () => void; onOpen: () => void;
}) {
  const buy = a.kind === 'buy';
  const ccy = a.currency || '';
  const basis = (a.reasoning as { basis?: string } | null)?.basis;
  return (
    <div className={clsx('flex items-center gap-3 p-2.5 rounded border',
      a.status === 'triggered' ? 'border-warn/40 bg-warn/5' : 'border-hairline bg-surface-2/40')}>
      {buy ? <TrendingUp size={16} className="text-gain shrink-0" /> : <TrendingDown size={16} className="text-loss shrink-0" />}
      <button onClick={onOpen} className="flex-1 min-w-0 text-left">
        <div className="text-sm font-medium truncate">{a.symbol}
          <span className={clsx('ml-2 text-[11px] uppercase tracking-wide', buy ? 'text-gain' : 'text-loss')}>{a.kind}</span>
          {a.auto && <span className="ml-2 chip !py-0 !px-1.5 text-[9px] text-text-faint">auto</span>}
        </div>
        <div className="text-[11px] text-text-faint truncate">
          {a.direction === 'below' ? 'when ≤ ' : 'when ≥ '}
          <span className="font-mono text-text-muted">{a.targetPrice != null ? fmtMoney(a.targetPrice, ccy) : 'target pending'}</span>
          {a.lastPrice != null && <span> · now {fmtMoney(a.lastPrice, ccy)}</span>}
          {a.triggeredAt && <span className="text-warn"> · fired {fmtDate(a.triggeredAt)}</span>}
          {basis && !a.triggeredAt && <span> · {basis}</span>}
        </div>
      </button>
      {a.status === 'triggered' && onDismiss && (
        <button className="text-text-faint hover:text-text p-1" title="Dismiss" onClick={onDismiss}><X size={14} /></button>
      )}
      <button className="text-text-faint hover:text-loss p-1" title="Delete" onClick={onDelete}><Trash2 size={14} /></button>
    </div>
  );
}
