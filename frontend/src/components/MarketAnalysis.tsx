import {
  memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject,
} from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { X } from 'lucide-react';
import clsx from 'clsx';
import { api, type MarketAnalysisResult, type MarketClassification, type MarketCompetitor } from '../lib/api';
import { Spinner, EmptyState } from './ui';
import { fmtPct, fmtPctSigned, fmtMoney, fmtDate } from '../lib/format';
import { useApp } from '../store';
import { ComparisonSelect } from './ComparisonSelect';
import { MarketPosition } from './MarketPosition';
import { MarketScatter, marketScatterPoints, type MarketScatterPoint } from './MarketScatter';

const RANGES = ['1M', '3M', '6M', '1Y', '3Y', '5Y'] as const;
type MarketRange = (typeof RANGES)[number];

const CLASS_META: Record<MarketClassification, { label: string; tone: string; blurb: string }> = {
  'market-wide-weakness': { label: 'Market-wide weakness', tone: 'text-warn',
    blurb: 'The whole sector is down — the weakness is largely the market, not the company alone.' },
  'company-specific-weakness': { label: 'Company-specific weakness', tone: 'text-loss',
    blurb: 'The sector is holding up while this company lags — the weakness looks specific to it.' },
  'outperforming-sector': { label: 'Outperforming its sector', tone: 'text-gain',
    blurb: 'Ahead of its sector benchmark over this horizon.' },
  'outperforming-peers': { label: 'Outperforming peers', tone: 'text-gain',
    blurb: 'Ahead of both its sector and the median competitor over this horizon.' },
  inline: { label: 'In line with its market', tone: 'text-text-muted',
    blurb: 'Tracking its sector and peers over this horizon.' },
};

// Distinct dark-legible line colours; azure is always the subject.
const LINE_COLORS = ['#4FD0E0', '#D9A94E', '#A98BFF', '#B6D94E', '#EC6DB0'];

/** Sortable columns of the comparables table. `rank` is the value × strength composite
 *  (best first); it only exists once the market is large enough to rank inside. */
type SortKey = 'rank' | 'valuePct' | 'strengthPct' | 'marketCap' | 'trailingPE'
  | 'profitMargins' | 'return' | 'relative';

const ASCENDING_BY_DEFAULT: SortKey[] = ['rank', 'trailingPE'];

/** The value a row sorts on for a given column, or null when it can't be compared. */
function sortValue(c: MarketCompetitor, key: SortKey, range: string): number | null {
  switch (key) {
    case 'rank': return c.rank ?? null;
    case 'valuePct': return c.valuePct ?? null;
    case 'strengthPct': return c.strengthPct ?? null;
    case 'marketCap': return c.marketCapCHF ?? null;
    case 'trailingPE': return c.trailingPE ?? null;
    case 'profitMargins': return c.profitMargins ?? null;
    case 'return': return c.returns[range] ?? null;
    case 'relative': return c.isSubject ? null : c.relativeToSubjectPct ?? null;
  }
}

/** Click-to-sort column header; the arrow shows the active column and direction. */
function SortableTh({ label, sortKey, title, sort, onSort }: {
  label: string; sortKey: SortKey; title?: string;
  sort: { key: SortKey; dir: 'asc' | 'desc' }; onSort: (key: SortKey) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <th className="th text-right">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={title ?? `Sort by ${label}`}
        className={`inline-flex items-center gap-1 cursor-pointer hover:text-text ${active ? 'text-text' : ''}`}
      >
        {label}
        <span className="text-[9px] leading-none">{active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  );
}

export function MarketAnalysis({ symbol }: { symbol: string }) {
  const [range, setRange] = useState<MarketRange>('1Y');
  const defaultBenchmark = useApp((s) => s.benchmark);
  // Comparison lines are user-selectable: seed with the global benchmark (e.g. VWRL.SW), then
  // freely add/remove ETFs or companies — even from another market — via the selector below.
  const [compare, setCompare] = useState<string[]>(defaultBenchmark ? [defaultBenchmark] : []);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['market-analysis', symbol, range, compare.join(',')],
    queryFn: () => api.marketAnalysis(symbol, range, compare),
    staleTime: 60 * 60_000,
    retry: 1,
    // Keep the prior chart on screen while a changed comparison set reloads, so the selector
    // never flashes back to a spinner mid-edit.
    placeholderData: keepPreviousData,
    // Peer price history is warmed in the background on first open; poll until peer returns
    // land (or give up after a bounded number of tries) so the table fills in on its own.
    refetchInterval: (query) => {
      const d = query.state.data as MarketAnalysisResult | undefined;
      if (!d) return false;
      const peers = d.competitors.filter((c) => !c.isSubject);
      const incomplete = peers.length > 0 && peers.some((c) => c.returns[d.range] == null);
      return incomplete && query.state.dataUpdateCount < 12 ? 4000 : false;
    },
  });

  if (isLoading) return <Spinner label="Reading the market…" />;
  if (isError || !data) return <EmptyState title="Market analysis unavailable" hint="Try again shortly." />;

  return (
    <MarketAnalysisBody
      data={data} range={range} onRange={setRange} compare={compare} onCompare={setCompare}
    />
  );
}

