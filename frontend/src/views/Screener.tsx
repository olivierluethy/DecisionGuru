import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowUpRight, Eye, Info, Clock, Globe2, Sparkles, Loader2, DownloadCloud } from 'lucide-react';
import { api, type ScreenerRow, type ScreenerVerdict } from '../lib/api';
import { useApp } from '../store';
import { Spinner, EmptyState, Segmented } from '../components/ui';
import { DiscoverMap } from '../components/DiscoverMap';
import { fmtPct, fmtPctSigned, fmtNum, plClass } from '../lib/format';

const VERDICT_META: Record<ScreenerVerdict, { label: string; cls: string }> = {
  attractive: { label: 'Attractive', cls: 'text-gain border-gain/40 bg-gain/10' },
  'cheap-only': { label: 'Cheap only', cls: 'text-warn border-warn/40 bg-warn/10' },
  fair: { label: 'Fair', cls: 'text-text-muted border-hairline bg-surface-2' },
  expensive: { label: 'Expensive', cls: 'text-loss border-loss/40 bg-loss/10' },
  unknown: { label: 'No data', cls: 'text-text-faint border-hairline bg-surface-2' },
};

const FIT_CLS: Record<string, string> = {
  'new sector': 'text-azure',
  diversifies: 'text-azure',
  neutral: 'text-text-muted',
  concentrates: 'text-loss',
  unknown: 'text-text-faint',
};

const VERDICT_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All verdicts' },
  { value: 'attractive', label: 'Attractive' },
  { value: 'cheap-only', label: 'Cheap only' },
  { value: 'fair', label: 'Fair' },
  { value: 'expensive', label: 'Expensive' },
];

function AttractivenessBar({ value }: { value: number }) {
  const hue = value >= 66 ? 'bg-gain' : value >= 40 ? 'bg-warn' : 'bg-loss';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 rounded-full bg-surface-2 overflow-hidden">
        <div className={clsx('h-full rounded-full', hue)} style={{ width: `${value}%` }} />
      </div>
      <span className="font-mono tnum text-[13px] text-text">{value}</span>
    </div>
  );
}

type Mode = 'all' | 'new';
type GroupBy = 'none' | 'sector' | 'theme' | 'country';
type SortBy = 'attractiveness' | 'fresh';

/** A not-yet-owned name that clears the attractiveness bar. */
function isNewOpportunity(r: ScreenerRow): boolean {
  return !r.inPortfolio && r.verdict === 'attractive';
}

