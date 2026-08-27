import { useState } from 'react';
import { useQuery, useQueries, useQueryClient, useMutation } from '@tanstack/react-query';
import {
  ArrowLeft,
  Download,
  Pencil,
  Plus,
  Trash2,
  Clock,
  TrendingDown,
  Activity,
  AlertTriangle,
  X,
  Scale,
  GitCompareArrows,
  LineChart,
  Building2,
  Gem,
  Percent,
  Rocket,
  Shuffle,
  ArrowLeftRight,
  Newspaper,
  StickyNote,
} from 'lucide-react';
import clsx from 'clsx';
import { api, downloadExport } from '../lib/api';
import { useApp } from '../store';
import {
  fmtCHF,
  fmtCHFSigned,
  fmtPct,
  fmtPctSigned,
  fmtMonths,
  fmtDate,
  fmtMoney,
  plClass,
} from '../lib/format';
import { DeltaChart } from '../components/DeltaChart';
import { ProjectionChart } from '../components/ProjectionChart';
import { PriceMovementChart } from '../components/PriceMovementChart';
import { SymbolSearch } from '../components/SymbolSearch';
import { Fundamentals } from '../components/Fundamentals';
import { ValueAnalysis } from '../components/ValueAnalysis';
import { SellSignalPanel } from '../components/SellSignalPanel';
import { catchUp } from '../lib/rebase';
import { PeriodReturns } from '../components/PeriodReturns';
import { NewsFeed } from '../components/NewsFeed';
import { Globe } from '../components/Globe';
import { Segmented, Spinner, Stat, KindBadge, StaleDot, DataStatusBadge } from '../components/ui';
import { BenchmarkSelect } from '../components/BenchmarkSelect';
import { NotesPanel } from '../components/NotesPanel';
import { MarketStatusChip } from '../components/MarketStatusChip';
import { SectionNav, type NavSection } from '../components/SectionNav';
import { buildPositionExport } from '../lib/exporters';

// Distinct, dark-legible colours for comparison overlays. Azure is the subject stock and
// green/red mark surge/drop, so those hues are deliberately excluded here.
const OVERLAY_COLORS = ['#D9A94E', '#A98BFF', '#4FD0E0', '#F0883E', '#EC6DB0', '#B6D94E', '#8FA0B8'];

