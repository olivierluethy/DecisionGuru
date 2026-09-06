import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bell, BellOff, Sparkles, TrendingDown, TrendingUp, RefreshCw, Trash2, Check, X, Plus,
  Radar, Swords, Search, Crosshair, CheckCircle2, ArrowUpDown,
} from 'lucide-react';
import clsx from 'clsx';
import { api, type PriceAlert, type AppNotification } from '../lib/api';
import { useApp } from '../store';
import { ExportAction } from '../components/ExportAction';
import { Spinner, EmptyState, Tabs, Segmented } from '../components/ui';
import { fmtMoney, fmtDate, fmtPct } from '../lib/format';
import { ago, until, parseTs, bucketOf, type Granularity } from '../lib/time';

const NOTIF_ICON = { alert: Bell, opportunity: Sparkles, scan: Radar, rivalry: Swords } as const;

type Tab = 'notifications' | 'price-alerts';
type NotifType = AppNotification['type'];
type TypeFilter = 'all' | NotifType;
type AlertFilter = 'all' | 'buy' | 'sell' | 'triggered' | 'active' | 'auto';
type SortKey = 'closest' | 'discount' | 'fired' | 'symbol' | 'newest';

const TYPE_CHIPS: { key: TypeFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'alert', label: 'Price' },
  { key: 'opportunity', label: 'Opportunities' },
  { key: 'rivalry', label: 'Rivalry' },
  { key: 'scan', label: 'Scans' },
];
const GRAINS: { value: Granularity; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];
const SORTS: { value: SortKey; label: string }[] = [
  { value: 'closest', label: 'Closest to trigger' },
  { value: 'discount', label: 'Deepest discount' },
  { value: 'fired', label: 'Recently fired' },
  { value: 'symbol', label: 'Symbol A–Z' },
  { value: 'newest', label: 'Newest' },
];

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function Alerts() {
  const qc = useQueryClient();
  const researchSymbolView = useApp((s) => s.researchSymbolView);

  const [tab, setTab] = useState<Tab>('notifications');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [q, setQ] = useState('');
  const [grain, setGrain] = useState<Granularity>('day');
  const [pinnedKey, setPinnedKey] = useState<string | null>(null); // hard-filter to one bucket
  const [activeKey, setActiveKey] = useState<string | null>(null); // scrollspy highlight
  const [newSymbol, setNewSymbol] = useState('');
  const [newKind, setNewKind] = useState<'buy' | 'sell'>('buy');
  const [alertFilter, setAlertFilter] = useState<AlertFilter>('all');
  const [sort, setSort] = useState<SortKey>('closest');

  const notif = useQuery({ queryKey: ['notifications'], queryFn: () => api.listNotifications(60) });
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api.listAlerts() });
  const scan = useQuery({ queryKey: ['scan-status'], queryFn: api.scanStatus });

  const invalidateAll = () => {
    for (const k of ['notifications', 'alerts', 'scan-status', 'unread-count']) {
      qc.invalidateQueries({ queryKey: [k] });
    }
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
  const last = scan.data?.lastScan;

  // --- Notifications pipeline: unread + search → type → bucket -------------------------
  const searched = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return notifications
      .filter((n) => !unreadOnly || !n.read)
      .filter((n) => !needle
        || `${n.title} ${n.body ?? ''} ${n.symbol ?? ''}`.toLowerCase().includes(needle));
  }, [notifications, unreadOnly, q]);

  const typeCounts = useMemo(() => {
    const c: Record<TypeFilter, number> = { all: searched.length, alert: 0, opportunity: 0, scan: 0, rivalry: 0 };
    for (const n of searched) c[n.type] += 1;
    return c;
  }, [searched]);

  const shown = typeFilter === 'all' ? searched : searched.filter((n) => n.type === typeFilter);

  // Bucket into calendar sections at the chosen granularity (feed is newest-first).
  const buckets = useMemo(() => {
    const out: { key: string; label: string; short: string; items: AppNotification[] }[] = [];
    for (const n of shown) {
      const b = bucketOf(n.createdAt, grain);
      const tail = out[out.length - 1];
      if (tail?.key === b.key) tail.items.push(n);
      else out.push({ key: b.key, label: b.label, short: b.short, items: [n] });
    }
    return out;
  }, [shown, grain]);

  // A pinned pill hard-filters to a single bucket; if it drops out of view (filter/grain
  // change), release it.
  useEffect(() => {
    if (pinnedKey && !buckets.some((b) => b.key === pinnedKey)) setPinnedKey(null);
  }, [buckets, pinnedKey]);
  const visibleBuckets = pinnedKey ? buckets.filter((b) => b.key === pinnedKey) : buckets;

  // Measure the sticky control center so jumps clear it and scrollspy uses the right offset.
  const headRef = useRef<HTMLDivElement>(null);
  const [headH, setHeadH] = useState(0);
  useLayoutEffect(() => {
    const el = headRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeadH(el.offsetHeight));
    ro.observe(el);
    setHeadH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  // Scrollspy: the last section header that has crossed under the sticky head is "active".
  useEffect(() => {
    if (tab !== 'notifications' || pinnedKey) return;
    const onScroll = () => {
      const cutoff = (headRef.current?.getBoundingClientRect().bottom ?? headH) + 12;
      let cur: string | null = buckets[0]?.key ?? null;
      for (const b of buckets) {
        const el = document.getElementById(`bucket-${b.key}`);
        if (el && el.getBoundingClientRect().top <= cutoff) cur = b.key;
      }
      setActiveKey(cur);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [tab, pinnedKey, buckets, headH]);

  const jumpTo = (key: string) => {
    const el = document.getElementById(`bucket-${key}`);
    el?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    setActiveKey(key);
  };

  // --- Price-alerts pipeline: filter → sort -------------------------------------------
  const filteredAlerts = useMemo(() => {
    const f = allAlerts.filter((a) => a.status !== 'dismissed');
    switch (alertFilter) {
      case 'buy': return f.filter((a) => a.kind === 'buy');
      case 'sell': return f.filter((a) => a.kind === 'sell');
      case 'triggered': return f.filter((a) => a.status === 'triggered');
      case 'active': return f.filter((a) => a.status === 'active');
      case 'auto': return f.filter((a) => a.auto);
      default: return f;
    }
  }, [allAlerts, alertFilter]);

  const sortedAlerts = useMemo(() => {
    const arr = [...filteredAlerts];
    const cmp: Record<SortKey, (a: PriceAlert, b: PriceAlert) => number> = {
      closest: (a, b) => distanceToTrigger(a) - distanceToTrigger(b),
      discount: (a, b) => signedGap(a) - signedGap(b), // most-below-target first
      fired: (a, b) => (parseTsSafe(b.triggeredAt) - parseTsSafe(a.triggeredAt)),
      symbol: (a, b) => a.symbol.localeCompare(b.symbol),
      newest: (a, b) => parseTsSafe(b.createdAt) - parseTsSafe(a.createdAt),
    };
    return arr.sort(cmp[sort]);
  }, [filteredAlerts, sort]);

  const alertCounts = {
    all: allAlerts.filter((a) => a.status !== 'dismissed').length,
    triggered: allAlerts.filter((a) => a.status === 'triggered').length,
    active: allAlerts.filter((a) => a.status === 'active').length,
  };

  return (
    <div id="view-alerts" className="p-6 max-w-[1120px] mx-auto">
      {/* One sticky control center: identity + actions, the scan pulse, the tabs, and — on
          Notifications — the filters and the time index, so any period is one tap away. */}
      <div
        ref={headRef}
        className="sticky top-0 z-20 -mx-6 -mt-6 mb-5 px-6 pt-5 pb-3 bg-bg/90 backdrop-blur-md border-b border-hairline"
      >
        <div className="flex items-center justify-between gap-x-4 gap-y-2 flex-wrap">
          <h1 className="font-display text-2xl font-semibold flex items-center gap-2">
            <Bell size={21} className="text-azure" /> Alerts
          </h1>
          <div className="flex items-center gap-2">
            <button className="btn-secondary" disabled={runScan.isPending} onClick={() => runScan.mutate()}>
              <RefreshCw size={15} className={runScan.isPending ? 'animate-spin' : ''} /> Scan now
            </button>
            {tab === 'notifications' && unread > 0 && (
              <button className="btn-secondary" onClick={() => markRead.mutate(undefined)}>
                <Check size={15} /> Mark all read
              </button>
            )}
            <ExportAction target={() => document.getElementById('view-alerts')} title="Alerts" filename="alerts" className="btn-secondary shrink-0" label="PDF / Word" />
          </div>
        </div>

        <SmartScanBanner
          last={last}
          intervalHours={scan.data?.intervalHours ?? 6}
          scanning={runScan.isPending}
          onScan={() => runScan.mutate()}
          onViewNew={() => { setTab('notifications'); setTypeFilter('opportunity'); setPinnedKey(null); }}
        />

        <div className="mt-3">
          <Tabs
            value={tab}
            onChange={(v) => setTab(v as Tab)}
            tabs={[
              { value: 'notifications', label: 'Notifications', count: notifications.length, icon: Bell },
              { value: 'price-alerts', label: 'Price alerts', count: alertCounts.all, icon: TrendingUp },
            ]}
          />
        </div>

        {tab === 'notifications' && notifications.length > 0 && (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search notifications"
                  aria-label="Search notifications"
                  className="input !h-8 !pl-8 w-[200px] text-[13px]"
                />
              </div>
              <div className="flex flex-wrap gap-1">
                {TYPE_CHIPS.filter((t) => t.key === 'all' || typeCounts[t.key] > 0).map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setTypeFilter(t.key)}
                    className={clsx('chip cursor-pointer', typeFilter === t.key ? '!border-azure/60 !text-azure' : '')}
                  >
                    {t.label}
                    <span className="ml-1.5 font-mono tnum text-text-faint">{typeCounts[t.key]}</span>
                  </button>
                ))}
              </div>
              <button
                onClick={() => setUnreadOnly((v) => !v)}
                className={clsx('chip cursor-pointer ml-auto', unreadOnly ? '!border-azure/60 !text-azure' : '')}
              >
                Unread <span className="ml-1.5 font-mono tnum text-text-faint">{unread}</span>
              </button>
              <Segmented value={grain} onChange={(v) => setGrain(v as Granularity)} options={GRAINS} />
            </div>

            {buckets.length > 0 && (
              <div className="mt-2.5 flex items-center gap-2">
                <span className="eyebrow shrink-0 hidden sm:block">Jump to</span>
                <div className="flex-1 min-w-0 flex gap-1.5 overflow-x-auto pb-1 scroll-slim">
                  {pinnedKey && (
                    <button className="chip cursor-pointer shrink-0 !border-azure/60 !text-azure" onClick={() => setPinnedKey(null)}>
                      <X size={12} /> All
                    </button>
                  )}
                  {buckets.map((b) => {
                    const on = pinnedKey ? pinnedKey === b.key : activeKey === b.key;
                    return (
                      <span
                        key={b.key}
                        className={clsx(
                          'shrink-0 inline-flex items-center rounded-full border text-[12px] transition-colors',
                          on ? 'border-azure/60 bg-azure/10 text-azure' : 'border-hairline text-text-muted',
                        )}
                      >
                        <button className="pl-2.5 pr-1.5 py-1 cursor-pointer" onClick={() => jumpTo(b.key)} title={`Jump to ${b.label}`}>
                          {b.short} <span className="ml-1 font-mono tnum opacity-70">{b.items.length}</span>
                        </button>
                        <button
                          className={clsx('pr-2 pl-0.5 py-1 cursor-pointer hover:text-azure', pinnedKey === b.key ? 'text-azure' : 'text-text-faint')}
                          title="Show only this period"
                          aria-label={`Show only ${b.label}`}
                          onClick={() => setPinnedKey((k) => (k === b.key ? null : b.key))}
                        >
                          <Crosshair size={12} />
                        </button>
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
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
                icon={Search}
                title="No matches"
                hint="No notifications fit these filters."
                action={
                  <button className="btn-secondary" onClick={() => { setUnreadOnly(false); setTypeFilter('all'); setQ(''); }}>
                    Clear filters
                  </button>
                }
              />
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {visibleBuckets.map((b) => (
                <section key={b.key} id={`bucket-${b.key}`} style={{ scrollMarginTop: headH + 12 }}>
                  <div className="flex items-center gap-3 mb-1.5">
                    <span className="eyebrow shrink-0">{b.label}</span>
                    <span className="h-px flex-1 bg-hairline" aria-hidden />
                    <span className="text-[11px] text-text-faint tnum shrink-0">{b.items.length}</span>
                  </div>
                  <ul className="border border-hairline rounded divide-y divide-hairline overflow-hidden">
                    {b.items.map((n) => (
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
          <div className="card mb-4">
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={newSymbol}
                onChange={(e) => setNewSymbol(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && newSymbol.trim()) createAlert.mutate(); }}
                placeholder="Symbol e.g. NESN.SW"
                aria-label="Symbol to watch"
                className="input w-[200px] font-mono"
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
          ) : alertCounts.all === 0 ? (
            <div className="rounded border border-dashed border-hairline">
              <EmptyState
                icon={BellOff}
                title="No price alerts yet"
                hint="Add a symbol above and DecisionGuru watches it against its fair value. Names on your watchlist get an automatic buy target."
              />
            </div>
          ) : (
            <>
              {/* Filter chips + sort — the two ways to find the alert you care about. */}
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <div className="flex flex-wrap gap-1">
                  {(['all', 'buy', 'sell', 'triggered', 'active', 'auto'] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setAlertFilter(f)}
                      className={clsx('chip cursor-pointer capitalize', alertFilter === f ? '!border-azure/60 !text-azure' : '')}
                    >
                      {f}
                      {(f === 'all' || f === 'triggered' || f === 'active') && (
                        <span className="ml-1.5 font-mono tnum text-text-faint">{alertCounts[f]}</span>
                      )}
                    </button>
                  ))}
                </div>
                <label className="ml-auto flex items-center gap-1.5 text-[12px] text-text-muted">
                  <ArrowUpDown size={13} className="text-text-faint" />
                  <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="input !h-8 text-[13px] pr-7">
                    {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </label>
              </div>

              {sortedAlerts.length === 0 ? (
                <div className="rounded border border-dashed border-hairline">
                  <EmptyState icon={Search} title="No matches" hint="No alerts fit this filter."
                    action={<button className="btn-secondary" onClick={() => setAlertFilter('all')}>Show all {alertCounts.all}</button>} />
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {sortedAlerts.map((a) => (
                    <AlertCard key={a.id} a={a}
                      onDelete={() => delAlert.mutate(a.id)}
                      onDismiss={a.status === 'triggered' ? () => dismiss.mutate(a.id) : undefined}
                      onOpen={() => researchSymbolView(a.symbol)} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Smart scan banner: turns the passive "last scan" line into a next-step prompt --------
function SmartScanBanner({ last, intervalHours, scanning, onScan, onViewNew }: {
  last: { finishedAt: string; alertsFired: number; new: number } | null | undefined;
  intervalHours: number;
  scanning: boolean;
  onScan: () => void;
  onViewNew: () => void;
}) {
  const lastMs = last ? parseTs(last.finishedAt) : null;
  const stale = lastMs == null || Date.now() - lastMs > intervalHours * 3_600_000;
  const newCount = last?.new ?? 0;

  const state = scanning ? 'scanning' : !last ? 'never' : stale ? 'stale' : newCount > 0 ? 'new' : 'fresh';
  const nextIn = lastMs != null ? until(lastMs + intervalHours * 3_600_000 - Date.now()) : '';

  const base = 'mt-3 flex items-center gap-2.5 rounded-md border px-3 py-2 text-[12.5px]';
  if (state === 'scanning') {
    return (
      <div className={clsx(base, 'border-azure/40 bg-azure/5 text-text-muted')}>
        <RefreshCw size={15} className="text-azure animate-spin shrink-0" />
        Scanning your universe for fresh signals…
      </div>
    );
  }
  if (state === 'new') {
    return (
      <div className={clsx(base, 'border-gain/40 bg-gain/5')}>
        <Sparkles size={15} className="text-gain shrink-0" />
        <span className="text-text">
          The last scan surfaced <span className="font-medium text-gain">{newCount}</span> new {newCount === 1 ? 'opportunity' : 'opportunities'}.
        </span>
        <button className="btn-ghost !h-7 text-[12px] ml-auto" onClick={onViewNew}>View</button>
        <span className="text-text-faint hidden sm:inline">next scan in {nextIn}</span>
      </div>
    );
  }
  if (state === 'fresh') {
    return (
      <div className={clsx(base, 'border-hairline bg-surface-2/40 text-text-faint')}>
        <CheckCircle2 size={15} className="text-gain/70 shrink-0" />
        You're up to date — last scan {ago(last!.finishedAt)}. Next auto-scan in {nextIn}.
      </div>
    );
  }
  // never / stale → an actionable prompt
  return (
    <div className={clsx(base, 'border-azure/40 bg-azure/5')}>
      <Radar size={15} className="text-azure shrink-0" />
      <span className="text-text">
        {state === 'never'
          ? 'Run your first scan to surface buy-zone entries and new opportunities.'
          : `New data may be available — last scan ${ago(last!.finishedAt)}.`}
      </span>
      <button className="btn-primary !h-7 text-[12px] ml-auto shrink-0" onClick={onScan}>
        <RefreshCw size={13} /> Scan now
      </button>
    </div>
  );
}

function NotificationRow({ n, onOpen }: { n: AppNotification; onOpen: () => void }) {
  const Icon = NOTIF_ICON[n.type] ?? Bell;
  const color = n.type === 'opportunity' ? 'text-gain'
    : n.type === 'rivalry' ? 'text-warn'
    : n.type === 'alert' ? 'text-azure' : 'text-text-faint';
  return (
    <li>
      <button onClick={onOpen}
        className={clsx('relative w-full text-left pl-4 pr-3 py-2.5 flex gap-3 items-start transition-colors',
          n.read ? 'hover:bg-surface-2/40' : 'bg-azure/[0.045] hover:bg-azure/[0.08]')}>
        {!n.read && <span aria-hidden className="absolute left-0 inset-y-0 w-0.5 bg-azure" />}
        <Icon size={15} className={clsx('shrink-0 mt-0.5', n.read ? 'text-text-faint' : color)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3">
            <span className={clsx('text-[13px] truncate', n.read ? 'text-text-muted' : 'text-text font-medium')}>
              {n.title}
            </span>
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

// ---- Price-alert distance maths ----------------------------------------------------------
function parseTsSafe(iso: string | null): number {
  return iso ? parseTs(iso) : 0;
}
/** Signed gap of last price vs target as a fraction: negative = below target, positive = above. */
function signedGap(a: PriceAlert): number {
  if (a.targetPrice == null || a.lastPrice == null || a.targetPrice <= 0) return Number.POSITIVE_INFINITY;
  return a.lastPrice / a.targetPrice - 1;
}
/** How far the price still has to move to cross the target (0 once in-zone or fired). */
function distanceToTrigger(a: PriceAlert): number {
  if (a.status === 'triggered') return 0;
  const g = signedGap(a);
  if (!Number.isFinite(g)) return Number.POSITIVE_INFINITY;
  return a.kind === 'buy' ? Math.max(0, g) : Math.max(0, -g);
}

function AlertCard({ a, onDelete, onDismiss, onOpen }: {
  a: PriceAlert; onDelete: () => void; onDismiss?: () => void; onOpen: () => void;
}) {
  const buy = a.kind === 'buy';
  const ccy = a.currency || '';
  const fired = a.status === 'triggered';
  const g = signedGap(a);
  const hasGauge = Number.isFinite(g) && a.lastPrice != null && a.targetPrice != null;
  const favorable = buy ? g <= 0 : g >= 0; // in the zone the alert is watching for
  const pos = Math.min(96, Math.max(4, 50 + g * 100 * 0.9));
  const word = g < 0 ? 'below' : g > 0 ? 'above' : 'at';

  return (
    <div className={clsx('flex flex-col p-3 rounded border',
      fired ? 'border-warn/40 bg-warn/5' : 'border-hairline bg-surface-2/40')}>
      <div className="flex items-start gap-2">
        {buy ? <TrendingUp size={16} className="text-gain shrink-0 mt-0.5" /> : <TrendingDown size={16} className="text-loss shrink-0 mt-0.5" />}
        <button onClick={onOpen} className="flex-1 min-w-0 text-left">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="font-mono text-sm font-medium truncate">{a.symbol}</span>
            <span className={clsx('text-[10px] tracking-wide shrink-0', buy ? 'text-gain' : 'text-loss')}>{a.kind}</span>
            {a.auto && <span className="chip !py-0 !px-1.5 text-[9px] text-text-faint shrink-0">auto</span>}
            <span className={clsx('ml-auto text-[10px] px-1.5 py-0.5 rounded shrink-0',
              fired ? 'bg-warn/15 text-warn' : 'bg-hairline/60 text-text-faint')}>
              {fired ? 'Fired' : 'Watching'}
            </span>
          </div>
        </button>
        <div className="flex items-center shrink-0 -mt-0.5 -mr-1">
          {fired && onDismiss && (
            <button className="text-text-faint hover:text-text p-1" title="Dismiss" onClick={onDismiss}><X size={14} /></button>
          )}
          <button className="text-text-faint hover:text-loss p-1" title="Delete" onClick={onDelete}><Trash2 size={14} /></button>
        </div>
      </div>

      {hasGauge ? (
        <div className="mt-2">
          <div className="flex items-baseline justify-between gap-2 text-[12px]">
            <span className="text-text-muted">LS <span className="font-mono tnum text-text">{fmtMoney(a.lastPrice!, ccy)}</span></span>
            <span className={clsx('font-mono tnum', favorable ? (buy ? 'text-gain' : 'text-loss') : 'text-text-faint')}>
              {fmtPct(Math.abs(g), 1)} {word}
            </span>
          </div>
          <div className="relative h-1.5 rounded-full bg-hairline mt-1.5">
            <span className="absolute top-1/2 h-3 w-px bg-text-faint" style={{ left: '50%', transform: 'translate(-50%,-50%)' }} aria-hidden />
            <span
              className={clsx('absolute top-1/2 h-2.5 w-2.5 rounded-full ring-2 ring-bg',
                favorable ? (buy ? 'bg-gain' : 'bg-loss') : 'bg-azure')}
              style={{ left: `${pos}%`, transform: 'translate(-50%,-50%)' }}
              aria-hidden
            />
          </div>
          <div className="flex items-baseline justify-between gap-2 text-[11px] text-text-faint mt-1">
            <span>{buy ? 'buy target' : 'sell target'}</span>
            <span className="font-mono tnum">{a.direction === 'below' ? '≤ ' : '≥ '}{fmtMoney(a.targetPrice!, ccy)}</span>
          </div>
        </div>
      ) : (
        <div className="text-[12px] text-text-muted mt-2 truncate">
          {a.direction === 'below' ? '≤ ' : '≥ '}
          <span className="font-mono tnum text-text">{a.targetPrice != null ? fmtMoney(a.targetPrice, ccy) : 'target pending'}</span>
        </div>
      )}

      {fired && a.triggeredAt && (
        <div className="text-[11px] text-warn mt-1.5">Fired {fmtDate(a.triggeredAt)}</div>
      )}
    </div>
  );
}