export function Screener() {
  const qc = useQueryClient();
  const openModal = useApp((s) => s.openModal);
  const [mode, setMode] = useState<Mode>('all');
  const [sector, setSector] = useState('');
  const [theme, setTheme] = useState('');
  const [verdict, setVerdict] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [sortBy, setSortBy] = useState<SortBy>('attractiveness');

  // Poll while the universe is still warming: each refetch both refreshes the rows and
  // (server-side) kicks the next bounded warm batch, so coverage grows on its own.
  const { data, isLoading, isError } = useQuery({
    queryKey: ['screener'],
    queryFn: api.screen,
    refetchInterval: (query) => ((query.state.data?.warm?.missing ?? 0) > 0 ? 6000 : false),
  });
  const warmAll = useMutation({
    mutationFn: () => api.refreshScreener(null),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['screener'] }),
  });
  const warm = data?.warm;

  const watchlistQ = useQuery({ queryKey: ['watchlist'], queryFn: api.listWatchlist });
  const addWatch = useMutation({
    mutationFn: (r: ScreenerRow) => api.addToWatchlist({ symbol: r.symbol, name: r.name, kind: 'stock' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['watchlist'] });
      qc.invalidateQueries({ queryKey: ['screener'] });
    },
  });
  const watchedSymbols = useMemo(
    () => new Set((watchlistQ.data ?? []).map((w) => w.symbol)),
    [watchlistQ.data],
  );

  // Country code → display name (from the geo rollup) for the country grouping labels.
  const countryName = useMemo(
    () => new Map((data?.geo ?? []).map((g) => [g.country, g.name])),
    [data],
  );

  const filtered = useMemo(() => {
    let rows = data?.rows ?? [];
    if (mode === 'new') rows = rows.filter(isNewOpportunity); // not held + attractive
    if (sector) rows = rows.filter((r) => r.sector === sector);
    if (theme) rows = rows.filter((r) => r.theme === theme);
    if (verdict) rows = rows.filter((r) => r.verdict === verdict);
    rows = [...rows];
    if (sortBy === 'fresh') {
      // Freshly attractive first, then biggest price drop, then attractiveness.
      rows.sort((a, b) =>
        Number(b.isNew) - Number(a.isNew) ||
        (a.priceChangePct ?? 0) - (b.priceChangePct ?? 0) ||
        b.attractiveness - a.attractiveness);
    } else {
      rows.sort((a, b) => b.attractiveness - a.attractiveness || (b.marginOfSafety ?? -1) - (a.marginOfSafety ?? -1));
    }
    return rows;
  }, [data, mode, sector, theme, verdict, sortBy]);

  // Names that newly became attractive since the last scan (movers strip).
  const freshNames = useMemo(() => filtered.filter((r) => r.isNew), [filtered]);

  // The map reflects the mode (not the dropdown filters): all names, or not-yet-owned
  // attractive names only.
  const mapRows = useMemo(
    () => (mode === 'new' ? (data?.rows ?? []).filter(isNewOpportunity) : (data?.rows ?? [])),
    [data, mode],
  );

  const grouped = useMemo(() => {
    if (groupBy === 'none') return null;
    const keyOf = (r: ScreenerRow) =>
      groupBy === 'sector' ? (r.sector ?? 'Other')
        : groupBy === 'theme' ? (r.theme ?? 'Other')
        : (r.country ? (countryName.get(r.country) ?? r.country) : 'Unknown market');
    const m = new Map<string, ScreenerRow[]>();
    for (const r of filtered) {
      const k = keyOf(r);
      (m.get(k) ?? m.set(k, []).get(k)!).push(r);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [filtered, groupBy, countryName]);

  // Open the fair-value detail modal without leaving Discover (modals, not redirects).
  const openRow = (sym: string) => {
    const r = (data?.rows ?? []).find((x) => x.symbol === sym);
    openModal({ kind: 'opportunity', symbol: sym, name: r?.name, price: r?.price, currency: r?.currency });
  };
  const openReplay = (symbol: string, name?: string | null) => openModal({ kind: 'replay', symbol, name });

  return (
    <div className="p-6 max-w-[1280px] mx-auto">
      <header className="mb-4">
        <div className="eyebrow mb-1">Discover</div>
        <h1 className="font-display text-2xl font-semibold">Undervalued opportunities</h1>
        <p className="text-sm text-text-muted mt-1 max-w-3xl">
          Screens the global universe for value, maps where the opportunities are, and ranks each
          name by an attractiveness score blending Graham/Buffett intrinsic value, margin of safety,
          quality, supportable return and portfolio fit. Being cheap is not enough — a low-quality
          bargain is flagged <span className="text-warn">cheap only</span>, not attractive.
        </p>
      </header>

      {isLoading ? (
        <Spinner label="Screening the universe…" />
      ) : isError || !data ? (
        <EmptyState title="Couldn't run the screen" hint="Is the backend running? It needs a restart to pick up the screener route." />
      ) : (
        <>
          <div className="flex items-center gap-2 text-[12px] text-text-faint mb-3 flex-wrap">
            <Info size={13} />
            <span>
              Scored <span className="text-text">{data.analysedCount}</span> of {data.universeSize} names.
              {mode === 'new' && (
                <> <span className="text-gain">{data.rows.filter(isNewOpportunity).length}</span> not-yet-owned opportunities.</>
              )}
            </span>
          </div>

          {/* Universe warmer — fetches the missing fundamentals so the whole universe
              becomes screenable. Cache is an optimisation, not an eligibility filter. */}
          {warm && warm.missing > 0 && (
            <div className="card mb-5 !py-3">
              <div className="flex items-center gap-3 flex-wrap">
                {warm.running
                  ? <Loader2 size={15} className="text-azure animate-spin shrink-0" />
                  : <DownloadCloud size={15} className="text-text-muted shrink-0" />}
                <div className="flex-1 min-w-[220px]">
                  <div className="text-[13px] text-text">
                    {warm.running
                      ? <>Fetching fundamentals across the universe… <span className="font-mono tnum">{warm.cached}</span>/{warm.universeTotal} ready</>
                      : <><span className="font-mono tnum text-text">{warm.cached}</span>/{warm.universeTotal} names ready · {warm.missing} still to fetch</>}
                  </div>
                  <div className="mt-1.5 h-1.5 rounded-full bg-surface-2 overflow-hidden">
                    <div className="h-full rounded-full bg-azure transition-all"
                      style={{ width: `${Math.round((warm.cached / Math.max(1, warm.universeTotal)) * 100)}%` }} />
                  </div>
                  {warm.running && warm.lastSymbol && (
                    <div className="text-[10px] text-text-faint mt-1 font-mono">…{warm.lastSymbol}{warm.failed > 0 ? ` · ${warm.failed} unavailable` : ''}</div>
                  )}
                </div>
                <button className="btn-secondary shrink-0" disabled={warm.running || warmAll.isPending}
                  onClick={() => warmAll.mutate()}>
                  <DownloadCloud size={14} /> {warm.running ? 'Fetching…' : 'Fetch all remaining'}
                </button>
              </div>
              <p className="text-[11px] text-text-faint mt-2">
                Fetched in throttled batches to respect the data provider's rate limit; results refresh
                automatically as names load. Names the provider can't return are retried on the next scan.
              </p>
            </div>
          )}

          {data.analysedCount === 0 ? (
            (warm && (warm.running || warm.missing > 0)) ? (
              <EmptyState
                title="Fetching fundamentals for the universe…"
                hint="The screener is loading the data it needs to value each name. Results will appear here as they load — this respects the provider's rate limit, so give it a moment."
              />
            ) : (
              <EmptyState
                title="No names have fundamentals cached yet"
                hint="Open a few companies in Research or hold/watch them, then come back — or use ‘Fetch all remaining’ above."
              />
            )
          ) : (
            <>
              {/* Mode toggle — All names (default, unchanged) vs New opportunities. */}
              <div className="flex items-center gap-3 mb-4 flex-wrap">
                <Segmented
                  options={[{ value: 'all', label: 'All names' }, { value: 'new', label: 'New opportunities' }]}
                  value={mode}
                  onChange={(m) => { setMode(m as Mode); if (m === 'new') setSortBy('fresh'); }}
                />
                {mode === 'new' && (
                  <span className="text-[12px] text-text-faint">
                    Not-yet-owned names that clear the attractiveness bar — held names hidden.
                  </span>
                )}
              </div>

              {/* World map — where the value is, by market (reflects the mode). */}
              {(data.geo?.length ?? 0) > 0 && (
                <div className="card mb-6">
                  <div className="eyebrow mb-3 flex items-center gap-2"><Globe2 size={13} /> Opportunity map</div>
                  <DiscoverMap geo={data.geo} rows={mapRows} onOpen={openRow} onReplay={openReplay} />
                </div>
              )}

              {/* Freshly-attractive strip in New-opportunities mode. */}
              {mode === 'new' && freshNames.length > 0 && (
                <div className="card mb-6 border-l-2 border-l-gain bg-gain/5">
                  <div className="eyebrow mb-2 flex items-center gap-2"><Sparkles size={13} className="text-gain" /> New opportunities today</div>
                  <div className="flex flex-wrap gap-2">
                    {freshNames.map((r) => (
                      <button key={r.symbol} onClick={() => openRow(r.symbol)}
                        className="chip !py-1 hover:border-gain/50 transition-colors"
                        title={`Became attractive · MoS ${r.marginOfSafety != null ? fmtPct(r.marginOfSafety, 0) : '—'}`}>
                        <span className="w-1.5 h-1.5 rounded-full bg-gain" />
                        <span className="font-mono text-text ml-1.5">{r.symbol}</span>
                        {r.priceChangePct != null && r.priceChangePct < 0 && (
                          <span className="text-loss ml-1.5 tnum">{fmtPctSigned(r.priceChangePct, 0)}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3 mb-4 flex-wrap">
                <select className="input w-auto" value={sector} onChange={(e) => setSector(e.target.value)}>
                  <option value="">All sectors</option>
                  {data.sectors.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <select className="input w-auto" value={theme} onChange={(e) => setTheme(e.target.value)}>
                  <option value="">All industries / themes</option>
                  {(data.themes ?? []).map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                {mode === 'all' && (
                  <select className="input w-auto" value={verdict} onChange={(e) => setVerdict(e.target.value)}>
                    {VERDICT_FILTERS.map((v) => (
                      <option key={v.value} value={v.value}>{v.label}</option>
                    ))}
                  </select>
                )}
                <div className="flex items-center gap-2 ml-auto">
                  <label className="text-[12px] text-text-faint">Group</label>
                  <select className="input w-auto" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
                    <option value="none">No grouping</option>
                    <option value="sector">Sector</option>
                    <option value="theme">Industry / theme</option>
                    <option value="country">Country</option>
                  </select>
                  <label className="text-[12px] text-text-faint ml-1">Sort</label>
                  <select className="input w-auto" value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
                    <option value="attractiveness">Attractiveness</option>
                    <option value="fresh">Recently attractive / price drop</option>
                  </select>
                </div>
              </div>

              <div className="card">
                <div className="overflow-x-auto -mx-5">
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        <th className="th">Company</th>
                        <th className="th">Sector</th>
                        <th className="th text-right">Price</th>
                        <th className="th text-right">Margin of safety</th>
                        <th className="th text-right">Quality</th>
                        <th className="th text-right">Supportable</th>
                        <th className="th text-right">Yield</th>
                        <th className="th">Portfolio fit</th>
                        <th className="th text-right">Attractiveness</th>
                        <th className="th">Verdict</th>
                        <th className="th w-10"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {grouped
                        ? grouped.map(([sec, rows]) => (
                            <SectorGroup key={sec} sector={sec} rows={rows} watched={watchedSymbols} onOpen={openRow} onWatch={(r) => addWatch.mutate(r)} onReplay={openReplay} />
                          ))
                        : filtered.map((r) => (
                            <Row key={r.symbol} r={r} watched={watchedSymbols.has(r.symbol)} onOpen={openRow} onWatch={() => addWatch.mutate(r)} onReplay={openReplay} />
                          ))}
                    </tbody>
                  </table>
                </div>
                {filtered.length === 0 && (
                  <p className="text-sm text-text-faint mt-3">
                    {mode === 'new'
                      ? 'No not-yet-owned names clear the bar in this slice yet. '
                      : 'No names match these filters. '}
                    Open more companies in Research to fetch their fundamentals, then re-run the screen.
                  </p>
                )}
                <p className="text-[11px] text-text-faint mt-3">
                  Intrinsic value from Graham number / Graham growth / owner-earnings DCF on cached
                  fundamentals. Supportable = earnings growth + dividend yield. Estimates, not advice.
                </p>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function SectorGroup({
  sector,
  rows,
  watched,
  onOpen,
  onWatch,
  onReplay,
}: {
  sector: string;
  rows: ScreenerRow[];
  watched: Set<string>;
  onOpen: (s: string) => void;
  onWatch: (r: ScreenerRow) => void;
  onReplay: (s: string, name?: string | null) => void;
}) {
  return (
    <>
      <tr>
        <td colSpan={11} className="pt-4 pb-1 px-3 eyebrow text-gold">{sector} · {rows.length}</td>
      </tr>
      {rows.map((r) => (
        <Row key={r.symbol} r={r} watched={watched.has(r.symbol)} onOpen={onOpen} onWatch={() => onWatch(r)} onReplay={onReplay} />
      ))}
    </>
  );
}

function Row({
  r,
  watched,
  onOpen,
  onWatch,
  onReplay,
}: {
  r: ScreenerRow;
  watched: boolean;
  onOpen: (s: string) => void;
  onWatch: () => void;
  onReplay: (s: string, name?: string | null) => void;
}) {
  const v = VERDICT_META[r.verdict];
  return (
    <tr className="hover:bg-surface-2">
      <td className="td">
        <button className="group inline-flex items-center gap-1.5 text-left" onClick={() => onOpen(r.symbol)}>
          <span className="font-mono text-azure group-hover:underline">{r.symbol}</span>
          <ArrowUpRight size={12} className="text-text-faint opacity-0 group-hover:opacity-100" />
        </button>
        {r.inPortfolio && <span className="ml-2 text-[10px] uppercase text-gain/80">held</span>}
        {r.isNew && (
          <span className="ml-2 chip !py-0 !px-1.5 text-[9px] text-gain border-gain/40" title="Newly became attractive since the last scan">NEW</span>
        )}
        {r.name && <div className="text-[12px] text-text-muted truncate max-w-[220px]">{r.name}</div>}
        {r.theme && r.theme !== r.sector && (
          <div className="text-[10px] text-text-faint uppercase tracking-wide">{r.theme}</div>
        )}
      </td>
      <td className="td text-text-muted text-[13px]">{r.sector ?? '—'}</td>
      <td className="td text-right font-mono tnum text-text-muted">
        {r.price != null ? `${r.currency ?? ''} ${fmtNum(r.price)}` : '—'}
      </td>
      <td className={clsx('td text-right font-mono tnum', plClass(r.marginOfSafety))}>{fmtPctSigned(r.marginOfSafety)}</td>
      <td className="td text-right font-mono tnum text-text-muted">{r.quality.score}/{r.quality.max}</td>
      <td className="td text-right font-mono tnum text-text-muted">{fmtPct(r.supportableReturn)}</td>
      <td className="td text-right font-mono tnum text-text-muted">{r.dividendYield ? fmtPct(r.dividendYield) : '—'}</td>
      <td className="td">
        <span className={clsx('text-[13px] capitalize', FIT_CLS[r.portfolioFit.status] ?? 'text-text-muted')}>
          {r.portfolioFit.status}
        </span>
      </td>
      <td className="td text-right"><div className="flex justify-end"><AttractivenessBar value={r.attractiveness} /></div></td>
      <td className="td">
        <span className={clsx('inline-block px-2 py-0.5 rounded border text-[11px] font-medium', v.cls)}>{v.label}</span>
      </td>
      <td className="td text-right">
        <div className="flex items-center justify-end gap-2">
          <button
            className="text-text-faint hover:text-azure transition-colors"
            title="Point-in-time replay — was it attractive at a past date?"
            onClick={() => onReplay(r.symbol, r.name)}
          >
            <Clock size={14} />
          </button>
          <button
            className={clsx('transition-colors', watched ? 'text-azure' : 'text-text-faint hover:text-azure')}
            title={watched ? 'On your watchlist' : 'Add to watchlist'}
            onClick={onWatch}
            disabled={watched}
          >
            <Eye size={14} />
          </button>
        </div>
      </td>
    </tr>
  );
}
