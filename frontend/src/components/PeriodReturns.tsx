import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { api, type PeriodReturn } from '../lib/api';
import { fmtPctSigned, fmtDate, plClass } from '../lib/format';

/**
 * Short/medium/long-term price performance side by side: 1Y / 2Y / 3Y / 5Y and
 * the full holding period, so a recent spike can be read against the long run
 * instead of being mistaken for it. Price return only (no dividends/tax) — the
 * momentum lens next to the total-return counterfactual. Cached closes only.
 */
export function PeriodReturns({ symbol, entry }: { symbol: string; entry?: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ['periods', symbol, entry ?? null],
    queryFn: () => api.periods(symbol, entry ?? undefined),
  });

  const periods = data?.periods ?? [];
  if (isLoading) {
    return <div className="text-sm text-text-faint py-4">Loading performance windows…</div>;
  }
  if (!periods.length) {
    return <div className="text-sm text-text-faint py-4">Not enough price history for period returns.</div>;
  }

  const maxAbs = Math.max(...periods.map((p) => Math.abs(p.changePct)), 0.0001);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="eyebrow">Performance by horizon · price return</div>
        <div className="text-[11px] text-text-faint">as of {fmtDate(data?.asOf)}</div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {periods.map((p) => (
          <Cell key={p.key} p={p} maxAbs={maxAbs} highlight={p.key === 'HOLDING'} />
        ))}
      </div>
      <p className="text-[11px] text-text-faint mt-2">
        Price change over each trailing window (annualised below). Excludes dividends and tax —
        compare with total-return figures above.
      </p>
    </div>
  );
}

function Cell({ p, maxAbs, highlight }: { p: PeriodReturn; maxAbs: number; highlight: boolean }) {
  const up = p.changePct >= 0;
  const barW = `${Math.min(100, (Math.abs(p.changePct) / maxAbs) * 100)}%`;
  return (
    <div
      className={clsx(
        'rounded border bg-surface-2 px-3 py-2.5',
        highlight ? 'border-gold/50 border-l-2 border-l-gold' : 'border-hairline',
      )}
      title={`${p.label}: from ${fmtDate(p.fromDate)} (${p.startClose}) to ${fmtDate(p.toDate)} (${p.endClose})`}
    >
      <div className="eyebrow mb-1">{p.label}</div>
      <div className={clsx('font-mono tnum text-[17px] font-semibold leading-none', plClass(p.changePct))}>
        {fmtPctSigned(p.changePct)}
      </div>
      <div className="mt-2 h-1 rounded-full bg-hairline/60 overflow-hidden">
        <div
          className={clsx('h-full rounded-full', up ? 'bg-gain' : 'bg-loss')}
          style={{ width: barW }}
        />
      </div>
      <div className="text-[11px] text-text-faint font-mono tnum mt-1.5">
        {p.cagr != null ? `${fmtPctSigned(p.cagr)}/yr` : `${p.years}y`}
      </div>
    </div>
  );
}
