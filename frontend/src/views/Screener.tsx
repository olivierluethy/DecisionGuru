import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowUpRight, Eye, Info, Clock, Globe2, Sparkles, Loader2, DownloadCloud, ChevronDown } from 'lucide-react';
import { api, type ScreenerRow } from '../lib/api';
import { useApp } from '../store';
import { Spinner, EmptyState, Segmented } from '../components/ui';
import { DiscoverMap } from '../components/DiscoverMap';
import { VerdictBadge, VERDICT_META } from '../components/Verdict';
import { DiscoverFilterBar, computeDomains, passesRanges, type Ranges } from '../components/DiscoverFilters';
import { useDebounced } from '../lib/useDebounced';
import { exchangeTag } from '../lib/exchanges';
import { fmtPct, fmtPctSigned, fmtNum, plClass } from '../lib/format';

const FIT_CLS: Record<string, string> = {
  'new sector': 'text-azure',
  diversifies: 'text-azure',
  neutral: 'text-text-muted',
  concentrates: 'text-loss',
  unknown: 'text-text-faint',
};

const VERDICT_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All verdicts' },
  { value: 'buy-more', label: 'Buy more' },
  { value: 'hold', label: 'Hold' },
  { value: 'sell', label: 'Sell' },
];

/** A sortable column header: the `.th` cell wraps a full-width button; the active
 *  column shows a chevron (down = descending, up = ascending), hidden otherwise. */
function SortHeader({
  label, col, sortCol, sortDir, onSort, align = 'left',
}: {
  label: string;
  col: SortCol;
  sortCol: SortCol;
  sortDir: SortDir;
  onSort: (c: SortCol) => void;
  align?: 'left' | 'right';
}) {
  const active = sortCol === col;
  return (
    <th className={clsx('th', align === 'right' && 'text-right')}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={clsx(
          'inline-flex items-center gap-1 select-none hover:text-text transition-colors uppercase',
          align === 'right' && 'flex-row-reverse',
          active ? 'text-text' : 'text-text-muted',
        )}
        aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <span>{label}</span>
        <ChevronDown
          size={12}
          className={clsx('shrink-0 transition-transform', !active && 'opacity-0', sortDir === 'asc' && 'rotate-180')}
        />
      </button>
    </th>
  );
}

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
// Every results column is a sort key, plus 'fresh' — the movers ordering (recently
// attractive, then biggest price drop) that isn't expressible as a single column.
type SortCol =
  | 'company' | 'sector' | 'price' | 'mos' | 'quality' | 'supportable'
  | 'yield' | 'fit' | 'attractiveness' | 'verdict' | 'fresh';
type SortDir = 'asc' | 'desc';

const TEXT_COLS = new Set<SortCol>(['company', 'sector', 'verdict']);
// Best-fit-first ordering so Portfolio-fit sorts numerically like the other columns.
const FIT_RANK: Record<string, number> = {
  'new sector': 4, diversifies: 3, neutral: 2, concentrates: 1, unknown: 0,
};

/** A not-yet-owned name the shared engine rates Buy more. */
function isNewOpportunity(r: ScreenerRow): boolean {
  return !r.inPortfolio && r.verdict === 'buy-more';
}

/** Numeric value backing a numeric sort column (null → sorted last, both directions). */
function numVal(r: ScreenerRow, col: SortCol): number | null {
  switch (col) {
    case 'price': return r.price;
    case 'mos': return r.marginOfSafety;
    case 'quality': return r.quality.max ? r.quality.score / r.quality.max : null;
    case 'supportable': return r.supportableReturn;
    case 'yield': return r.dividendYield;
    case 'fit': return FIT_RANK[r.portfolioFit.status] ?? 0;
    case 'attractiveness': return r.attractiveness;
    default: return null;
  }
}

/** Text value backing an alphabetical sort column. */
function textVal(r: ScreenerRow, col: SortCol): string {
  switch (col) {
    case 'company': return r.symbol;
    case 'sector': return r.sector ?? '';
    case 'verdict': return VERDICT_META[r.verdict]?.label ?? '';
    default: return '';
  }
}

