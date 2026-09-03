import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Trash2, ArrowUpRight, TrendingUp, TrendingDown } from 'lucide-react';
import { BellPlus, Check } from 'lucide-react';
import { api, type CompareEntity, type WatchlistItem, type AssetMetrics, type WatchlistAnalysisItem } from '../lib/api';
import { useApp } from '../store';
import { ExportAction } from '../components/ExportAction';
import { SymbolSearch, type SymbolPick } from '../components/SymbolSearch';
import { BenchmarkSelect } from '../components/BenchmarkSelect';
import { BandBadge } from '../components/ValuationBand';
import { VerdictBadge } from '../components/Verdict';
import { Spinner, EmptyState, Segmented, KindBadge } from '../components/ui';
import { fmtPct, fmtPctSigned, fmtNum, fmtMoney, plClass } from '../lib/format';

const WINDOWS = [
  { value: '3', label: '3Y' },
  { value: '5', label: '5Y' },
  { value: '10', label: '10Y' },
];

/**
 * Watchlist — monitor assets you don't hold (e.g. Shell) and rank them against a
 * benchmark ETF and your own portfolio over a chosen window, so outperformers and
 * laggards stand out. The comparison reuses the same universal-compare engine as
 * Research; this view only owns the persisted list.
 */
export function Watchlist() {
  const qc = useQueryClient();
  const benchmark = useApp((s) => s.benchmark);
  const researchSymbolView = useApp((s) => s.researchSymbolView);
  const [win, setWin] = useState('5');
  const windowYears = Number(win);

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['watchlist'],
    queryFn: api.listWatchlist,
  });

  const add = useMutation({
    mutationFn: (p: SymbolPick) => api.addToWatchlist({ symbol: p.symbol, name: p.name, kind: p.kind }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['watchlist'] }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.removeFromWatchlist(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['watchlist'] }),
  });

  // Watched symbols + the benchmark ETF + your portfolio, ranked together over the window.
  const entities: CompareEntity[] = useMemo(() => {
    const watched: CompareEntity[] = items.map((i) => ({
      type: 'symbol',
      symbol: i.symbol,
      name: i.name ?? i.symbol,
      kind: i.kind,
    }));
    return [...watched, { type: 'symbol', symbol: benchmark, name: benchmark, kind: 'etf' }, { type: 'portfolio' }];
  }, [items, benchmark]);

  const compareKey = items.map((i) => i.symbol).join(',');
  const { data: cmp, isFetching } = useQuery({
    queryKey: ['watchlist-compare', compareKey, benchmark, windowYears],
    queryFn: () => api.universalCompare(entities, windowYears),
    enabled: items.length > 0,
  });

  const benchCagr = cmp?.entities.find((e) => e.type === 'symbol' && e.symbol === benchmark)?.cagr ?? null;
  const bySymbol = new Map(items.map((i) => [i.symbol, i]));

  // Fair-value entry targets for each watched name (closest-to-target first).
  const { data: analysis } = useQuery({
    queryKey: ['watchlist-analysis', compareKey],
    queryFn: api.watchlistAnalysis,
    enabled: items.length > 0,
  });
  const setAlert = useMutation({
    mutationFn: (symbol: string) => api.createAlert({ symbol, kind: 'buy' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['unread-count'] }),
  });

  return (
    <div id="view-watchlist" className="p-6 max-w-[1200px] mx-auto">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
        <div className="eyebrow mb-1">Monitoring</div>
        <h1 className="font-display text-2xl font-semibold">Watchlist</h1>
        <p className="text-sm text-text-muted mt-1 max-w-2xl">
          Track companies you don't own yet and see how they stack up against {benchmark} and your own
          portfolio over time — so genuine outperformers stand apart from the laggards.
        </p>
        </div>
        <ExportAction target={() => document.getElementById('view-watchlist')} title="Watchlist" filename="watchlist" className="btn-secondary shrink-0" label="PDF / Word" />
      </header>

      <div className="card mb-6">
        <div className="eyebrow mb-2">Add a company or ETF</div>
        <SymbolSearch onPick={(p) => add.mutate(p)} />
        <div className="mt-3 flex flex-wrap gap-2">
          {['SHEL.L', 'AAPL', 'NVDA', 'NESN.SW', 'MSFT'].map((s) => (
            <button
              key={s}
              className="chip hover:border-azure/50 hover:text-azure"
              onClick={() => add.mutate({ symbol: s, name: s, kind: 'stock' })}
            >
              + {s}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <Spinner label="Loading watchlist…" />
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing on your watchlist yet"
          hint="Search for a company or ETF above — Shell, Apple, anything — to start monitoring it against your benchmark."
        />
      ) : (
        <>
        {/* Fair-value entry targets — the price at which each name becomes attractive. */}
        {(analysis?.length ?? 0) > 0 && (
          <div className="card mb-6">
            <div className="eyebrow mb-3">Fair value &amp; attractive entry price</div>
            <div className="overflow-x-auto -mx-5">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="th">Company</th>
                    <th className="th text-right">Price</th>
                    <th className="th text-right">Fair value</th>
                    <th className="th text-right">Entry target</th>
                    <th className="th text-right">Gap to entry</th>
                    <th className="th">Valuation</th>
                    <th className="th">Verdict</th>
                    <th className="th w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {analysis!.map((w) => (
                    <EntryRow key={w.id} w={w} onOpen={() => researchSymbolView(w.symbol)}
                      onAlert={() => setAlert.mutate(w.symbol)} alerted={setAlert.isSuccess && setAlert.variables === w.symbol} />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-text-faint mt-3">
              Entry target = fair value less your margin of safety. A negative gap means the price is already
              at/below the target — the buy zone. Names without cached fundamentals show once valued (open in Research).
            </p>
          </div>
        )}

        <div className="card">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <div className="eyebrow">Ranked vs {benchmark} &amp; your portfolio · {windowYears}y</div>
            <div className="flex items-center gap-3">
              <Segmented options={WINDOWS} value={win} onChange={setWin} />
              <BenchmarkSelect />
            </div>
          </div>

          {isFetching && !cmp ? (
            <Spinner label="Comparing over time…" />
          ) : (
            <div className="overflow-x-auto -mx-5">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="th w-8">#</th>
                    <th className="th">Asset</th>
                    <th className="th text-right">Return (CAGR)</th>
                    <th className="th text-right">Total return</th>
                    <th className="th text-right">Vol</th>
                    <th className="th text-right">Max DD</th>
                    <th className="th text-right">vs {benchmark}</th>
                    <th className="th w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {cmp?.entities.map((m) => (
                    <Row
                      key={`${m.type}:${m.symbol}`}
                      m={m}
                      benchmark={benchmark}
                      benchCagr={benchCagr}
                      item={bySymbol.get(m.symbol)}
                      onOpen={(sym) => researchSymbolView(sym)}
                      onRemove={(id) => remove.mutate(id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[11px] text-text-faint mt-3">
            Returns are price-based over the selected window from cached history. Your portfolio row is
            money-weighted (XIRR). Model estimates — not advice.
          </p>
        </div>
        </>
      )}
    </div>
  );
}

function EntryRow({ w, onOpen, onAlert, alerted }: {
  w: WatchlistAnalysisItem; onOpen: () => void; onAlert: () => void; alerted: boolean;
}) {
  const ccy = w.currency || '';
  const inBuyZone = w.gapToEntry != null && w.gapToEntry <= 0;
  return (
    <tr className="hover:bg-surface-2">
      <td className="td">
        <button className="text-left" onClick={onOpen}>
          <span className="font-mono text-azure hover:underline">{w.symbol}</span>
          {w.name && <span className="text-text-muted ml-2 text-[13px]">{w.name}</span>}
        </button>
      </td>
      <td className="td text-right font-mono tnum">{w.price != null ? fmtMoney(w.price, ccy) : '—'}</td>
      <td className="td text-right font-mono tnum text-text-muted">{w.fairValue != null ? fmtMoney(w.fairValue, ccy) : '—'}</td>
      <td className="td text-right font-mono tnum text-gain">{w.entryTarget != null ? fmtMoney(w.entryTarget, ccy) : '—'}</td>
      <td className={clsx('td text-right font-mono tnum', inBuyZone ? 'text-gain' : 'text-text-muted')}>
        {w.gapToEntry != null ? (inBuyZone ? `in buy zone` : `+${fmtPct(w.gapToEntry, 1)}`) : '—'}
      </td>
      <td className="td">{w.band ? <BandBadge band={w.band.band} /> : <span className="text-text-faint text-[12px]">not valued yet</span>}</td>
      <td className="td">{w.verdict ? <VerdictBadge verdict={w.verdict} action={w.recommendation?.action} confidence={w.confidence} /> : <span className="text-text-faint text-[12px]">—</span>}</td>
      <td className="td text-right">
        {w.entryTarget != null && (
          <button className="text-text-faint hover:text-azure transition-colors" title="Alert me at the entry price" onClick={onAlert}>
            {alerted ? <Check size={14} className="text-gain" /> : <BellPlus size={14} />}
          </button>
        )}
      </td>
    </tr>
  );
}

function Row({
  m,
  benchmark,
  benchCagr,
  item,
  onOpen,
  onRemove,
}: {
  m: AssetMetrics;
  benchmark: string;
  benchCagr: number | null;
  item?: WatchlistItem;
  onOpen: (symbol: string) => void;
  onRemove: (id: number) => void;
}) {
  const isBenchmark = m.type === 'symbol' && m.symbol === benchmark;
  const isPortfolio = m.type === 'portfolio';
  const clickable = m.type === 'symbol' && !isBenchmark;

  // Outperformance vs the benchmark ETF, in CAGR percentage points.
  const edge = m.cagr != null && benchCagr != null && !isBenchmark ? m.cagr - benchCagr : null;

  return (
    <tr className={clsx('hover:bg-surface-2', (isBenchmark || isPortfolio) && 'text-text-muted')}>
      <td className="td font-mono text-text-faint">{m.rank}</td>
      <td className="td">
        {clickable ? (
          <button className="group inline-flex items-center gap-2 text-left" onClick={() => onOpen(m.symbol)}>
            <span className="font-mono text-azure group-hover:underline">{m.symbol}</span>
            <ArrowUpRight size={12} className="text-text-faint opacity-0 group-hover:opacity-100" />
          </button>
        ) : (
          <span className={clsx('font-mono', isBenchmark ? 'text-gold' : 'text-text')}>
            {isPortfolio ? 'Your portfolio' : m.symbol}
          </span>
        )}
        {m.kind && !isPortfolio && <span className="ml-2 inline-block align-middle"><KindBadge kind={m.kind} /></span>}
        {isBenchmark && <span className="ml-2 text-[10px] uppercase text-gold/70">benchmark</span>}
        {m.name && !isBenchmark && !isPortfolio && (
          <span className="text-text-muted ml-2 text-[13px]">{m.name}</span>
        )}
      </td>
      <td className={clsx('td text-right font-mono tnum', plClass(m.cagr))}>{fmtPctSigned(m.cagr)}</td>
      <td className={clsx('td text-right font-mono tnum', plClass(m.totalReturnPct))}>{fmtPctSigned(m.totalReturnPct)}</td>
      <td className="td text-right font-mono tnum text-text-muted">{fmtPct(m.annualizedVol)}</td>
      <td className="td text-right font-mono tnum text-loss">{fmtPct(m.maxDrawdownPct)}</td>
      <td className="td text-right">
        {edge == null ? (
          <span className="text-text-faint">—</span>
        ) : (
          <span className={clsx('inline-flex items-center gap-1 font-mono tnum text-[13px]', plClass(edge))}>
            {edge >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {fmtPctSigned(edge)}
          </span>
        )}
      </td>
      <td className="td text-right">
        {item && (
          <button
            className="text-text-faint hover:text-loss transition-colors"
            title="Remove from watchlist"
            onClick={() => onRemove(item.id)}
          >
            <Trash2 size={14} />
          </button>
        )}
      </td>
    </tr>
  );
}
