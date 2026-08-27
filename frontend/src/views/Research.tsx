import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, X, CircleHelp, RefreshCw } from 'lucide-react';
import { api, type AssetMetrics } from '../lib/api';
import { useApp } from '../store';
import { SymbolSearch } from '../components/SymbolSearch';
import { PriceMovementChart } from '../components/PriceMovementChart';
import { ExposureBars } from '../components/ExposureBars';
import { PeriodReturns } from '../components/PeriodReturns';
import { Fundamentals } from '../components/Fundamentals';
import { ValueAnalysis } from '../components/ValueAnalysis';
import { NewsFeed } from '../components/NewsFeed';
import { Globe } from '../components/Globe';
import { MarketStatusChip } from '../components/MarketStatusChip';
import { Stat, Spinner, Segmented, EmptyState, KindBadge } from '../components/ui';
import { fmtCHF, fmtPct, fmtPctSigned, fmtNum, plClass } from '../lib/format';

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

function AssetView({ symbol, onReset }: { symbol: string; onReset: () => void }) {
  const [win, setWin] = useState('5');
  const window = Number(win);
  const { data, isLoading } = useQuery({ queryKey: ['research', symbol, window], queryFn: () => api.researchAsset(symbol, window) });
  const { data: history } = useQuery({ queryKey: ['history', symbol], queryFn: () => api.marketHistory(symbol) });
  const { data: hours } = useQuery({ queryKey: ['hours', symbol], queryFn: () => api.marketHoursSymbol(symbol) });

  if (isLoading) return <Spinner label={`Researching ${symbol}…`} />;
  if (!data) return null;
  const m = data.metrics;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-semibold font-mono">{data.symbol}</h1>
            <KindBadge kind={data.kind} />
            {hours && <MarketStatusChip hours={hours} label="name" />}
          </div>
          <p className="text-sm text-text-muted mt-1">{data.name}</p>
          {data.currentPrice != null && (
            <p className="font-mono text-sm text-text mt-1">{data.currency} {fmtNum(data.currentPrice)}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Segmented options={WINDOWS} value={win} onChange={setWin} />
          <button className="btn-secondary h-9" onClick={onReset}><RefreshCw size={14} /> New search</button>
        </div>
      </header>

      <div className="card">{metricCells(m)}</div>

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <div className="eyebrow">Full-history price</div>
          <div className="flex items-center gap-3 text-[11px] text-text-faint">
            <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-gain" /> surge</span>
            <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-loss" /> drop</span>
            <span className="flex items-center gap-1"><span className="w-3 h-2 bg-warn/20 border border-warn/30" /> stagnation</span>
          </div>
        </div>
        <PriceMovementChart series={history ?? []} movements={data.movements} currency={data.currency} height={300} />
      </div>

      <div className="card">
        <PeriodReturns symbol={data.symbol} />
      </div>

      {/* Company fundamentals — same panel the Overview position detail shows (market cap,
          P/E, margins, revenue history, analyst view). Stock-only, matching Overview. */}
      {data.kind === 'stock' && (
        <div className="card">
          <div className="eyebrow mb-3">Company fundamentals · {data.symbol}</div>
          <Fundamentals symbol={data.symbol} name={data.name} currency={data.currency} />
        </div>
      )}

      {/* Value-investing analysis — intrinsic value, margin of safety, Buffett quality. */}
      {data.kind === 'stock' && (
        <div className="card">
          <div className="eyebrow mb-3">Value analysis · what {data.symbol} is really worth</div>
          <ValueAnalysis symbol={data.symbol} price={data.currentPrice ?? null} currency={data.currency} />
        </div>
      )}

      <div className="grid lg:grid-cols-[1fr_360px] gap-6">
        <div className="card">
          <div className="eyebrow mb-4">Ranked vs your portfolio</div>
          <UniversalCompare symbol={data.symbol} name={data.name} kind={data.kind} window={window} />
        </div>
        <div className="card">
          <ClaimValidator symbol={data.symbol} />
        </div>
      </div>

      <div className="grid lg:grid-cols-[360px_1fr] gap-6">
        <div className="card">
          <div className="eyebrow mb-3">Exposure</div>
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
        <div className="card">
          <div className="eyebrow mb-3">Latest headlines</div>
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