/**
 * The loaded section. Split out from the query wrapper so every hook below can assume real
 * data — and so the hover state that binds the chart, the comparables table and the floating
 * mini-map together has one owner with all three in scope.
 */
function MarketAnalysisBody({ data, range, onRange, compare, onCompare }: {
  data: MarketAnalysisResult;
  range: MarketRange;
  onRange: (r: MarketRange) => void;
  compare: string[];
  onCompare: (c: string[]) => void;
}) {
  // Default to the composite rank — "who is the better bet here" is the question the table
  // is there to answer; every other column stays one click away.
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'rank', dir: 'asc' });
  const openModal = useApp((s) => s.openModal);

  // The company the pointer is on, wherever it came from: a table row, a dot in the chart,
  // or a dot in the mini-map. A ticker, i.e. exactly the key the table rows already use —
  // there is no second mapping between list and chart to fall out of sync.
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => { setActive(null); }, [data.symbol]);

  const compareColorOf = (sym: string) => {
    const i = compare.indexOf(sym);
    return i >= 0 ? LINE_COLORS[(i + 1) % LINE_COLORS.length] : '#5F6E82';
  };

  const cls = data.classification ? CLASS_META[data.classification] : null;

  // Build a merged {date → {subject, sp500, world, sector}} for the multi-line chart.
  // Memoised: hovering a company must not rebuild the rebased series.
  const { lines, chartData } = useMemo(() => {
    const ls: { key: string; label: string; color: string; series: { date: string; value: number }[] }[] = [];
    ls.push({ key: 'subject', label: data.symbol, color: '#4FD0E0', series: data.subject.series });
    data.benchmarks.forEach((b, i) => {
      if (b.series.length > 1) ls.push({ key: b.key, label: b.symbol, color: LINE_COLORS[(i + 1) % LINE_COLORS.length], series: b.series });
    });
    if (data.sectorLine.kind === 'etf' && data.sectorLine.series.length > 1) {
      ls.push({ key: 'sector', label: data.sectorLine.label, color: '#B6D94E', series: data.sectorLine.series });
    }
    const byDate = new Map<string, Record<string, number | string>>();
    for (const ln of ls) for (const p of ln.series) {
      const row = byDate.get(p.date) ?? { date: p.date };
      row[ln.key] = p.value;
      byDate.set(p.date, row);
    }
    return {
      lines: ls,
      chartData: [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))),
    };
  }, [data]);

  // Client-side sort so switching column never costs a request. Rows the column can't
  // compare (no data) always sink to the bottom, whichever direction is active.
  const rows = useMemo(() => [...data.competitors].sort((a, b) => {
    const av = sortValue(a, sort.key, range);
    const bv = sortValue(b, sort.key, range);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return sort.dir === 'asc' ? av - bv : bv - av;
  }), [data.competitors, sort, range]);

  // One derivation of the plotted set, shared by the full chart and the mini-map.
  const points = useMemo(() => marketScatterPoints(data.competitors), [data.competitors]);
  const plotted = useMemo(() => new Set(points.map((p) => p.symbol)), [points]);
  const activePoint = useMemo(
    () => (active ? points.find((p) => p.symbol === active) ?? null : null),
    [points, active],
  );
  // MarketPosition only draws the plane above a handful of scored companies.
  const hasScatter = Boolean(data.marketPosition) && points.length > 2;

  const chartRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const showMini = useMiniMapVisibility({ chartRef, listRef, enabled: hasScatter });

  const revealRow = useRevealRow(listRef);
  const onRowHover = useCallback((sym: string | null) => setActive(sym), []);
  const onRowOpen = useCallback((c: MarketCompetitor) => {
    openModal({ kind: 'opportunity', symbol: c.symbol, name: c.name, currency: c.currency });
  }, [openModal]);
  // Only the mini-map scrolls the list: it is on screen next to the rows, so bringing a row
  // into view is a small, legible move. Doing it from the full chart would scroll the chart
  // itself out from under the pointer.
  const onMiniActive = useCallback((sym: string | null) => {
    setActive(sym);
    revealRow(sym);
  }, [revealRow]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: ASCENDING_BY_DEFAULT.includes(key) ? 'asc' : 'desc' }));

  const th = (label: string, sortKey: SortKey, title?: string) => (
    <SortableTh key={sortKey} label={label} sortKey={sortKey} title={title} sort={sort} onSort={toggleSort} />
  );

  return (
    <div className="space-y-5">
      {/* Comparison selector — subject vs. any benchmark ETFs and/or companies (any market). */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow mr-1">Compare</span>
        <ComparisonSelect subject={data.symbol} selected={compare} onChange={onCompare} colorOf={compareColorOf} />
      </div>

      {/* Company context */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div><span className="eyebrow mr-2">Company</span><span className="text-text">{data.name}</span></div>
        <div><span className="eyebrow mr-2">Sector</span><span className="text-text">{data.sector ?? 'unavailable'}</span></div>
        <div><span className="eyebrow mr-2">Industry</span><span className="text-text">{data.industry ?? 'unavailable'}</span></div>
      </div>

      {/* Range selector */}
      <div className="flex flex-wrap gap-1.5">
        {RANGES.map((r) => (
          <button key={r} onClick={() => onRange(r)}
            className={`chip cursor-pointer ${range === r ? '!border-azure/50 !text-text' : 'opacity-50'}`}>{r}</button>
        ))}
      </div>

      {/* Is another company in this market the better bet? Value × strength, ranked. */}
      {data.marketPosition && (
        <MarketPosition
          position={data.marketPosition} points={points} range={range}
          active={active} onActiveChange={setActive} chartRef={chartRef}
        />
      )}

      {/* Market-vs-company headline */}
      {cls && (
        <div className={`card !p-4 border-l-2 ${cls.tone === 'text-loss' ? 'border-l-loss' : cls.tone === 'text-gain' ? 'border-l-gain' : 'border-l-warn'}`}>
          <div className={`font-semibold ${cls.tone}`}>{cls.label}</div>
          <p className="text-sm text-text-muted mt-1">{cls.blurb}</p>
          <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-[12px]">
            <span><span className="eyebrow mr-1">This stock</span><span className={data.subject.returnPct == null ? 'text-text-faint' : data.subject.returnPct < 0 ? 'text-loss' : 'text-gain'}>{fmtPctSigned(data.subject.returnPct)}</span></span>
            <span><span className="eyebrow mr-1">Sector</span>{fmtPctSigned(data.sectorLine.returnPct)} <span className="text-text-faint">({data.sectorLine.kind === 'peer-median' ? 'peer median' : data.sectorLine.kind === 'etf' ? data.sectorLine.symbol : 'n/a'})</span></span>
            <span><span className="eyebrow mr-1">Peer median</span>{fmtPctSigned(data.peerMedianReturnPct)}</span>
            {data.benchmarks.map((b) => (
              <span key={b.key}><span className="eyebrow mr-1">{b.symbol}</span>{fmtPctSigned(b.returnPct)}</span>
            ))}
          </div>
        </div>
      )}

      {/* Rebased performance chart */}
      <RebasedChart lines={lines} chartData={chartData} />

      {/* Competitor table */}
      <div>
        <div className="eyebrow mb-2">
          Comparable companies · same market{data.marketPosition ? ', best positioned first' : ', ranked by market cap (CHF)'}
        </div>
        {data.competitors.length === 0 ? (
          <p className="text-sm text-text-faint">No comparable companies with cached data yet. Open a few same-industry names in Research/Discover to build the peer set.</p>
        ) : (
          <div ref={listRef} className="border border-hairline rounded overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="th">Company</th>
                    {data.marketPosition && (
                      <>
                        {th('#', 'rank', 'Rank in this market — value and market strength weighted equally')}
                        {th('Value', 'valuePct', 'Percentile inside this market: how cheap, higher is cheaper')}
                        {th('Strength', 'strengthPct', 'Percentile inside this market: price return, revenue growth and net margin')}
                      </>
                    )}
                    {th('Mkt cap', 'marketCap')}
                    {th('P/E', 'trailingPE')}
                    {th('Net margin', 'profitMargins')}
                    {th(`${range} return`, 'return')}
                    {th('vs this stock', 'relative')}
                  </tr>
                </thead>
                <tbody onMouseLeave={() => setActive(null)}>
                  {rows.map((c) => (
                    <CompetitorRow
                      key={c.symbol}
                      c={c}
                      range={range}
                      showPosition={Boolean(data.marketPosition)}
                      showMarker={hasScatter}
                      plotted={plotted.has(c.symbol)}
                      isActive={active === c.symbol}
                      onHover={onRowHover}
                      onOpen={onRowOpen}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <p className="text-[11px] text-text-faint mt-1">
          Peers share the same market (sector + industry) and have cached data. Value and Strength
          are percentile ranks <em>within this market</em> (higher is better); # weights them
          equally. Click any header to re-sort. Market cap is converted to CHF (omitted when no
          FX rate).
          {hasScatter && <> Hover a row to light up that company in the market position chart; a
            hollow marker means the company has no value × strength score yet, so it has no dot.</>}
        </p>
      </div>

      {/* Opportunity-cost / valuation tie-in */}
      {data.valuation && data.valuation.band && (
        <div className="card !p-4">
          <div className="eyebrow mb-1">Opportunity cost · valuation</div>
          <p className="text-sm text-text-muted">
            Valuation reads <span className="text-text">{data.valuation.band.band.replace(/-/g, ' ')}</span>
            {data.valuation.marginOfSafety != null && (
              <> · margin of safety <span className={data.valuation.marginOfSafety < 0 ? 'text-loss' : 'text-gain'}>{fmtPctSigned(data.valuation.marginOfSafety)}</span></>
            )}. Read this together with the relative performance above: a name that is both expensive and lagging its market carries a higher opportunity cost than one that is merely lagging a strong sector.
          </p>
        </div>
      )}

      {/* The market plane, kept within reach while the table is being read. */}
      {hasScatter && (
        <MiniMarketMap
          points={points} active={active} activePoint={activePoint}
          onActiveChange={onMiniActive}
          onOpen={(p) => openModal({ kind: 'opportunity', symbol: p.symbol, name: p.name })}
          open={showMini}
        />
      )}
    </div>
  );
}

/** The rebased multi-line chart. Memoised so pointing at a company — which re-renders the
 *  section on every crossing — never re-renders recharts' most expensive child here. */
const RebasedChart = memo(function RebasedChart({ lines, chartData }: {
  lines: { key: string; label: string; color: string }[];
  chartData: Record<string, number | string>[];
}) {
  if (chartData.length <= 1) {
    return <p className="text-[12px] text-text-faint">Not enough cached price history to chart this window yet — it fills in shortly.</p>;
  }
  return (
    <div style={{ width: '100%', height: 240 }}>
      <ResponsiveContainer>
        <LineChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#243040" strokeDasharray="2 4" strokeOpacity={0.5} vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#5F6E82' }} minTickGap={48}
            tickFormatter={(d) => fmtDate(d).replace(/ \d{4}$/, '')} stroke="#243040" />
          <YAxis tick={{ fontSize: 10, fill: '#5F6E82' }} width={40} stroke="#243040"
            tickFormatter={(v) => `${v}`} />
          <Tooltip contentStyle={{ background: '#1A2331', border: '1px solid #243040', borderRadius: 6, fontSize: 12 }}
            labelFormatter={(d) => fmtDate(d as string)} formatter={(v: number) => [`${Number(v).toFixed(1)}`, '']} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {lines.map((ln) => (
            <Line key={ln.key} type="monotone" dataKey={ln.key} name={ln.label} stroke={ln.color}
              strokeWidth={ln.key === 'subject' ? 2.4 : 1.5} dot={false} isAnimationActive={false} connectNulls />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <p className="text-[11px] text-text-faint mt-1">Rebased to 100 at the start of the window · price return (currency-neutral).</p>
    </div>
  );
});

/**
 * One comparables row. Memoised on its own inputs so pointing at a company re-renders the
 * two rows that changed rather than the whole market — a peer set can run to hundreds.
 */
const CompetitorRow = memo(function CompetitorRow({
  c, range, showPosition, showMarker, plotted, isActive, onHover, onOpen,
}: {
  c: MarketCompetitor;
  range: string;
  showPosition: boolean;
  /** The market plane is drawn, so rows carry a marker saying whether they are on it. */
  showMarker: boolean;
  plotted: boolean;
  isActive: boolean;
  onHover: (symbol: string | null) => void;
  onOpen: (c: MarketCompetitor) => void;
}) {
  return (
    <tr
      data-symbol={c.symbol}
      onMouseEnter={() => onHover(c.symbol)}
      className={clsx(
        'transition-colors duration-150 motion-reduce:transition-none',
        c.isSubject && 'bg-surface-2',
        isActive && 'bg-gold/[0.09] shadow-[inset_2px_0_0_0_#D9A94E]',
      )}
    >
      <td className="td">
        <div className="flex items-center gap-2">
          {showMarker && (
            <span
              aria-hidden
              title={plotted
                ? `Plotted in the market position chart · Value ${c.valuePct?.toFixed(0)} · Strength ${c.strengthPct?.toFixed(0)}`
                : 'Not placed in the market position chart — no value × strength score yet'}
              className={clsx(
                'shrink-0 w-[7px] h-[7px] rounded-full border transition-colors duration-150 motion-reduce:transition-none',
                !plotted && 'border-hairline-strong bg-transparent',
                plotted && isActive && 'border-gold-bright bg-gold-bright',
                plotted && !isActive && c.isSubject && 'border-[#4FD0E0] bg-[#4FD0E0]',
                plotted && !isActive && !c.isSubject && 'border-text-faint bg-text-faint',
              )}
            />
          )}
          <button
            type="button"
            onClick={() => onOpen(c)}
            onFocus={() => onHover(c.symbol)}
            onBlur={() => onHover(null)}
            title={`Open ${c.symbol}`}
            className="group inline-flex items-center gap-2 text-left cursor-pointer min-w-0"
          >
            <span className="font-mono text-text group-hover:text-azure underline-offset-2 group-hover:underline">{c.symbol}</span>
            {c.isSubject && <span className="text-[10px] uppercase text-azure">this</span>}
            {c.name && <span className="text-text-faint truncate group-hover:text-text-muted">{c.name}</span>}
          </button>
        </div>
      </td>
      {showPosition && (
        <>
          <td className="td text-right font-mono tnum text-text-muted">{c.rank ?? '—'}</td>
          <td className="td text-right font-mono tnum">{c.valuePct != null ? c.valuePct.toFixed(0) : '—'}</td>
          <td className="td text-right font-mono tnum">{c.strengthPct != null ? c.strengthPct.toFixed(0) : '—'}</td>
        </>
      )}
      <td className="td text-right font-mono tnum">
        {c.marketCapCHF != null
          ? fmtMoney(c.marketCapCHF, 'CHF', false)
          : c.marketCap != null
            ? fmtMoney(c.marketCap, c.currency ?? 'USD', false)
            : '—'}
      </td>
      <td className="td text-right font-mono tnum">{c.trailingPE != null ? c.trailingPE.toFixed(1) : '—'}</td>
      <td className="td text-right font-mono tnum">{fmtPct(c.profitMargins, 1)}</td>
      <td className={`td text-right font-mono tnum ${c.returns[range] == null ? 'text-text-faint' : c.returns[range]! < 0 ? 'text-loss' : 'text-gain'}`}>{fmtPctSigned(c.returns[range] ?? null)}</td>
      <td className={`td text-right font-mono tnum ${c.relativeToSubjectPct == null ? 'text-text-faint' : c.relativeToSubjectPct < 0 ? 'text-loss' : 'text-gain'}`}>{c.isSubject ? '—' : fmtPctSigned(c.relativeToSubjectPct)}</td>
    </tr>
  );
});

/**
 * The market plane in miniature, pinned to the corner while the comparables table is being
 * read and the full chart has scrolled away. Same points, same active symbol, same component
 * — a contextual mini-map rather than a second chart with its own idea of the data.
 */
function MiniMarketMap({ points, active, activePoint, onActiveChange, onOpen, open }: {
  points: MarketScatterPoint[];
  active: string | null;
  activePoint: MarketScatterPoint | null;
  onActiveChange: (symbol: string | null) => void;
  onOpen: (p: MarketScatterPoint) => void;
  open: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  // A dismissal lasts until the full chart comes back — scrolling up and down again should
  // not resurrect a panel the user just closed, but revisiting the chart is a fresh start.
  useEffect(() => { if (!open) setDismissed(false); }, [open]);
  const visible = open && !dismissed;

  // The panel stays mounted once it has been shown, so re-appearing is a fade rather than a
  // chart popping into existence. Before that it costs nothing: a reader who never scrolls
  // this far never renders a second recharts tree.
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => { if (open) setEverOpened(true); }, [open]);

  return (
    <div
      aria-hidden={!visible}
      className={clsx(
        // Sits above the content, below the back-to-top control that owns the corner.
        'fixed z-30 bottom-20 right-4 sm:right-6 w-[184px] sm:w-[236px]',
        'rounded-lg border border-hairline-strong bg-surface-2/95 backdrop-blur shadow-modal p-2 sm:p-2.5',
        'transition-all duration-200 ease-out motion-reduce:transition-none',
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3 pointer-events-none',
      )}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="eyebrow text-[9px] leading-none truncate">Value ↑ · Strength →</span>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          tabIndex={visible ? 0 : -1}
          aria-label="Hide the market position mini-map"
          title="Hide"
          className="shrink-0 -mr-0.5 text-text-faint hover:text-text transition-colors"
        >
          <X size={12} />
        </button>
      </div>

      <div className="h-[112px] sm:h-[146px]">
        {everOpened && (
          <MarketScatter
            points={points} active={active} onActiveChange={onActiveChange}
            onOpen={onOpen} variant="mini"
          />
        )}
      </div>

      <div className="mt-1 h-[26px] leading-tight">
        {activePoint ? (
          <>
            <div className="font-mono text-[11px] text-gold-bright truncate">
              {activePoint.symbol}{activePoint.isSubject ? ' · this' : ''}
            </div>
            <div className="text-[10px] text-text-faint tnum">
              V {activePoint.y.toFixed(0)} · S {activePoint.x.toFixed(0)}
              {activePoint.rank != null && <> · #{activePoint.rank}</>}
            </div>
          </>
        ) : (
          <div className="text-[10px] text-text-faint">
            {active ? 'Not placed on this chart' : 'Hover a company to place it'}
          </div>
        )}
      </div>
    </div>
  );
}

/** Show the mini-map exactly while it is useful: the full chart is off screen and the
 *  comparables table it belongs to is on screen. */
function useMiniMapVisibility({ chartRef, listRef, enabled }: {
  chartRef: RefObject<HTMLDivElement>;
  listRef: RefObject<HTMLDivElement>;
  enabled: boolean;
}) {
  const [chartInView, setChartInView] = useState(true);
  const [listInView, setListInView] = useState(false);

  useEffect(() => {
    const chart = chartRef.current;
    const list = listRef.current;
    if (!enabled || !chart || !list || typeof IntersectionObserver === 'undefined') {
      setChartInView(true);
      setListInView(false);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.target === chart) setChartInView(e.isIntersecting);
        else if (e.target === list) setListInView(e.isIntersecting);
      }
    }, { threshold: 0 });
    io.observe(chart);
    io.observe(list);
    return () => io.disconnect();
  }, [chartRef, listRef, enabled]);

  return enabled && !chartInView && listInView;
}

/** Bring a company's row into view, but only when it actually needs it. Debounced so
 *  sweeping the pointer across a dense corner of the mini-map doesn't chase the list. */
function useRevealRow(listRef: RefObject<HTMLElement>) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return useCallback((symbol: string | null) => {
    if (timer.current) clearTimeout(timer.current);
    if (!symbol) return;
    timer.current = setTimeout(() => {
      const row = listRef.current?.querySelector(`[data-symbol="${CSS.escape(symbol)}"]`);
      if (!row) return;
      const r = row.getBoundingClientRect();
      // A row already comfortably inside the viewport is left exactly where it is.
      if (r.top >= 72 && r.bottom <= window.innerHeight - 16) return;
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      row.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
    }, 140);
  }, [listRef]);
}
