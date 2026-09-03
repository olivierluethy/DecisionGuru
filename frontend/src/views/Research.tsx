import { useState } from 'react';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Check, X, CircleHelp, RefreshCw, Eye,
  Gauge, LineChart, Percent, Building2, Radar, Gem, Scale, GitCompareArrows, PieChart, Newspaper,
  Blend,
} from 'lucide-react';
import { api, type AssetMetrics } from '../lib/api';
import { useApp } from '../store';
import { SectionNav, type NavSection, type AssetContext } from '../components/SectionNav';
import { SymbolSearch } from '../components/SymbolSearch';
import { PriceMovementChart } from '../components/PriceMovementChart';
import { ComparisonSelect, COMPARE_COLORS } from '../components/ComparisonSelect';
import { ExposureBars } from '../components/ExposureBars';
import { PeriodReturns } from '../components/PeriodReturns';
import { Fundamentals } from '../components/Fundamentals';
import { ValueAnalysis } from '../components/ValueAnalysis';
import { MarketAnalysis } from '../components/MarketAnalysis';
import { MarketCombos } from '../components/MarketCombos';
import { ExportAction } from '../components/ExportAction';
import { ProjectionChart } from '../components/ProjectionChart';
import { BenchmarkSelect } from '../components/BenchmarkSelect';
import { NewsFeed } from '../components/NewsFeed';
import { Globe } from '../components/Globe';
import { MarketStatusChip } from '../components/MarketStatusChip';
import { Stat, Spinner, Segmented, EmptyState, KindBadge, SectionHeader, InfoTooltip } from '../components/ui';
import { fmtCHF, fmtCHFSigned, fmtPct, fmtPctSigned, fmtNum, plClass, priceFreshnessLabel } from '../lib/format';

const WINDOWS = [
  { value: '3', label: '3Y' },
  { value: '5', label: '5Y' },
  { value: '10', label: '10Y' },
];

function metricCells(m: AssetMetrics) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
      <Stat label={m.returnBasis === 'money-weighted' ? 'Return (XIRR)' : 'CAGR'}
            value={fmtPctSigned(m.cagr)} valueClass={plClass(m.cagr)} />
      <Stat label="Total return" value={fmtPctSigned(m.totalReturnPct)} valueClass={plClass(m.totalReturnPct)} />
      <Stat label="Volatility" value={fmtPct(m.annualizedVol)} />
      <Stat label="Max drawdown" value={fmtPct(m.maxDrawdownPct)} valueClass="text-loss" />
      <Stat label="Sharpe" value={m.sharpe != null ? fmtNum(m.sharpe) : '—'} />
      <Stat label="Trailing yield" value={fmtPct(m.trailingYield)} />
      <Stat label="Last 1Y" value={fmtPctSigned(m.last1yPct)} valueClass={plClass(m.last1yPct)} />
      <Stat label="Window" value={m.from ? `${m.from.slice(0, 4)}–${m.to?.slice(0, 4)}` : '—'} />
    </div>
  );
}

function ClaimValidator({ symbol }: { symbol: string }) {
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const { data, isFetching } = useQuery({
    queryKey: ['claim', symbol, submitted],
    queryFn: () => api.validateClaim(symbol, submitted as string),
    enabled: !!submitted,
  });

  return (
    <div>
      <div className="eyebrow mb-2">Test a claim against history</div>
      <div className="flex gap-2">
        <input
          className="input"
          placeholder={`e.g. "${symbol} returns more than 8% a year"`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && text.trim() && setSubmitted(text.trim())}
        />
        <button className="btn-secondary shrink-0" disabled={!text.trim()} onClick={() => setSubmitted(text.trim())}>
          Check
        </button>
      </div>
      {isFetching && <div className="mt-3"><Spinner label="Checking against historical data…" /></div>}
      {data && !isFetching && (
        <div
          className={clsx(
            'mt-3 p-3 rounded border flex items-start gap-2 text-[13px]',
            data.supported === true && 'border-gain/40 bg-gain/5',
            data.supported === false && 'border-loss/40 bg-loss/5',
            data.supported == null && 'border-hairline bg-surface-2',
          )}
        >
          {data.supported === true && <Check size={16} className="text-gain mt-0.5 shrink-0" />}
          {data.supported === false && <X size={16} className="text-loss mt-0.5 shrink-0" />}
          {data.supported == null && <CircleHelp size={16} className="text-text-faint mt-0.5 shrink-0" />}
          <span className="text-text-muted leading-relaxed">{data.explanation}</span>
        </div>
      )}
    </div>
  );
}

