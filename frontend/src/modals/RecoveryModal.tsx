import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Zap } from 'lucide-react';
import { Modal } from '../components/Modal';
import { Spinner, Stat } from '../components/ui';
import { api, type RecoveryAlternative } from '../lib/api';
import { fmtCHF, fmtCHFSigned, fmtPct, fmtPctSigned, plClass } from '../lib/format';
import { useApp } from '../store';

function recoveryLabel(a: { recoveryYears: number | null; cagr: number | null }): string {
  if (a.recoveryYears == null) return '—';
  if (a.recoveryYears === 0) return 'already recovered';
  return `${a.recoveryYears.toFixed(1)} yr @ ${((a.cagr ?? 0) * 100).toFixed(1)}%`;
}

export function RecoveryModal({ instrumentId }: { instrumentId: number }) {
  const { closeModal, openModal } = useApp();
  const { data, isLoading } = useQuery({
    queryKey: ['recovery', instrumentId],
    queryFn: () => api.recovery(instrumentId, 5),
  });

  const planWith = (targets: Array<{ symbol: string; name: string; allocationPct: number }>) =>
    openModal({ kind: 'create-plan', sellInstrumentIds: [instrumentId], targets });

  return (
    <Modal
      title={data ? `Recovery analysis — ${data.name}` : 'Recovery analysis'}
      subtitle={data ? `Sell today for ${fmtCHF(data.proceedsCHF)} · break-even target ${fmtCHF(data.targetCHF)}` : undefined}
      onClose={closeModal}
      size="lg"
      footer={<button className="btn-secondary" onClick={closeModal}>Close</button>}
    >
      {isLoading || !data ? (
        <Spinner label="Computing recovery paths…" />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-3 gap-4">
            <Stat label="Invested" value={fmtCHF(data.investedCHF)} />
            <Stat label="Value today" value={fmtCHF(data.currentValueCHF)} />
            <Stat label="Hold return" value={fmtPctSigned(data.holdReturnPct)} valueClass={plClass(data.holdReturnPct)} />
          </div>

          {data.fastest && (
            <div className="card border-l-2 border-l-gain !p-4">
              <div className="flex items-center gap-2 mb-1">
                <Zap size={14} className="text-gain" />
                <span className="eyebrow !text-gain">Fastest recovery</span>
              </div>
              <div className="flex items-baseline gap-3 flex-wrap">
                <span className="font-mono text-gold text-lg">{data.fastest.symbol}</span>
                <span className="text-text-muted text-sm">{data.fastest.name}</span>
                <span className="font-mono text-text ml-auto">{recoveryLabel(data.fastest)}</span>
              </div>
            </div>
          )}

          <div>
            <div className="eyebrow mb-2">Single-asset alternatives · ranked by recovery</div>
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="th">Alternative</th>
                    <th className="th text-right">CAGR</th>
                    <th className="th text-right">Recovery</th>
                    <th className="th text-right">Value in 5y</th>
                    <th className="th text-right"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.alternatives.map((a: RecoveryAlternative) => (
                    <tr key={a.symbol} className={clsx('hover:bg-surface-2', a.symbol === data.fastest?.symbol && 'bg-gain/5')}>
                      <td className="td">
                        <span className="font-mono text-gold">{a.symbol}</span>
                        <span className="text-text-muted ml-2 text-[13px]">{a.name}</span>
                      </td>
                      <td className="td text-right font-mono tnum">{fmtPct(a.cagr)}</td>
                      <td className="td text-right font-mono tnum text-text-muted">{recoveryLabel(a)}</td>
                      <td className="td text-right font-mono tnum">{fmtCHF(a.expectedValueCHF)}</td>
                      <td className="td text-right">
                        <button
                          className="btn-ghost h-7 !px-2"
                          onClick={() => planWith([{ symbol: a.symbol, name: a.name, allocationPct: 1 }])}
                        >
                          Plan
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {data.combinations.length > 0 && (
            <div>
              <div className="eyebrow mb-2">Multi-asset combinations · proceeds split evenly</div>
              <div className="flex flex-col gap-2">
                {data.combinations.map((c, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 p-3 rounded border border-hairline bg-surface-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      {c.targets.map((t) => (
                        <span key={t.symbol} className="font-mono text-gold text-[13px]">{t.symbol}</span>
                      ))}
                      <span className="text-text-faint text-[12px] ml-1">
                        blended {fmtPct(c.blendedCagr)} · recover {c.recoveryYears != null ? `${c.recoveryYears.toFixed(1)} yr` : '—'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-mono tnum text-sm">{fmtCHF(c.expectedValueCHF)}</span>
                      <button
                        className="btn-ghost h-7 !px-2"
                        onClick={() =>
                          planWith(c.targets.map((t) => ({ symbol: t.symbol, name: t.name, allocationPct: t.allocationPct })))
                        }
                      >
                        Plan
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-[12px] text-text-faint">
            Recovery = years for the sale proceeds to reach your invested capital at each alternative's
            historical CAGR. Compared against holding, which projects to {fmtCHFSigned(data.holdExpectedValueCHF - data.currentValueCHF)} over 5 years.
          </p>
        </div>
      )}
    </Modal>
  );
}
