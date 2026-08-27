import { TrendingDown, AlertTriangle } from 'lucide-react';
import type { SellSignal } from '../lib/api';
import { BandBadge } from './ValuationBand';
import { fmtMoney, fmtCHF, fmtCHFSigned, fmtPct } from '../lib/format';

/**
 * Full sell-signal explanation for an owned position: how far above fair value it trades,
 * and what selling would realise — cost basis, gross gain and the after-tax gain (tax-free
 * for a Swiss private investor). Estimate, never advice.
 */
export function SellSignalPanel({ signal }: { signal: SellSignal }) {
  const r = signal.reasoning;
  const sell = signal.isSellSignal;
  const ccy = signal.currency || '';
  return (
    <div className={`card !p-5 border-l-2 ${sell ? 'border-l-loss' : 'border-l-warn'}`}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          {sell ? <TrendingDown size={18} className="text-loss" /> : <AlertTriangle size={18} className="text-warn" />}
          <div>
            <div className="font-display text-base font-semibold">
              {sell ? 'Sell signal' : 'Overvalued — consider trimming'}
            </div>
            <div className="text-[12px] text-text-faint">
              {sell ? 'Price is in the significant-overvaluation zone.' : 'Price has moved above fair value.'}
            </div>
          </div>
        </div>
        <BandBadge band={signal.band} />
      </div>

      <p className="text-sm text-text-muted leading-relaxed mb-4">{r.headline}</p>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-5 gap-y-3">
        <Metric label="Premium to fair value" value={`+${fmtPct(r.premiumToFairPct / 100, 1)}`} cls="text-loss" />
        <Metric label="Fair value (est.)" value={r.fairValue != null ? fmtMoney(r.fairValue, ccy) : '—'} />
        <Metric label="Sell zone from" value={r.sellZoneAt != null ? fmtMoney(r.sellZoneAt, ccy) : '—'} />
        <Metric label="Cost basis" value={fmtCHF(r.costBasisCHF, true)} />
        <Metric label="Value now" value={fmtCHF(r.currentValueCHF, true)} />
        <Metric
          label="Unrealised gain"
          value={fmtCHFSigned(r.unrealizedGainCHF, true)}
          cls={r.unrealizedGainCHF >= 0 ? 'text-gain' : 'text-loss'}
        />
      </div>

      {/* The crown line: what you keep after tax if you sell now. */}
      <div className="mt-4 pt-4 border-t border-hairline">
        <div className="eyebrow mb-1">After-tax gain if sold now · CHF</div>
        <div className={`font-mono text-2xl font-semibold tnum ${r.afterTaxGainIfSoldCHF >= 0 ? 'text-gain' : 'text-loss'}`}>
          {fmtCHFSigned(r.afterTaxGainIfSoldCHF, true)}
        </div>
        <p className="text-[12px] text-text-faint mt-1 leading-relaxed">{r.taxNote}</p>
      </div>

      {r.qualityScore && (
        <div className="mt-3 text-[12px] text-text-faint">
          Quality {r.qualityScore.score}/{r.qualityScore.max} · valuation is a model estimate, not advice.
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div>
      <div className="eyebrow mb-0.5">{label}</div>
      <div className={`font-mono text-sm tnum ${cls ?? 'text-text'}`}>{value}</div>
    </div>
  );
}
