import { useState } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Modal } from '../components/Modal';
import { SymbolSearch, type SymbolPick } from '../components/SymbolSearch';
import { api } from '../lib/api';
import { useApp } from '../store';

export function ManualAddModal() {
  const { closeModal, selectInstrument } = useApp();
  const qc = useQueryClient();
  const [pick, setPick] = useState<SymbolPick | null>(null);
  const [date, setDate] = useState('');
  const [mode, setMode] = useState<'amount' | 'units'>('amount');
  const [amount, setAmount] = useState('');
  const [units, setUnits] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () =>
      api.addManual({
        symbol: pick!.symbol,
        name: pick!.name,
        date,
        amount: mode === 'amount' ? Number(amount) : undefined,
        units: mode === 'units' ? Number(units) : undefined,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries();
      closeModal();
      selectInstrument(res.instrument.id);
    },
    onError: (e) => setErr((e as Error).message),
  });

  const canSubmit = pick && date && ((mode === 'amount' && Number(amount) > 0) || (mode === 'units' && Number(units) > 0));

  return (
    <Modal
      title="Add a position"
      subtitle="No transaction history needed — we derive the rest from the price on your purchase date."
      onClose={closeModal}
      footer={
        <>
          <button className="btn-secondary" onClick={closeModal}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!canSubmit || add.isPending} onClick={() => add.mutate()}>
            {add.isPending ? 'Fetching price…' : 'Add position'}
          </button>
        </>
      }
    >
      {!pick ? (
        <SymbolSearch onPick={setPick} />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between bg-surface-2 rounded p-3">
            <div>
              <div className="font-mono text-azure">{pick.symbol}</div>
              <div className="text-sm text-text-muted">{pick.name}</div>
            </div>
            <button className="btn-ghost !px-2 text-sm" onClick={() => setPick(null)}>
              Change
            </button>
          </div>

          <div>
            <label className="label">Purchase date</label>
            <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} max={new Date().toISOString().slice(0, 10)} />
          </div>

          <div>
            <label className="label">How much?</label>
            <div className="flex gap-2 mb-2">
              <button className={mode === 'amount' ? 'btn-primary' : 'btn-secondary'} onClick={() => setMode('amount')}>
                By amount
              </button>
              <button className={mode === 'units' ? 'btn-primary' : 'btn-secondary'} onClick={() => setMode('units')}>
                By units
              </button>
            </div>
            {mode === 'amount' ? (
              <input
                className="input"
                type="number"
                placeholder="Amount invested (in instrument currency)"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            ) : (
              <input className="input" type="number" placeholder="Number of shares" value={units} onChange={(e) => setUnits(e.target.value)} />
            )}
          </div>
          {err && <p className="text-sm text-loss">{err}</p>}
        </div>
      )}
    </Modal>
  );
}