function CompareRow({ m }: { m: AssetMetrics }) {
  return (
    <tr className="hover:bg-surface-2">
      <td className="td font-mono text-text-faint">{m.rank}</td>
      <td className="td">
        <span className="font-mono text-azure">{m.symbol}</span>
        <span className="text-text-muted ml-2 text-[13px]">{m.name}</span>
      </td>
      <td className={clsx('td text-right font-mono tnum', plClass(m.cagr))}>{fmtPctSigned(m.cagr)}</td>
      <td className="td text-right font-mono tnum text-text-muted">{fmtPct(m.annualizedVol)}</td>
      <td className="td text-right font-mono tnum text-loss">{fmtPct(m.maxDrawdownPct)}</td>
      <td className="td text-right font-mono tnum">{m.sharpe != null ? fmtNum(m.sharpe) : '—'}</td>
    </tr>
  );
}

function UniversalCompare({ symbol, name, kind, window }: { symbol: string; name: string | null; kind: string; window: number }) {
  const { data, isFetching } = useQuery({
    queryKey: ['universal', symbol, window],
    queryFn: () =>
      api.universalCompare(
        [
          { type: 'symbol', symbol, name: name ?? symbol, kind },
          { type: 'portfolio' },
          { type: 'symbol', symbol: 'VWRL.SW', name: 'FTSE All-World', kind: 'etf' },
        ],
        window,
      ),
  });
  if (isFetching) return <Spinner label="Comparing vs your portfolio…" />;
  if (!data) return null;
  return (
    <div className="overflow-x-auto -mx-5">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="th w-8">#</th>
            <th className="th">Asset</th>
            <th className="th text-right">Return</th>
            <th className="th text-right">Vol</th>
            <th className="th text-right">Max DD</th>
            <th className="th text-right">Sharpe</th>
          </tr>
        </thead>
        <tbody>
          {data.entities.map((m) => <CompareRow key={m.symbol} m={m} />)}
        </tbody>
      </table>
    </div>
  );
}

const HORIZONS = [
  { value: '3', label: '3Y' },
  { value: '5', label: '5Y' },
  { value: '10', label: '10Y' },
];

const BASIS_LABEL: Record<string, string> = {
  history: 'historical CAGR',
  override: 'your estimate',
  assumption: 'assumed',
};

/**
 * Forward opportunity cost for a *prospective* buy: if you put a hypothetical amount
 * into this asset today vs the same money in a benchmark ETF, where do the two lines
 * land over the horizon? This is the future-oriented lens Research adds for assets you
 * don't yet own — the held-position page has the equivalent for money already invested.
 */
