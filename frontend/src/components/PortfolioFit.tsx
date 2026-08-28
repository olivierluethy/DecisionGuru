import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Spinner } from './ui';
import { fmtPct } from '../lib/format';

/** "Does buying this improve MY portfolio?" — ownership, direct + indirect ETF exposure,
 *  and a diversification read. Unavailable data is labelled, never fabricated. */
export function PortfolioFit({ symbol }: { symbol: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['fit', symbol],
    queryFn: () => api.fit(symbol),
    staleTime: 10 * 60_000,
    retry: 1,
  });

  if (isLoading) return <Spinner label="Checking portfolio fit…" />;
  if (isError || !data) return <p className="text-sm text-text-faint">Portfolio fit unavailable for {symbol}.</p>;

  const ind = data.indirect;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="eyebrow">Portfolio fit</span>
        <span className="chip !py-0 !px-2">{data.owned ? 'Owned' : 'Not owned'}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
        <dt className="text-text-faint">Direct exposure</dt>
        <dd className="tnum">{data.owned ? fmtPct(data.directWeight) : '0%'}</dd>
        <dt className="text-text-faint">Indirect (ETF)</dt>
        <dd className="tnum">{ind.available ? fmtPct(ind.weight) : 'unavailable'}</dd>
        <dt className="text-text-faint">Effective exposure</dt>
        <dd className="tnum">{data.effectiveExposure != null ? fmtPct(data.effectiveExposure) : '—'}</dd>
      </dl>
      {ind.available && (
        <p className="text-[12px] text-text-faint">
          via {ind.contributors.map((c) => `${c.etfSymbol} (${fmtPct(c.viaWeight)})`).join(', ')} · {ind.note}
        </p>
      )}
      {!ind.available && <p className="text-[12px] text-text-faint">{ind.note}</p>}
      <p className="text-[13px] text-text-muted">{data.diversification.note}</p>
      {data.concentrationNote && <p className="text-[12px] text-warn">{data.concentrationNote}</p>}
    </div>
  );
}
