import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowUpRight, Eye, Info, Clock, Globe2 } from 'lucide-react';
import { api, type ScreenerRow, type ScreenerVerdict } from '../lib/api';
import { useApp } from '../store';
import { Spinner, EmptyState } from '../components/ui';
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

export function Screener() {
  const qc = useQueryClient();
  const researchSymbolView = useApp((s) => s.researchSymbolView);
  const openModal = useApp((s) => s.openModal);
  const [sector, setSector] = useState('');
  const [verdict, setVerdict] = useState('');
  const [groupBySector, setGroupBySector] = useState(false);

  const { data, isLoading, isError } = useQuery({ queryKey: ['screener'], queryFn: api.screen });

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

  const filtered = useMemo(() => {
    let rows = data?.rows ?? [];
    if (sector) rows = rows.filter((r) => r.sector === sector);
    if (verdict) rows = rows.filter((r) => r.verdict === verdict);
    return rows;
  }, [data, sector, verdict]);

  const grouped = useMemo(() => {
    if (!groupBySector) return null;
    const m = new Map<string, ScreenerRow[]>();
    for (const r of filtered) {
      const k = r.sector ?? 'Other';
      (m.get(k) ?? m.set(k, []).get(k)!).push(r);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered, groupBySector]);

  const openRow = (sym: string) => researchSymbolView(sym);
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
          <div className="flex items-center gap-2 text-[12px] text-text-faint mb-4 flex-wrap">
            <Info size={13} />
            <span>
              Scored <span className="text-text">{data.analysedCount}</span> of {data.universeSize} names.
              {data.unanalysedCount > 0 && (
                <> {data.unanalysedCount} not analysed yet — open any in Research to fetch its fundamentals, then re-run.</>
              )}
            </span>
          </div>

          {data.analysedCount === 0 ? (
            <EmptyState
              title="No names have fundamentals cached yet"
              hint="The screen only scores names whose fundamentals are already fetched (the provider rate-limits bulk pulls). Open a few companies in Research or hold/watch them, then come back."
            />
          ) : (
            <>
              {/* World map — where the value is, by market. */}
              {(data.geo?.length ?? 0) > 0 && (
                <div className="card mb-6">
                  <div className="eyebrow mb-3 flex items-center gap-2"><Globe2 size={13} /> Opportunity map</div>
                  <DiscoverMap geo={data.geo} rows={data.rows} onOpen={openRow} onReplay={openReplay} />
                </div>
              )}

              <div className="flex items-center gap-3 mb-4 flex-wrap">
                <select className="input w-auto" value={sector} onChange={(e) => setSector(e.target.value)}>
                  <option value="">All sectors</option>
                  {data.sectors.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <select className="input w-auto" value={verdict} onChange={(e) => setVerdict(e.target.value)}>
                  {VERDICT_FILTERS.map((v) => (
                    <option key={v.value} value={v.value}>{v.label}</option>
                  ))}
                </select>
                <label className="flex items-center gap-2 text-[13px] text-text-muted ml-auto cursor-pointer">
                  <input type="checkbox" checked={groupBySector} onChange={(e) => setGroupBySector(e.target.checked)} />
                  Group by sector
                </label>
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
                  <p className="text-sm text-text-faint mt-3">No names match these filters.</p>
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
        <td colSpan={12} className="pt-4 pb-1 px-3 eyebrow text-gold">{sector} · {rows.length}</td>
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
        {r.name && <div className="text-[12px] text-text-muted truncate max-w-[220px]">{r.name}</div>}
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
