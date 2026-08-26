import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Plus, X } from 'lucide-react';
import { Modal } from '../components/Modal';
import { SymbolSearch } from '../components/SymbolSearch';
import { api } from '../lib/api';
import { useApp } from '../store';

type Target = { symbol: string; name: string; allocationPct: number };

export function CreatePlanModal({
  sellInstrumentIds = [],
  targets: initialTargets = [],
}: {
  sellInstrumentIds?: number[];
  targets?: Array<{ symbol: string; name?: string; allocationPct: number }>;
}) {
  const { closeModal, setView } = useApp();
  const qc = useQueryClient();
  const { data: instruments } = useQuery({ queryKey: ['instruments'], queryFn: api.listInstruments });

  const [name, setName] = useState('');
  const [selected, setSelected] = useState<number[]>(sellInstrumentIds);
  const [targets, setTargets] = useState<Target[]>(
    initialTargets.map((t) => ({ symbol: t.symbol, name: t.name ?? t.symbol, allocationPct: t.allocationPct })),
  );
  const [horizon, setHorizon] = useState('5');
  const [outcome, setOutcome] = useState('');
  const [adding, setAdding] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      api.createPlan(name.trim(), {
        sellInstrumentIds: selected,
        targets: targets.map((t) => ({ symbol: t.symbol, name: t.name, allocationPct: t.allocationPct })),
        horizonYears: Number(horizon) || 5,
        intendedOutcome: outcome.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plans'] });
      closeModal();
      setView('plans');
    },
  });

  const toggle = (id: number) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const removeTarget = (sym: string) => setTargets((t) => t.filter((x) => x.symbol !== sym));
  const addTarget = (t: Target) =>
    setTargets((prev) => (prev.some((x) => x.symbol === t.symbol) ? prev : [...prev, t]));

  const held = (instruments ?? []).filter((i) => !i.unresolved);
  const canSave = name.trim().length > 0 && targets.length > 0;
  const allocSum = targets.reduce((s, t) => s + t.allocationPct, 0) || 1;

  return (
    <Modal
      title="New decision plan"
      subtitle="Which holdings to sell, where the proceeds go, and the outcome you expect."
      onClose={closeModal}
      size="lg"
      footer={
        <>
          <button className="btn-secondary" onClick={closeModal}>Cancel</button>
          <button className="btn-primary" disabled={!canSave || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Saving…' : 'Save plan'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div>
          <label className="label">Plan name</label>
          <input className="input" placeholder="e.g. Exit laggards into world ETF" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>

        <div>
          <label className="label">Sell (optional)</label>
          <div className="border border-hairline rounded max-h-40 overflow-y-auto divide-y divide-hairline">
            {held.map((i) => (
              <button
                key={i.id}
                onClick={() => toggle(i.id)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-2"
              >
                <span className={clsx('w-4 h-4 rounded-sm border flex items-center justify-center shrink-0',
                  selected.includes(i.id) ? 'bg-azure border-azure' : 'border-hairline-strong')}>
                  {selected.includes(i.id) && <span className="text-bg text-[10px]">✓</span>}
                </span>
                <span className="font-mono text-[13px] text-azure w-20 shrink-0">{i.symbol}</span>
                <span className="text-[13px] text-text-muted truncate">{i.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="label">Reinvest into</label>
          <div className="flex flex-col gap-2">
            {targets.map((t) => (
              <div key={t.symbol} className="flex items-center gap-2">
                <span className="font-mono text-[13px] text-gold w-20 shrink-0">{t.symbol}</span>
                <span className="text-[13px] text-text-muted flex-1 truncate">{t.name}</span>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    className="input !w-20 !h-8 text-right"
                    value={Math.round((t.allocationPct / allocSum) * 100)}
                    onChange={(e) =>
                      setTargets((prev) => prev.map((x) => x.symbol === t.symbol ? { ...x, allocationPct: Math.max(0, Number(e.target.value)) / 100 } : x))
                    }
                  />
                  <span className="text-text-faint text-sm">%</span>
                </div>
                <button className="text-text-faint hover:text-loss p-1" onClick={() => removeTarget(t.symbol)}><X size={14} /></button>
              </div>
            ))}
            {adding ? (
              <div className="border border-hairline rounded p-2">
                <SymbolSearch onPick={(p) => { addTarget({ symbol: p.symbol, name: p.name, allocationPct: 1 }); setAdding(false); }} />
              </div>
            ) : (
              <button className="btn-secondary h-8 self-start" onClick={() => setAdding(true)}>
                <Plus size={14} /> Add target
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Horizon (years)</label>
            <input type="number" className="input" value={horizon} onChange={(e) => setHorizon(e.target.value)} />
          </div>
        </div>

        <div>
          <label className="label">Intended outcome</label>
          <textarea
            className="input !h-auto py-2"
            rows={2}
            placeholder="What you expect this to achieve"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}