export function PositionDetail() {
  const { selectedInstrumentId: id, benchmark, preTax, setPreTax, setView, openModal } = useApp();
  const qc = useQueryClient();

  const position = useQuery({
    queryKey: ['position', id, preTax],
    queryFn: () => api.position(id!, preTax),
    enabled: id != null,
  });
  const cf = useQuery({
    queryKey: ['cf', id, benchmark, preTax],
    queryFn: () => api.counterfactual(id!, benchmark, preTax),
    enabled: id != null,
  });
  const breakeven = useQuery({
    queryKey: ['breakeven', id, benchmark],
    queryFn: () => api.breakeven(id!, benchmark),
    enabled: id != null,
  });
  const txs = useQuery({
    queryKey: ['txs', id],
    queryFn: () => api.getTransactions(id!),
    enabled: id != null,
  });

  const symbol = position.data?.instrument.symbol;
  const delisted = position.data?.delisted || position.data?.instrument.unresolved;
  const history = useQuery({
    queryKey: ['pos-history', symbol],
    queryFn: () => api.marketHistory(symbol!),
    enabled: !!symbol && !delisted,
  });
  const movements = useQuery({
    queryKey: ['pos-movements', symbol],
    queryFn: () => api.movements(symbol!),
    enabled: !!symbol && !delisted,
  });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const [overlaySymbols, setOverlaySymbols] = useState<string[]>(benchmark ? [benchmark] : []);
  const [showAddOverlay, setShowAddOverlay] = useState(false);
  const overlayHistories = useQueries({
    queries: overlaySymbols.map((sym) => ({
      queryKey: ['pos-history-cmp', sym],
      queryFn: () => api.marketHistory(sym),
      enabled: !!sym && !delisted,
      staleTime: 5 * 60_000,
    })),
  });
  const toggleOverlay = (sym: string) =>
    setOverlaySymbols((prev) => (prev.includes(sym) ? prev.filter((s) => s !== sym) : [...prev, sym]));
  const news = useQuery({
    queryKey: ['news', symbol, 20],
    queryFn: () => api.news(symbol!, 20),
    enabled: !!symbol && !delisted,
  });
  const hours = useQuery({
    queryKey: ['pos-hours', symbol],
    queryFn: () => api.marketHoursSymbol(symbol!),
    enabled: !!symbol && !delisted,
  });

  const removeTx = useMutation({
    mutationFn: (txId: number) => api.deleteTransaction(txId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['position', id] });
      qc.invalidateQueries({ queryKey: ['cf', id] });
      qc.invalidateQueries({ queryKey: ['txs', id] });
    },
  });

  if (id == null) return null;
  if (position.isLoading || cf.isLoading) return <Spinner label="Analysing position…" />;
  if (position.error) return <div className="p-6 text-loss text-sm">{(position.error as Error).message}</div>;

  const p = position.data!;
  const c = cf.data!;
  const inst = p.instrument;
  const delta = c.deltaCHF;
  const aheadOfEtf = delta >= 0;

  // Rebased comparison lines for the Full-price-history chart (ETFs + stocks).
  const priceOverlays = overlaySymbols
    .map((sym, i) => ({
      symbol: sym,
      series: (overlayHistories[i]?.data ?? []) as Array<{ date: string; close: number }>,
      color: OVERLAY_COLORS[i % OVERLAY_COLORS.length],
    }))
    .filter((o) => o.series.length > 1);
  const overlayColorOf = (sym: string) => {
    const i = overlaySymbols.indexOf(sym);
    return i >= 0 ? OVERLAY_COLORS[i % OVERLAY_COLORS.length] : '#5F6E82';
  };
  const benchmarkChoices: string[] = (settings.data?.benchmarks ?? []).map((b) => b.symbol);

  // Catch-up: how far the stock must climb TODAY to draw level with each comparison,
  // measured over the period you actually held it (anchored at the entry date), and when
  // it fell behind for good. The first overlay drives the chart's "losing zone".
  const entryDate =
    p.firstBuyDate ??
    (txs.data ?? [])
      .filter((t) => t.action === 'buy')
      .reduce<string | undefined>((m, t) => (!m || t.date < m ? t.date : m), undefined) ??
    null;
  const catchups = priceOverlays
    .map((o) => ({ ...o, cu: catchUp(history.data ?? [], o.series, entryDate) }))
    .filter((x): x is typeof x & { cu: NonNullable<typeof x.cu> } => x.cu != null);
  const lossZone = catchups[0]?.cu.behindSince
    ? { fromDate: catchups[0].cu.behindSince, label: `behind ${catchups[0].symbol}` }
    : undefined;

  const doExport = async (kind: 'excel' | 'pdf') => {
    const notesList = await api.listNotes('instrument', id);
    const payload = await buildPositionExport(p, c, kind, notesList.map((n) => n.body));
    await downloadExport(kind, payload, `${inst.symbol}-vs-${c.benchmarkSymbol}`);
  };

  const isStock = inst.kind === 'stock';
  const hasHistory = !delisted && (history.data?.length ?? 0) > 1;
  const navSections: NavSection[] = [
    { id: 'sec-opportunity', label: 'Opportunity cost', icon: Scale },
    { id: 'sec-alternatives', label: 'Alternatives', icon: GitCompareArrows },
    ...(hasHistory ? [{ id: 'sec-history', label: 'Price history', icon: LineChart }] : []),
    ...(!delisted && isStock ? [{ id: 'sec-fundamentals', label: 'Fundamentals', icon: Building2 }] : []),
    ...(!delisted && isStock ? [{ id: 'sec-value', label: 'Value', icon: Gem }] : []),
    ...(!delisted ? [{ id: 'sec-returns', label: 'Returns', icon: Percent }] : []),
    { id: 'sec-projection', label: 'Projection', icon: Rocket },
    { id: 'sec-whatif', label: 'What-if sale', icon: Shuffle },
    { id: 'sec-transactions', label: 'Transactions', icon: ArrowLeftRight },
    ...(!delisted ? [{ id: 'sec-news', label: 'News', icon: Newspaper }] : []),
    { id: 'sec-notes', label: 'Notes', icon: StickyNote },
  ];

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <button className="btn-ghost !px-2 mb-3 -ml-2" onClick={() => setView('dashboard')}>
        <ArrowLeft size={15} /> Portfolio
      </button>

      <header className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <KindBadge kind={inst.kind} />
          <div>
            <h1 className="font-display text-2xl font-semibold flex items-center gap-2">
              {inst.symbol}
              {p.dataStatus && p.dataStatus.state !== 'ok' ? (
                <DataStatusBadge
                  status={p.dataStatus}
                  onRetry={async () => {
                    await api.reresolveInstrument(inst.id).catch(() => undefined);
                    qc.invalidateQueries();
                  }}
                />
              ) : (
                <StaleDot stale={p.stale} />
              )}
            </h1>
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm text-text-muted">{inst.name}</p>
              {hours.data && <MarketStatusChip hours={hours.data} />}
            </div>
            {p.openQuantity > 0 && p.currentValueCHF != null ? (
              <div className="mt-2 flex items-baseline gap-2 flex-wrap">
                <span className="font-mono text-3xl font-semibold tnum leading-none">
                  {fmtCHF(p.currentValueCHF / p.openQuantity, true)}
                </span>
                <span className="text-xs text-text-faint">
                  per share
                  {inst.currency !== 'CHF' && p.currentPrice != null
                    ? ` · ${fmtMoney(p.currentPrice, inst.currency, true)}`
                    : ''}
                  {p.priceAsOf ? ` · as of ${fmtDate(p.priceAsOf)}` : ''}
                  {p.stale ? ' · stale' : ''}
                </span>
              </div>
            ) : p.currentPrice != null ? (
              <div className="mt-2 flex items-baseline gap-2">
                <span className="font-mono text-3xl font-semibold tnum leading-none">
                  {fmtMoney(p.currentPrice, inst.currency, true)}
                </span>
                <span className="text-xs text-text-faint">per share{p.stale ? ' · stale' : ''}</span>
              </div>
            ) : (
              <div className="mt-2 text-sm text-text-muted">
                Closed position{p.closedDate ? ` · sold ${fmtDate(p.closedDate)}` : ''} · realized{' '}
                <span className={`font-mono ${plClass(p.realizedCHF)}`}>{fmtCHFSigned(p.realizedCHF)}</span>
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <BenchmarkSelect />
          <Segmented
            value={preTax ? 'pre' : 'after'}
            onChange={(v) => setPreTax(v === 'pre')}
            options={[
              { value: 'after', label: 'After-tax' },
              { value: 'pre', label: 'Pre-tax' },
            ]}
          />
          <button className="btn-secondary" onClick={() => openModal({ kind: 'recovery', instrumentId: id })}>
            <Activity size={15} /> Recovery
          </button>
          <button className="btn-secondary" onClick={() => openModal({ kind: 'add-transaction', instrumentId: id })}>
            <Plus size={15} /> Transaction
          </button>
          <button className="btn-secondary" onClick={() => openModal({ kind: 'edit-instrument', instrumentId: id })}>
            <Pencil size={15} /> Edit
          </button>
          <button className="btn-secondary" onClick={() => doExport('pdf')}>
            <Download size={15} /> PDF
          </button>
          <button className="btn-secondary" onClick={() => doExport('excel')}>
            <Download size={15} /> XLS
          </button>
        </div>
      </header>

      <SectionNav sections={navSections} />

      {p.dataStatus?.state === 'data-issue' && (
        <section className="card mb-6 border-l-2 border-l-loss bg-loss/5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-loss shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-sm font-semibold text-loss">Data issue — values may be wrong</div>
              <p className="text-sm text-text-muted mt-1">{p.dataStatus.message}</p>
            </div>
            <button
              className="btn-secondary shrink-0"
              onClick={() => openModal({ kind: 'edit-instrument', instrumentId: id })}
            >
              <Pencil size={15} /> Fix symbol
            </button>
          </div>
        </section>
      )}

      {/* Valuation-driven sell/trim signal — surfaced above the fold when overvalued. */}
      {p.sellSignal && (
        <div className="mb-6">
          <SellSignalPanel signal={p.sellSignal} />
        </div>
      )}

      {/* Decision panel — opportunity cost crown */}
      <section id="sec-opportunity" className={`card mb-6 scroll-mt-24 border-l-2 ${aheadOfEtf ? 'border-l-gain' : 'border-l-loss'}`}>
        <div className="grid lg:grid-cols-[minmax(300px,1fr)_2fr] gap-6">
          <div className="flex flex-col justify-center">
            <div className="eyebrow mb-2">
              Opportunity cost vs {c.benchmarkSymbol} · {preTax ? 'pre-tax' : 'after-tax'} · CHF
            </div>
            <div className={`font-mono font-semibold text-display-xl tnum leading-none ${plClass(delta)}`}>
              {fmtCHFSigned(delta)}
            </div>
            <p className={`mt-3 text-sm ${aheadOfEtf ? 'text-gain' : 'text-loss'}`}>
              {aheadOfEtf
                ? `${inst.symbol} is ahead of ${c.benchmarkName} by ${fmtCHF(Math.abs(delta))} after tax.`
                : `You'd be ${fmtCHF(Math.abs(delta))} better off had this money gone into ${c.benchmarkSymbol}.`}
            </p>
            {!aheadOfEtf && breakeven.data?.monthsToRecover != null && (
              <p className="mt-2 flex items-center gap-1.5 text-sm text-text-muted">
                <Clock size={14} className="text-gold" />
                Sell now → {c.benchmarkSymbol} recovers your shortfall in{' '}
                <span className="text-text font-medium">{fmtMonths(breakeven.data.monthsToRecover)}</span>
                <span className="text-text-faint">
                  (@ {fmtPct(breakeven.data.etfCagr)} p.a.)
                </span>
              </p>
            )}

            <div className="grid grid-cols-2 gap-x-4 gap-y-3 mt-6">
              <Stat
                label="Current price"
                value={p.openQuantity > 0 && p.currentValueCHF != null ? fmtCHF(p.currentValueCHF / p.openQuantity, true) : fmtCHF(p.currentPrice, true)}
                sub={p.openQuantity > 0 ? `× ${p.openQuantity} shares` : undefined}
              />
              <Stat label="Current value" value={fmtCHF(p.currentValueCHF)} sub="price × shares" />
              <Stat
                label="Invested"
                value={fmtCHF(p.investedCHF)}
                sub={p.openQuantity > 0 ? `@ ${fmtCHF(p.investedCHF / p.openQuantity, true)} avg` : undefined}
              />
              <Stat
                label="Unrealized P/L"
                value={fmtCHFSigned(p.unrealizedCHF)}
                valueClass={plClass(p.unrealizedCHF)}
              />
              <Stat
                label="Realized P/L"
                value={fmtCHFSigned(p.realizedCHF)}
                valueClass={plClass(p.realizedCHF)}
              />
              <Stat label="Net dividends" value={fmtCHF(p.dividends.netAfterTaxCHF)} sub={`${p.dividends.count} paid`} />
              <Stat label="Div. income tax" value={fmtCHF(p.dividends.incomeTaxCHF)} valueClass="text-loss" />
              <Stat label="XIRR" value={fmtPctSigned(p.metrics.xirr)} valueClass={plClass(p.metrics.xirr)} />
              <Stat label={`${c.benchmarkSymbol} XIRR`} value={fmtPctSigned(c.benchmarkXirr)} valueClass="text-gold" />
            </div>
          </div>
          <div id="position-chart">
            <div className="flex items-center gap-4 mb-2 text-[11px] text-text-muted">
              <span className="flex items-center gap-1.5">
                <span className="w-4 h-0.5 bg-azure inline-block" /> {inst.symbol} (actual)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-4 h-0 border-t-2 border-dashed border-gold inline-block" /> {c.benchmarkSymbol} (counterfactual)
              </span>
            </div>
            <p className="text-[11px] text-text-faint mb-2">
              Holding value in CHF (shares × price) — not the share price. For the per-share
              chart see “Full price history” below.
            </p>
            <DeltaChart
              series={c.series}
              benchmarkName={c.benchmarkSymbol}
              height={320}
              entries={(txs.data ?? [])
                .filter((t) => t.action === 'buy')
                .map((t) => ({
                  date: t.date,
                  label: fmtMoney(t.quantity * t.unitPrice, t.currency || inst.currency),
                }))}
            />
          </div>
        </div>
      </section>

      {/* Opportunity cost against any alternative — configured ETFs and any stock you add. */}
      <section id="sec-alternatives" className="card mb-6 scroll-mt-24">
        <div className="eyebrow mb-3">
          Opportunity cost vs alternatives · {preTax ? 'pre-tax' : 'after-tax'} · CHF
        </div>
        <OpportunityCostVsAlternatives
          id={id!}
          subject={inst.symbol}
          preTax={preTax}
          initialSymbols={Array.from(new Set([c.benchmarkSymbol, ...benchmarkChoices]))}
          current={c.benchmarkSymbol}
        />
      </section>

      {/* Full-history price with rebased comparison overlays + stagnation markers */}
      {!delisted && (history.data?.length ?? 0) > 1 && (
        <section id="sec-history" className="card mb-6 scroll-mt-24">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <div className="eyebrow">Full price history · {inst.symbol}</div>
            <div className="flex items-center gap-3 text-[11px] text-text-faint flex-wrap">
              <span className="flex items-center gap-1"><span className="w-4 h-0.5 bg-azure inline-block" /> {inst.symbol}</span>
              {priceOverlays.map((o) => (
                <span key={o.symbol} className="flex items-center gap-1">
                  <span className="w-4 h-0 border-t-2 border-dashed inline-block" style={{ borderColor: o.color }} /> {o.symbol}
                </span>
              ))}
              <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-gain" /> surge</span>
              <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-loss" /> drop</span>
              <span className="flex items-center gap-1"><span className="w-3 h-2 bg-warn/20 border border-warn/30" /> stagnation</span>
              {(news.data?.items?.length ?? 0) > 0 && (
                <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-azure-bright" /> news</span>
              )}
            </div>
          </div>

          {/* Compare-with toolbar: toggle benchmark ETFs, add any stock/ETF, remove chips. */}
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <span className="eyebrow">Compare</span>
            {benchmarkChoices.map((sym) => {
              const on = overlaySymbols.includes(sym);
              return (
                <button
                  key={sym}
                  onClick={() => toggleOverlay(sym)}
                  className={`chip cursor-pointer ${on ? '!text-text' : 'opacity-60'}`}
                  style={on ? { borderColor: overlayColorOf(sym), color: overlayColorOf(sym) } : undefined}
                >
                  {sym}
                </button>
              );
            })}
            {overlaySymbols
              .filter((s) => s && !benchmarkChoices.includes(s))
              .map((sym) => (
                <button
                  key={sym}
                  onClick={() => toggleOverlay(sym)}
                  className="chip cursor-pointer !text-text inline-flex items-center gap-1"
                  style={{ borderColor: overlayColorOf(sym), color: overlayColorOf(sym) }}
                  title="Remove"
                >
                  {sym} <X size={11} />
                </button>
              ))}
            <button onClick={() => setShowAddOverlay((v) => !v)} className="chip cursor-pointer">
              <Plus size={12} /> Add stock / ETF
            </button>
          </div>
          {showAddOverlay && (
            <div className="mb-3 max-w-md">
              <SymbolSearch
                onPick={(pick) => {
                  setOverlaySymbols((prev) => (prev.includes(pick.symbol) ? prev : [...prev, pick.symbol]));
                  setShowAddOverlay(false);
                }}
              />
            </div>
          )}

          <PriceMovementChart
            series={history.data ?? []}
            movements={movements.data}
            currency={inst.currency}
            height={300}
            overlays={priceOverlays}
            lossZone={lossZone}
            anchorDate={entryDate}
            news={(news.data?.items ?? [])
              .map((n) => ({ date: (n.publishedAt ?? '').slice(0, 10), title: n.title, link: n.link }))
              .filter((n) => n.date)}
          />
          <p className="text-[11px] text-text-faint mt-2">
            Comparison lines are rebased to {inst.symbol}’s price at{' '}
            {entryDate ? `your entry (${fmtDate(entryDate)})` : 'each series’ start'} — so both start level and you
            see who pulled ahead. The red band marks where {inst.symbol} has trailed{' '}
            {catchups[0]?.symbol ?? 'the benchmark'} for good — i.e. when selling into it would have cut your
            losses. News dots pin recent headlines (the provider serves recent news only).
          </p>

          {/* Catch-up: what the stock would need to reach today to draw level. */}
          {catchups.length > 0 && (
            <div className="mt-4 border border-hairline rounded overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="th">To match</th>
                    <th className="th text-right">Behind since</th>
                    <th className="th text-right">{inst.symbol} would need</th>
                    <th className="th text-right">Catch-up from today</th>
                  </tr>
                </thead>
                <tbody>
                  {catchups.map(({ symbol, color, cu }) => (
                    <tr key={symbol}>
                      <td className="td">
                        <span className="font-mono" style={{ color }}>{symbol}</span>
                      </td>
                      <td className="td text-right font-mono tnum text-text-muted">
                        {cu.behindSince ? fmtDate(cu.behindSince) : 'not behind'}
                      </td>
                      <td className="td text-right font-mono tnum">{fmtMoney(cu.targetToday, inst.currency)}</td>
                      <td
                        className={`td text-right font-mono tnum ${cu.catchUpPct > 0 ? 'text-loss' : 'text-gain'}`}
                      >
                        {cu.catchUpPct > 0 ? '+' : ''}
                        {fmtPct(cu.catchUpPct, 1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-3 py-2 text-[11px] text-text-faint border-t border-hairline">
                Measured since your entry{entryDate ? ` (${fmtDate(entryDate)})` : ''}. “{inst.symbol} would need” =
                the price it must reach <span className="text-text-muted">today</span> just to equal that
                instrument’s return over the same period; “catch-up from today” is how far above the current price
                that is — before {inst.symbol} would even start to outperform again.
              </div>
            </div>
          )}
        </section>
      )}

      {/* Company fundamentals — valuation, profitability, multi-year figures, index weight */}
      {!delisted && inst.kind === 'stock' && (
        <section id="sec-fundamentals" className="card mb-6 scroll-mt-24">
          <div className="eyebrow mb-3">Company fundamentals · {inst.symbol}</div>
          <Fundamentals symbol={inst.symbol} domicile={inst.domicile} name={inst.name} currency={inst.currency} />
        </section>
      )}

      {/* Value-investing analysis — intrinsic value, quality, ETF-realism verdict */}
      {!delisted && inst.kind === 'stock' && (
        <section id="sec-value" className="card mb-6 scroll-mt-24">
          <div className="eyebrow mb-3">Value analysis · what {inst.symbol} is really worth</div>
          <ValueAnalysis
            symbol={inst.symbol}
            price={p.currentPrice}
            currency={inst.currency}
            catchUpPct={catchups[0]?.cu.catchUpPct ?? null}
            benchmarkSymbol={catchups[0]?.symbol ?? null}
          />
        </section>
      )}

      {!delisted && (
        <section id="sec-returns" className="card mb-6 scroll-mt-24">
          <PeriodReturns
            symbol={inst.symbol}
            entry={txs.data?.reduce<string | undefined>((m, t) => (!m || t.date < m ? t.date : m), undefined)}
          />
        </section>
      )}

      <div id="sec-projection" className="grid lg:grid-cols-2 gap-6 scroll-mt-24">
        <ProjectionSection id={id} benchmark={benchmark} />
        <DividendShockSection id={id} />
      </div>

      <div id="sec-whatif" className="mt-6 scroll-mt-24">
        <WhatIfSaleSection id={id} benchmark={benchmark} preTax={preTax} currency={inst.currency} />
      </div>

      <div id="sec-transactions" className="grid lg:grid-cols-[1fr_360px] gap-6 mt-6 scroll-mt-24">
        <TransactionsCard txs={txs.data ?? []} onDelete={(txId) => removeTx.mutate(txId)} currency={inst.currency} />
        <AllocationCard instrumentId={id} />
      </div>

      {!delisted && (
        <section id="sec-news" className="card mt-6 scroll-mt-24">
          <h3 className="font-display text-base font-semibold mb-3">Latest headlines</h3>
          <NewsFeed symbol={inst.symbol} limit={6} />
        </section>
      )}

      <section id="sec-notes" className="card mt-6 scroll-mt-24">
        <h3 className="font-display text-base font-semibold mb-3">Notes</h3>
        <NotesPanel target="instrument" targetId={id} />
      </section>
    </div>
  );
}

// ---- Opportunity cost vs any alternative (ETFs + stocks) ----------------
/**
 * After-tax opportunity cost of this holding measured against any alternative — the
 * configured benchmark ETFs and any individual stock you add. Reuses the per-benchmark
 * counterfactual endpoint (which accepts any symbol), best-for-you (subject ahead) first.
 */
function OpportunityCostVsAlternatives({
  id,
  subject,
  preTax,
  initialSymbols,
  current,
}: {
  id: number;
  subject: string;
  preTax: boolean;
  initialSymbols: string[];
  current: string;
}) {
  const [symbols, setSymbols] = useState<string[]>(initialSymbols);
  const [showAdd, setShowAdd] = useState(false);

  const results = useQueries({
    queries: symbols.map((sym) => ({
      queryKey: ['counterfactual', id, sym, preTax],
      queryFn: () => api.counterfactual(id, sym, preTax),
    })),
  });

  const rows = results
    .map((r, i) => ({
      sym: symbols[i],
      name: r.data?.benchmarkName ?? null,
      delta: r.data?.deltaCHF ?? null,
      xirr: r.data?.benchmarkXirr ?? null,
      loading: r.isLoading,
      failed: r.isError,
    }))
    .sort((a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity));

  const add = (sym: string) => {
    setSymbols((prev) => (prev.includes(sym) ? prev : [...prev, sym]));
    setShowAdd(false);
  };
  const remove = (sym: string) => setSymbols((prev) => prev.filter((s) => s !== sym));

  return (
    <>
      <div className="overflow-x-auto -mx-5">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="th">Alternative</th>
              <th className="th text-right">Its XIRR</th>
              <th className="th text-right">Opportunity cost</th>
              <th className="th">Verdict</th>
              <th className="th w-8"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const ahead = (r.delta ?? 0) >= 0;
              return (
                <tr key={r.sym} className={clsx('hover:bg-surface-2', r.sym === current && 'bg-azure/5')}>
                  <td className="td">
                    <span className="font-mono text-gold">{r.sym}</span>
                    {r.name && <span className="text-text-muted ml-2 text-[13px]">{r.name}</span>}
                    {r.sym === current && <span className="ml-2 text-[10px] uppercase text-azure">selected</span>}
                  </td>
                  {r.loading ? (
                    <td className="td text-right text-text-faint text-[13px]" colSpan={3}>calculating…</td>
                  ) : r.failed || r.delta == null ? (
                    <td className="td text-right text-text-faint text-[13px]" colSpan={3}>no history</td>
                  ) : (
                    <>
                      <td className="td text-right font-mono tnum text-gold">{fmtPctSigned(r.xirr)}</td>
                      <td className={clsx('td text-right font-mono tnum', plClass(r.delta))}>{fmtCHFSigned(r.delta)}</td>
                      <td className="td">
                        <span className={clsx('text-[13px]', ahead ? 'text-gain' : 'text-loss')}>
                          {ahead ? `${subject} ahead` : `${r.sym} ahead`}
                        </span>
                      </td>
                    </>
                  )}
                  <td className="td text-right">
                    <button
                      className="text-text-faint hover:text-loss transition-colors"
                      title="Remove"
                      onClick={() => remove(r.sym)}
                    >
                      <X size={13} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2 mt-3">
        <button className="chip cursor-pointer" onClick={() => setShowAdd((v) => !v)}>
          <Plus size={12} /> Add stock / ETF
        </button>
      </div>
      {showAdd && (
        <div className="mt-2 max-w-md">
          <SymbolSearch onPick={(pick) => add(pick.symbol)} />
        </div>
      )}
      <p className="text-[11px] text-text-faint mt-3">
        Positive = {subject} is ahead of that alternative after tax; negative = the money would have
        done better there. Add any individual stock, not just ETFs — same Swiss-tax basis as the
        headline figure.
      </p>
    </>
  );
}

// ---- Projection with expected-return slider -----------------------------

function ProjectionSection({ id, benchmark }: { id: number; benchmark: string }) {
  const [years, setYears] = useState(5);
  const [stockCagr, setStockCagr] = useState<number | null>(null);
  const [etfCagr, setEtfCagr] = useState<number | null>(null);

  const proj = useQuery({
    queryKey: ['projection', id, benchmark, years, stockCagr, etfCagr],
    queryFn: () =>
      api.projection(id, {
        benchmark,
        years,
        stockCagr: stockCagr ?? undefined,
        etfCagr: etfCagr ?? undefined,
      }),
  });

  const data = proj.data;
  const sc = stockCagr ?? data?.assumedStockCagr ?? 0.06;
  const ec = etfCagr ?? data?.assumedEtfCagr ?? 0.06;

  return (
    <section className="card">
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-display text-base font-semibold">Forward projection</h3>
        <span className="chip">hypothetical</span>
      </div>
      <p className="text-xs text-text-muted mb-4">
        Hold the stock vs. sell now and buy {benchmark}. Both start from today's value.
      </p>
      {data ? <ProjectionChart points={data.points} crossoverMonth={data.crossoverMonth} /> : <Spinner />}
      <div className="grid grid-cols-3 gap-3 mt-4">
        <SliderField label={`Stock CAGR ${fmtPct(sc)}`} value={sc} min={-0.1} max={0.25} onChange={setStockCagr} color="azure" />
        <SliderField label={`ETF CAGR ${fmtPct(ec)}`} value={ec} min={-0.05} max={0.2} onChange={setEtfCagr} color="gold" />
        <div>
          <div className="eyebrow mb-2">Horizon {years}y</div>
          <input
            type="range"
            min={1}
            max={20}
            step={1}
            value={years}
            onChange={(e) => setYears(Number(e.target.value))}
            className="w-full accent-azure"
          />
        </div>
      </div>
    </section>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  onChange,
  color,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  color: 'azure' | 'gold';
}) {
  return (
    <div>
      <div className="eyebrow mb-2">{label}</div>
      <input
        type="range"
        min={min}
        max={max}
        step={0.005}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={color === 'azure' ? 'w-full accent-azure' : 'w-full accent-gold'}
      />
    </div>
  );
}

// ---- Dividend shock -----------------------------------------------------

function DividendShockSection({ id }: { id: number }) {
  const [cut, setCut] = useState(1);
  const shock = useQuery({
    queryKey: ['shock', id, cut],
    queryFn: () => api.dividendShock(id, cut),
  });
  const s = shock.data;
  return (
    <section className="card">
      <div className="flex items-center gap-2 mb-1">
        <TrendingDown size={16} className="text-loss" />
        <h3 className="font-display text-base font-semibold">Dividend-shock scenario</h3>
      </div>
      <p className="text-xs text-text-muted mb-4">
        What if this stock cuts or eliminates its dividend? Annual income effect, after tax.
      </p>
      <div className="mb-4">
        <div className="eyebrow mb-2">Dividend cut: {(cut * 100).toFixed(0)}%</div>
        <input type="range" min={0} max={1} step={0.05} value={cut} onChange={(e) => setCut(Number(e.target.value))} className="w-full accent-loss" />
      </div>
      {s ? (
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Current annual gross" value={fmtCHF(s.currentAnnualGrossCHF)} />
          <Stat label="After cut" value={fmtCHF(s.shockedAnnualGrossCHF)} />
          <Stat label="Lost gross / yr" value={fmtCHFSigned(-s.lostGrossCHF)} valueClass="text-loss" />
          <Stat label="Lost net after tax / yr" value={fmtCHFSigned(-s.lostNetAfterTaxCHF)} valueClass="text-loss" />
        </div>
      ) : (
        <Spinner />
      )}
    </section>
  );
}

// ---- What-if: sell & reinvest ------------------------------------------

function WhatIfSaleSection({
  id,
  benchmark,
  preTax,
  currency,
}: {
  id: number;
  benchmark: string;
  preTax: boolean;
  currency: string;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [saleDate, setSaleDate] = useState(today);
  const [salePrice, setSalePrice] = useState<number | null>(null);
  const [reinvest, setReinvest] = useState<number | null>(null);
  const [years, setYears] = useState(5);

  const wi = useQuery({
    queryKey: ['whatif', id, benchmark, preTax, saleDate, salePrice, reinvest, years],
    queryFn: () =>
      api.whatifSale(id, {
        benchmark,
        saleDate,
        preTax,
        years,
        salePrice: salePrice ?? undefined,
        reinvestAmount: reinvest ?? undefined,
      }),
  });

  const d = wi.data;
  const ahead = (d?.deltaCHF ?? 0) >= 0;
  const held = (d?.quantityHeld ?? 0) > 0;

  return (
    <section className="card">
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-display text-base font-semibold">What if I'd sold &amp; reinvested?</h3>
        <span className="chip">hypothetical</span>
      </div>
      <p className="text-xs text-text-muted mb-4">
        Model selling on any date — at any price — and putting the proceeds (or any amount) into{' '}
        {benchmark}. Compares that against having kept the shares.
      </p>

      <div className="grid sm:grid-cols-3 gap-3 mb-5">
        <div>
          <div className="eyebrow mb-2">Sale date</div>
          <input
            type="date"
            className="input"
            max={today}
            value={saleDate}
            onChange={(e) => {
              setSaleDate(e.target.value);
              setSalePrice(null);
              setReinvest(null);
            }}
          />
        </div>
        <div>
          <div className="eyebrow mb-2">Sale price ({currency}/share)</div>
          <input
            type="number"
            className="input"
            step="0.01"
            value={salePrice ?? (d ? d.salePrice : '')}
            onChange={(e) => setSalePrice(e.target.value === '' ? null : Number(e.target.value))}
          />
        </div>
        <div>
          <div className="eyebrow mb-2">Reinvest (CHF)</div>
          <input
            type="number"
            className="input"
            step="1"
            value={reinvest ?? (d ? Math.round(d.reinvestAmountCHF) : '')}
            onChange={(e) => setReinvest(e.target.value === '' ? null : Number(e.target.value))}
          />
        </div>
      </div>

      {!d ? (
        <Spinner />
      ) : !held ? (
        <p className="text-sm text-text-muted">
          No shares were held on {fmtDate(saleDate)} — nothing to reinvest. Pick a date while you held the position.
        </p>
      ) : (
        <>
          <div className={`text-display-l font-mono font-semibold tnum leading-none ${plClass(d.deltaCHF)}`}>
            {fmtCHFSigned(d.deltaCHF)}
          </div>
          <p className={`mt-2 text-sm ${ahead ? 'text-gain' : 'text-loss'}`}>
            {ahead
              ? `Selling on ${fmtDate(d.saleDate)} and buying ${benchmark} would be ${fmtCHF(Math.abs(d.deltaCHF))} ahead today.`
              : `Keeping the shares beat selling into ${benchmark} by ${fmtCHF(Math.abs(d.deltaCHF))} — the sale would have cost you.`}
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 mt-5">
            <Stat label="Shares held" value={d.quantityHeld.toLocaleString('de-CH', { maximumFractionDigits: 4 })} />
            <Stat label="Sale price" value={fmtMoney(d.salePrice, currency)} />
            <Stat label="Proceeds" value={fmtCHF(d.proceedsCHF)} />
            <Stat label="Reinvested" value={fmtCHF(d.reinvestAmountCHF)} />
            <Stat label={`${benchmark} value today`} value={fmtCHF(d.etfValueTodayCHF)} valueClass="text-gold" />
            <Stat label="Kept-holding value today" value={fmtCHF(d.holdValueTodayCHF)} valueClass="text-azure" />
          </div>

          <div className="mt-6">
            <div className="flex items-center gap-4 mb-2 text-[11px] text-text-muted">
              <span className="flex items-center gap-1.5">
                <span className="w-4 h-0.5 bg-azure inline-block" /> Kept holding
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-4 h-0 border-t-2 border-dashed border-gold inline-block" /> {benchmark} (reinvested)
              </span>
            </div>
            <DeltaChart series={d.series} benchmarkName={benchmark} height={240} />
          </div>

          {d.forward && (
            <div className="mt-6">
              <div className="flex items-center justify-between mb-2">
                <div className="eyebrow">Forward outlook — from today</div>
                <span className="text-xs text-text-muted">
                  {benchmark} @ {fmtPct(d.forward.assumedEtfCagr)} · stock @ {fmtPct(d.forward.assumedStockCagr)} p.a.
                </span>
              </div>
              <ProjectionChart points={d.forward.points} crossoverMonth={d.forward.crossoverMonth} />
              <div className="mt-3">
                <div className="eyebrow mb-2">Horizon {years}y</div>
                <input
                  type="range"
                  min={1}
                  max={20}
                  step={1}
                  value={years}
                  onChange={(e) => setYears(Number(e.target.value))}
                  className="w-full accent-azure"
                />
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---- Transactions -------------------------------------------------------

function TransactionsCard({
  txs,
  onDelete,
  currency,
}: {
  txs: import('@decisionguru/shared').Transaction[];
  onDelete: (id: number) => void;
  currency: string;
}) {
  return (
    <section className="card !p-0 overflow-hidden">
      <h3 className="font-display text-base font-semibold px-5 pt-4 pb-3">Transactions</h3>
      <div className="overflow-x-auto max-h-[360px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0">
            <tr>
              <th className="th">Date</th>
              <th className="th">Action</th>
              <th className="th text-right">Qty</th>
              <th className="th text-right">Price</th>
              <th className="th text-right">Amount</th>
              <th className="th text-right">Fees</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {txs.map((t) => (
              <tr key={t.id} className="group hover:bg-surface-2">
                <td className="td font-mono tnum text-text-muted">{fmtDate(t.date)}</td>
                <td className="td">
                  <span
                    className={
                      t.action === 'buy'
                        ? 'text-azure'
                        : t.action === 'sell'
                        ? 'text-gold'
                        : 'text-gain'
                    }
                  >
                    {t.action}
                  </span>
                </td>
                <td className="td text-right font-mono tnum">{t.quantity || '—'}</td>
                <td className="td text-right font-mono tnum">{fmtMoney(t.unitPrice, t.currency || currency)}</td>
                <td className="td text-right font-mono tnum">
                  {t.quantity && t.unitPrice
                    ? fmtMoney(t.quantity * t.unitPrice, t.currency || currency)
                    : t.grossAmount
                    ? fmtMoney(t.grossAmount, t.currency || currency)
                    : '—'}
                </td>
                <td className="td text-right font-mono tnum text-text-faint">{t.fees || '—'}</td>
                <td className="td text-right">
                  <button
                    className="text-text-faint hover:text-loss opacity-0 group-hover:opacity-100"
                    onClick={() => onDelete(t.id)}
                    aria-label="Delete transaction"
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
            {!txs.length && (
              <tr>
                <td className="td text-text-faint" colSpan={7}>
                  No transactions.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---- Allocation + globe -------------------------------------------------

function AllocationCard({ instrumentId }: { instrumentId: number }) {
  const alloc = useQuery({ queryKey: ['allocation', instrumentId], queryFn: () => api.allocation(instrumentId) });
  const a = alloc.data;
  return (
    <section className="card flex flex-col items-center">
      <h3 className="font-display text-base font-semibold self-start mb-1">Geographic exposure</h3>
      <p className="text-xs text-text-muted self-start mb-3">
        {a ? `Source: ${a.source}` : 'Loading allocation…'}
      </p>
      {a ? (
        <>
          <Globe allocation={a} size={260} autoRotate={false} />
          <div className="w-full mt-4 space-y-3">
            <AllocList title="Countries" items={a.countries.slice(0, 6).map((c) => ({ label: c.label, weight: c.weight }))} />
            {a.sectors.length > 0 && (
              <AllocList title="Sectors" items={a.sectors.slice(0, 6).map((s) => ({ label: s.label, weight: s.weight }))} />
            )}
            {a.topHoldings.length > 1 && (
              <AllocList title="Top holdings" items={a.topHoldings.slice(0, 6).map((h) => ({ label: h.name, weight: h.weight }))} />
            )}
          </div>
        </>
      ) : (
        <Spinner />
      )}
    </section>
  );
}

function AllocList({ title, items }: { title: string; items: { label: string; weight: number }[] }) {
  const max = Math.max(...items.map((i) => i.weight), 0.0001);
  return (
    <div>
      <div className="eyebrow mb-2">{title}</div>
      <div className="space-y-1.5">
        {items.map((i, idx) => (
          <div key={idx} className="flex items-center gap-2 text-xs">
            <span className="w-28 truncate text-text-muted" title={i.label}>
              {i.label}
            </span>
            <div className="flex-1 h-1.5 bg-surface-2 rounded-full overflow-hidden">
              <div className="h-full bg-gold/70 rounded-full" style={{ width: `${(i.weight / max) * 100}%` }} />
            </div>
            <span className="font-mono tnum text-text-muted w-12 text-right">{fmtPct(i.weight)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