function ProspectiveSection({ symbol }: { symbol: string }) {
  const benchmark = useApp((s) => s.benchmark);
  const [amount, setAmount] = useState(10_000);
  const [horizon, setHorizon] = useState('5');
  const years = Number(horizon);

  const { data, isFetching } = useQuery({
    queryKey: ['research-projection', symbol, benchmark, amount, years],
    queryFn: () => api.researchProjection(symbol, { benchmark, amount, years }),
    enabled: amount > 0,
  });

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
        <div className="flex items-center gap-1.5">
          <div className="eyebrow">Opportunity cost · invest {fmtCHF(amount)} today vs {benchmark}</div>
          <InfoTooltip text="What a given amount invested here today might become over your chosen horizon, compared with putting the same money in a benchmark ETF. A model estimate, pre-tax — not advice." />
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-[13px] text-text-muted">
            CHF
            <input
              type="number"
              min={0}
              step={1000}
              className="input w-28 tnum"
              value={amount}
              onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))}
            />
          </label>
          <Segmented options={HORIZONS} value={horizon} onChange={setHorizon} />
          <BenchmarkSelect />
        </div>
      </div>

      {isFetching && !data ? (
        <Spinner label="Projecting forward…" />
      ) : data ? (
        <>
          <div className="flex items-center gap-4 text-[11px] text-text-faint mb-2">
            <span className="flex items-center gap-1">
              <span className="w-4 h-0 border-t-2 border-dashed border-azure inline-block" /> hold {symbol}
            </span>
            <span className="flex items-center gap-1">
              <span className="w-4 h-0 border-t-2 border-dashed border-gold inline-block" /> {benchmark} (ETF)
            </span>
          </div>
          <ProjectionChart points={data.points} crossoverMonth={data.crossoverMonth} height={260} />
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-4">
            <Stat label={`${symbol} in ${years}y`} value={fmtCHF(data.endHoldCHF)} />
            <Stat label={`${benchmark} in ${years}y`} value={fmtCHF(data.endEtfCHF)} />
            <Stat
              label="Stock advantage"
              value={fmtCHFSigned(data.advantageCHF)}
              valueClass={plClass(data.advantageCHF)}
            />
          </div>
          <p className="text-[11px] text-text-faint mt-3 leading-relaxed">
            Expected growth — {symbol}: {fmtPct(data.assumedStockCagr)} ({BASIS_LABEL[data.stockCagrBasis]}) ·{' '}
            {benchmark}: {fmtPct(data.assumedEtfCagr)} ({BASIS_LABEL[data.etfCagrBasis]}). Model estimate,
            pre-tax, dividends not modelled here — not advice.
          </p>
        </>
      ) : (
        <p className="text-sm text-text-faint">Enter an amount to project forward.</p>
      )}
    </div>
  );
}

/** Toggle the researched asset on/off the watchlist without leaving the page. */
function WatchToggle({ symbol, name, kind }: { symbol: string; name: string | null; kind: string }) {
  const qc = useQueryClient();
  const { data: items = [] } = useQuery({ queryKey: ['watchlist'], queryFn: api.listWatchlist });
  const watched = items.find((i) => i.symbol === symbol);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['watchlist'] });
  const add = useMutation({ mutationFn: () => api.addToWatchlist({ symbol, name, kind }), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: number) => api.removeFromWatchlist(id), onSuccess: invalidate });

  return watched ? (
    <button className="btn-secondary h-9 !text-azure !border-azure/40" onClick={() => remove.mutate(watched.id)}>
      <Eye size={14} /> Watching
    </button>
  ) : (
    <button className="btn-secondary h-9" onClick={() => add.mutate()}>
      <Eye size={14} /> Watch
    </button>
  );
}

