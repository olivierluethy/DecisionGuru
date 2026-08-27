import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock, TrendingUp, TrendingDown } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../store';
import { Modal } from '../components/Modal';
import { Spinner } from '../components/ui';
import { BandBadge } from '../components/ValuationBand';
import { fmtMoney, fmtPctSigned, fmtDate } from '../lib/format';

/**
 * Point-in-time replay: "was this attractive on a past date?" Values the security against
 * its price on the chosen date, shows the band verdict then, and the hypothetical price
 * return since. Fundamentals are today's best-available (the provider has no as-of
 * statements), so the verdict is indicative — surfaced with a caveat.
 */
export function ReplayModal({ symbol, name }: { symbol: string; name?: string | null }) {
  const closeModal = useApp((s) => s.closeModal);
  // Default to one year ago (string math, no timezone surprises for a date input).
  const [date, setDate] = useState(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  });

  const { data, isFetching, isError } = useQuery({
    queryKey: ['replay', symbol, date],
    queryFn: () => api.valuation(symbol, null, null, date),
    enabled: !!date,
    retry: 1,
  });

  const ccy = data?.currency || '';
  const since = data?.hypotheticalReturnSince;

  return (
    <Modal title={`Point-in-time replay · ${symbol}`}
      subtitle={name ? `Was ${name} attractive at a past date?` : 'Was it attractive at a past date?'}
      onClose={closeModal} size="md">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Clock size={16} className="text-azure" />
          <label className="text-sm text-text-muted">Value as of</label>
          <input type="date" className="input !w-auto" value={date} max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setDate(e.target.value)} />
        </div>

        {isFetching ? (
          <Spinner label="Replaying that date…" />
        ) : isError || !data || !data.hasData ? (
          <p className="text-sm text-text-faint">Not enough data to value {symbol} on {fmtDate(date)}.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Field label={`Price on ${fmtDate(date)}`} value={data.asOfPrice != null ? fmtMoney(data.asOfPrice, ccy) : '—'} />
              <Field label="Fair value (est.)" value={data.fairValue != null ? fmtMoney(data.fairValue, ccy) : '—'} />
              <Field label="Entry target" value={data.entryTarget != null ? fmtMoney(data.entryTarget, ccy) : '—'} cls="text-gain" />
              <Field label="Price today" value={data.currentPrice != null ? fmtMoney(data.currentPrice, ccy) : '—'} />
            </div>

            <div className="card !p-4 flex items-center justify-between">
              <div>
                <div className="eyebrow mb-1">Verdict on that date</div>
                {data.band ? <BandBadge band={data.band.band} /> : <span className="text-text-faint text-sm">no band</span>}
              </div>
              {since != null && (
                <div className="text-right">
                  <div className="eyebrow mb-1">Hypothetical return since</div>
                  <div className={`font-mono text-xl font-semibold tnum inline-flex items-center gap-1 ${since >= 0 ? 'text-gain' : 'text-loss'}`}>
                    {since >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
                    {fmtPctSigned(since, 1)}
                  </div>
                </div>
              )}
            </div>

            {data.band?.band === 'undervalued' && since != null && (
              <p className="text-sm text-text-muted leading-relaxed">
                On {fmtDate(date)}, {symbol} screened <span className="text-gain">undervalued</span> — below its{' '}
                {fmtMoney(data.entryTarget ?? 0, ccy)} entry target. Buying then would have returned{' '}
                <span className={since >= 0 ? 'text-gain' : 'text-loss'}>{fmtPctSigned(since, 1)}</span> on price to today.
              </p>
            )}
            {data.asOfNote && <p className="text-[11px] text-text-faint leading-relaxed">{data.asOfNote}</p>}
          </>
        )}
      </div>
    </Modal>
  );
}

function Field({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div>
      <div className="eyebrow mb-0.5">{label}</div>
      <div className={`font-mono text-sm tnum ${cls ?? 'text-text'}`}>{value}</div>
    </div>
  );
}