export function Screener() {
  const qc = useQueryClient();
  const openModal = useApp((s) => s.openModal);
  const [mode, setMode] = useState<Mode>('all');
  const [sector, setSector] = useState('');
  const [theme, setTheme] = useState('');
  const [verdict, setVerdict] = useState('');
  // Numeric range filters (yield, MoS, quality, supportable, price). Debounced so dragging
  // a slider stays smooth; they compose by AND with the dropdowns and the mode toggle.
  const [ranges, setRanges] = useState<Ranges>({});
  const debouncedRanges = useDebounced(ranges, 100);
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [sortCol, setSortCol] = useState<SortCol>('attractiveness');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Click a header to sort by it; click the active header again to flip direction.
  // First click defaults to descending for numeric columns (biggest first) and
  // ascending for text columns (A→Z) — the useful default in each case.
  const onSort = (col: SortCol) => {
    if (col === sortCol) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir(TEXT_COLS.has(col) ? 'asc' : 'desc');
    }
  };

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

  // Slider bounds come from the whole scored set, so they stay stable as other filters and
  // the mode change — the ends are always reachable.
  const domains = useMemo(() => computeDomains(data?.rows ?? []), [data]);

  const filtered = useMemo(() => {
    let rows = data?.rows ?? [];
    if (mode === 'new') rows = rows.filter(isNewOpportunity); // not held + attractive
    if (sector) rows = rows.filter((r) => r.sector === sector);
    if (theme) rows = rows.filter((r) => r.theme === theme);
    if (verdict) rows = rows.filter((r) => r.verdict === verdict);
    rows = rows.filter((r) => passesRanges(r, debouncedRanges, domains));
    rows = [...rows];
    const dir = sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      if (sortCol === 'fresh') {
        // Freshly attractive first, then biggest price drop, then attractiveness.
        return Number(b.isNew) - Number(a.isNew) ||
          (a.priceChangePct ?? 0) - (b.priceChangePct ?? 0) ||
          b.attractiveness - a.attractiveness;
      }
      let primary: number;
      if (TEXT_COLS.has(sortCol)) {
        primary = textVal(a, sortCol).localeCompare(textVal(b, sortCol)) * dir;
      } else {
        const av = numVal(a, sortCol), bv = numVal(b, sortCol);
        // Nulls always sort last, regardless of direction.
        if (av == null && bv == null) primary = 0;
        else if (av == null) primary = 1;
        else if (bv == null) primary = -1;
        else primary = (av - bv) * dir;
      }
      // Stable tie-break: strongest names first.
      return primary || b.attractiveness - a.attractiveness;
    });
    return rows;
  }, [data, mode, sector, theme, verdict, debouncedRanges, domains, sortCol, sortDir]);

  // Names that newly became attractive since the last scan (movers strip).
  const freshNames = useMemo(() => filtered.filter((r) => r.isNew), [filtered]);

  // The map reflects the mode and the numeric value filters (so density recomputes live as
  // you refine), but not the categorical dropdowns — those have the country drill-in.
  const mapRows = useMemo(() => {
    const base = mode === 'new' ? (data?.rows ?? []).filter(isNewOpportunity) : (data?.rows ?? []);
    return base.filter((r) => passesRanges(r, debouncedRanges, domains));
  }, [data, mode, debouncedRanges, domains]);

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
          quality, supportable return and portfolio fit. The verdict is the same one every view
          uses — being cheap is not enough, a low-quality bargain reads <span className="text-text-muted">Hold</span>
          (a value trap), not <span className="text-gain">Buy more</span>.
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
              {' '}Showing <span className="text-text tnum">{filtered.length}</span>.
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
                  onChange={(m) => {
                    setMode(m as Mode);
                    // New-opportunities defaults to the movers ordering; All names to attractiveness.
                    if (m === 'new') { setSortCol('fresh'); }
                    else { setSortCol('attractiveness'); setSortDir('desc'); }
                  }}
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
                  {/* Movers ordering can't be expressed as a single column, so it keeps a control. */}
                  <button
                    className={clsx('btn-secondary !h-9', sortCol === 'fresh' && '!border-gain/50 !text-gain')}
                    onClick={() => (sortCol === 'fresh' ? onSort('attractiveness') : setSortCol('fresh'))}
                    title="Sort by recently-attractive names and biggest price drops"
                  >
                    <Sparkles size={14} /> Movers
                  </button>
                </div>
              </div>

              {/* Numeric range filters — compose by AND with the dropdowns above and the
                  mode toggle; recompute the table, count and map live. */}
              <DiscoverFilterBar
                rows={data.rows}
                ranges={ranges}
                onRanges={setRanges}
                otherActiveCount={(sector ? 1 : 0) + (theme ? 1 : 0) + (verdict ? 1 : 0)}
                onClearAll={() => { setRanges({}); setSector(''); setTheme(''); setVerdict(''); }}
              />

              <div className="card">
                <div className="overflow-x-auto -mx-5">
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        <SortHeader label="Company" col="company" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
                        <SortHeader label="Sector" col="sector" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
                        <SortHeader label="Price" col="price" align="right" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
                        <SortHeader label="Margin of safety" col="mos" align="right" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
                        <SortHeader label="Quality" col="quality" align="right" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
                        <SortHeader label="Supportable" col="supportable" align="right" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
                        <SortHeader label="Yield" col="yield" align="right" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
                        <SortHeader label="Portfolio fit" col="fit" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
                        <SortHeader label="Attractiveness" col="attractiveness" align="right" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
                        <SortHeader label="Verdict" col="verdict" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
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
  return (
    <tr className="hover:bg-surface-2">
      <td className="td">
        <button className="group inline-flex items-center gap-1.5 text-left" onClick={() => onOpen(r.symbol)}>
          <span className="font-mono text-azure group-hover:underline">{r.symbol}</span>
          <ArrowUpRight size={12} className="text-text-faint opacity-0 group-hover:opacity-100" />
        </button>
        {exchangeTag(r.symbol) && (
          <span className="ml-2 text-[10px] uppercase tracking-wide text-text-faint" title="Listing exchange (open for the recommended listing)">
            {exchangeTag(r.symbol)}
          </span>
        )}
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
      <td className="td"><VerdictBadge verdict={r.verdict} action={r.recommendation?.action} /></td>
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