function AssetView({ symbol, onReset }: { symbol: string; onReset: () => void }) {
  const [win, setWin] = useState('5');
  const window = Number(win);
  const { data, isLoading } = useQuery({ queryKey: ['research', symbol, window], queryFn: () => api.researchAsset(symbol, window) });
  const { data: history } = useQuery({ queryKey: ['history', symbol], queryFn: () => api.marketHistory(symbol) });
  const { data: hours } = useQuery({ queryKey: ['hours', symbol], queryFn: () => api.marketHoursSymbol(symbol) });

  // Rebased comparison overlays for the full-history chart — seed with the global benchmark,
  // then add/remove any ETF or company (any market) through the selector below.
  const benchmark = useApp((s) => s.benchmark);
  const [overlaySymbols, setOverlaySymbols] = useState<string[]>(benchmark ? [benchmark] : []);
  const overlayHistories = useQueries({
    queries: overlaySymbols.map((sym) => ({
      queryKey: ['research-history-cmp', sym],
      queryFn: () => api.marketHistory(sym),
      enabled: !!sym,
      staleTime: 5 * 60_000,
    })),
  });

  if (isLoading) return <Spinner label={`Researching ${symbol}…`} />;
  if (!data) return null;
  const m = data.metrics;
  const priceOverlays = overlaySymbols
    .map((sym, i) => ({
      symbol: sym,
      series: (overlayHistories[i]?.data ?? []) as Array<{ date: string; close: number }>,
      color: COMPARE_COLORS[i % COMPARE_COLORS.length],
    }))
    .filter((o) => o.series.length > 1);
  const overlayColorOf = (sym: string) => {
    const i = overlaySymbols.indexOf(sym);
    return i >= 0 ? COMPARE_COLORS[i % COMPARE_COLORS.length] : '#5F6E82';
  };
  const isStock = data.kind === 'stock';
  // "On this page" rail — same component, anchor convention and icons the position
  // detail view uses; stock-only chapters drop for ETFs just as they do there.
  const navSections: NavSection[] = [
    { id: 'res-metrics', label: 'Metrics', icon: Gauge },
    { id: 'res-history', label: 'Price history', icon: LineChart },
    { id: 'res-returns', label: 'Period returns', icon: Percent },
    ...(isStock ? [{ id: 'res-fundamentals', label: 'Fundamentals', icon: Building2 }] : []),
    ...(isStock ? [{ id: 'res-market', label: 'Market analysis', icon: Radar }] : []),
    ...(isStock ? [{ id: 'res-combos', label: 'Combinations', icon: Blend }] : []),
    ...(isStock ? [{ id: 'res-value', label: 'Value', icon: Gem }] : []),
    { id: 'res-opportunity', label: 'Opportunity cost', icon: Scale },
    { id: 'res-ranked', label: 'Ranked', icon: GitCompareArrows },
    { id: 'res-exposure', label: 'Exposure', icon: PieChart },
    { id: 'res-news', label: 'News', icon: Newspaper },
  ];

  // Compact identity for the sticky rail — same price string as the header below
  // (`{currency} {fmtNum}` when a real price exists), same live hours. No extra fetch.
  const stickyAsset: AssetContext = {
    symbol: data.symbol,
    name: data.name,
    kind: data.kind,
    price:
      data.currentPrice != null && data.currentPrice > 0
        ? `${data.currency} ${fmtNum(data.currentPrice)}`
        : undefined,
    hours: hours ?? undefined,
  };

  return (
    <div id="view-research" className="flex flex-col gap-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-semibold font-mono">{data.symbol}</h1>
            <KindBadge kind={data.kind} />
            {hours && <MarketStatusChip hours={hours} label="name" />}
          </div>
          <p className="text-sm text-text-muted mt-1">{data.name}</p>
          {data.currentPrice != null && data.currentPrice > 0 ? (
            <p className="font-mono text-sm text-text mt-1">
              {data.currency} {fmtNum(data.currentPrice)}
              {priceFreshnessLabel(data.priceFreshness, data.priceAsOf) && (
                <span className="text-text-faint ml-2 text-[12px] font-sans">
                  {priceFreshnessLabel(data.priceFreshness, data.priceAsOf)}
                </span>
              )}
            </p>
          ) : (
            <p className="text-[12px] text-text-faint mt-1">No price data yet — fetching…</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <WatchToggle symbol={data.symbol} name={data.name} kind={data.kind} />
          <Segmented options={WINDOWS} value={win} onChange={setWin} />
          <button className="btn-secondary h-9" onClick={onReset}><RefreshCw size={14} /> New search</button>
          {/* Whole-page export; each section below carries its own as well. */}
          <ExportAction
            target={() => document.getElementById('view-research')}
            title={`${data.symbol} — ${data.name}`}
            filename={`${data.symbol}-research`}
            className="btn-secondary h-9"
          />
        </div>
      </header>

      <SectionNav sections={navSections} asset={stickyAsset} />

      <div id="res-metrics" className="card scroll-mt-24">
        <SectionHeader
          icon={Gauge}
          eyebrow={data.symbol}
          title="Key metrics"
          className="mb-4"
          info="Headline risk-and-return stats for this asset over the selected window — annualised return, total return, volatility, worst drawdown, Sharpe ratio and yield. A quick read on how rewarding, and how bumpy, it has been."
        />
        {metricCells(m)}
      </div>

      <div id="res-history" className="card scroll-mt-24">
        <SectionHeader
          icon={LineChart}
          eyebrow={data.symbol}
          title="Full-history price"
          className="mb-3"
          info="The security's entire price record. Use it to see long-run trends and judge how today's price sits against past highs, lows, and periods of surge or stagnation."
          action={
            <div className="flex items-center gap-3 text-[11px] text-text-faint flex-wrap">
              <span className="flex items-center gap-1"><span className="w-4 h-0.5 bg-azure inline-block" /> {data.symbol}</span>
              {priceOverlays.map((o) => (
                <span key={o.symbol} className="flex items-center gap-1">
                  <span className="w-4 h-0 border-t-2 border-dashed inline-block" style={{ borderColor: o.color }} /> {o.symbol}
                </span>
              ))}
              <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-gain" /> surge</span>
              <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-loss" /> drop</span>
              <span className="flex items-center gap-1"><span className="w-3 h-2 bg-warn/20 border border-warn/30" /> stagnation</span>
            </div>
          }
        />

        {/* Compare-with toolbar: the subject vs. any benchmark ETFs and/or companies. */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className="eyebrow mr-1">Compare</span>
          <ComparisonSelect subject={data.symbol} selected={overlaySymbols} onChange={setOverlaySymbols} colorOf={overlayColorOf} />
        </div>

        <PriceMovementChart
          series={history ?? []}
          movements={data.movements}
          currency={data.currency}
          height={300}
          overlays={priceOverlays}
        />
        {priceOverlays.length > 0 && (
          <p className="text-[11px] text-text-faint mt-2">
            Comparison lines are rebased to each series’ start, so every line begins level and you see who pulled ahead.
          </p>
        )}
      </div>

      <div id="res-returns" className="card scroll-mt-24">
        <PeriodReturns symbol={data.symbol} />
      </div>

      {/* Company fundamentals — same panel the Overview position detail shows (market cap,
          P/E, margins, revenue history, analyst view). Stock-only, matching Overview. */}
      {data.kind === 'stock' && (
        <div id="res-fundamentals" className="card scroll-mt-24">
          <SectionHeader icon={Building2} eyebrow={data.symbol} title="Company fundamentals" className="mb-4"
            info="The business behind the stock — market cap, valuation multiples like P/E, profit margins, revenue history and the analyst view. Shows whether the price is backed by real earnings." />
          <Fundamentals symbol={data.symbol} name={data.name} currency={data.currency} />
        </div>
      )}

      {/* Market analysis — sector, competitors & relative performance. */}
      {data.kind === 'stock' && (
        <div id="res-market" className="card scroll-mt-24">
          <SectionHeader icon={Radar} eyebrow="Sector · competitors · who is better positioned" title="Market analysis" className="mb-4"
            info="How this stock stacks up against its sector and closest competitors, and whether recent weakness or strength is company-specific or market-wide. The Market position card ranks every company in this market on value and growth strength at once — so a cheap name that is quietly falling behind its rivals is called out rather than praised." />
          <MarketAnalysis symbol={data.symbol} />
        </div>
      )}

      {/* Historical combinations — one company, or a mix, and at which split. */}
      {data.kind === 'stock' && (
        <div id="res-combos" className="card scroll-mt-24">
          <SectionHeader icon={Blend} eyebrow="One company vs. a mix · historical record" title="Best historical combination" className="mb-4"
            info="Was holding this one company the best you could have done inside its market? Every mix of up to three of its competitors is replayed on a 10% weight grid with annual rebalancing, and the best splits are ranked with the reason they won. Backward-looking and price-return only — a record, not a forecast." />
          <MarketCombos symbol={data.symbol} />
        </div>
      )}

      {/* Value-investing analysis — intrinsic value, margin of safety, Buffett quality. */}
      {data.kind === 'stock' && (
        <div id="res-value" className="card scroll-mt-24">
          <SectionHeader icon={Gem} eyebrow={`What ${data.symbol} is really worth`} title="Value analysis" className="mb-4"
            info="An estimate of what the company is intrinsically worth versus its current price — fair-value band, margin of safety and a quality scorecard — to judge whether it looks cheap or expensive." />
          <ValueAnalysis symbol={data.symbol} price={data.currentPrice ?? null} currency={data.currency}
            priceAsOf={data.priceAsOf} priceFreshness={data.priceFreshness} />
        </div>
      )}

      {/* Future-oriented opportunity cost for a prospective buy of this asset. */}
      <div id="res-opportunity" className="scroll-mt-24">
        <ProspectiveSection symbol={data.symbol} />
      </div>

      <div id="res-ranked" className="grid lg:grid-cols-[1fr_360px] gap-6 scroll-mt-24">
        <div className="card">
          <div className="flex items-center gap-1.5 mb-4">
            <div className="eyebrow">Ranked vs your portfolio</div>
            <InfoTooltip text="Where this asset would rank if added to your portfolio, scored on the same metrics as your existing holdings — so you can see whether it would strengthen or dilute what you already own." />
          </div>
          <UniversalCompare symbol={data.symbol} name={data.name} kind={data.kind} window={window} />
        </div>
        <div className="card">
          <ClaimValidator symbol={data.symbol} />
        </div>
      </div>

      <div className="grid lg:grid-cols-[360px_1fr] gap-6">
        <div id="res-exposure" className="card scroll-mt-24">
          <SectionHeader icon={PieChart} eyebrow="Where it invests" title="Exposure" className="mb-4"
            info="What you're actually invested in beneath the ticker — the mix of countries and sectors this asset gives you exposure to." />
          {data.allocation.countries?.length ? (
            <>
              <div className="flex justify-center mb-4">
                <Globe allocation={data.allocation} size={240} autoRotate={false} />
              </div>
              <ExposureBars countries={data.allocation.countries} sectors={data.allocation.sectors} columns={false} />
            </>
          ) : (
            <div className="text-sm text-text-faint">No exposure breakdown available.</div>
          )}
        </div>
        <div id="res-news" className="card scroll-mt-24">
          <SectionHeader icon={Newspaper} eyebrow={data.symbol} title="Latest headlines" className="mb-4"
            info="Recent news for this company or fund, so you can read price moves in the context of what's actually happening." />
          <NewsFeed symbol={data.symbol} limit={8} />
        </div>
      </div>
    </div>
  );
}

export function Research() {
  // Symbol lives in the store so the Research view is deep-linkable (#/research/AAPL).
  const symbol = useApp((s) => s.researchSymbol);
  const setSymbol = useApp((s) => s.setResearchSymbol);

  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      <header className="mb-6">
        <div className="eyebrow mb-1">Investment research</div>
        <h1 className="font-display text-2xl font-semibold">Research any asset</h1>
        <p className="text-sm text-text-muted mt-1 max-w-2xl">
          Search any stock or ETF — portfolio or not — for its full history, risk metrics, exposure and news,
          rank it against your portfolio, and test an investment claim against the data.
        </p>
      </header>

      {symbol ? (
        <AssetView symbol={symbol} onReset={() => setSymbol(null)} />
      ) : (
        <div className="max-w-xl">
          <div className="card">
            <div className="eyebrow mb-2">Find an asset</div>
            <SymbolSearch onPick={(p) => setSymbol(p.symbol)} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {['VWRL.SW', 'AAPL', 'NVDA', 'CSPX.L', 'NESN.SW'].map((s) => (
              <button key={s} className="chip hover:border-azure/50 hover:text-azure" onClick={() => setSymbol(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
