import { useState } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { useApp } from '../store';
import type { TxAction } from '@decisionguru/shared';

export function AddTransactionModal({ instrumentId }: { instrumentId: number }) {
  const { closeModal } = useApp();
  const qc = useQueryClient();
  const [action, setAction] = useState<TxAction>('buy');
  const [date, setDate] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [fees, setFees] = useState('');
  const [grossAmount, setGrossAmount] = useState('');
  const [currency, setCurrency] = useState('');

  const add = useMutation({
    mutationFn: () =>
      api.addTransaction({
        instrumentId,
        action,
        date,
        quantity: Number(quantity) || 0,
        unitPrice: Number(unitPrice) || 0,
        fees: Number(fees) || 0,
        grossAmount: action === 'dividend' && grossAmount ? Number(grossAmount) : null,
        currency: currency || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries();
      closeModal();
    },
  });

  const isDiv = action === 'dividend';
  const canSubmit = date && (isDiv ? Number(grossAmount) > 0 : Number(quantity) > 0 && Number(unitPrice) > 0);

  return (
    <Modal
      title="Add transaction"
      onClose={closeModal}
      footer={
        <>
          <button className="btn-secondary" onClick={closeModal}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!canSubmit || add.isPending} onClick={() => add.mutate()}>
            Add
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="label">Action</label>
          <div className="flex gap-2">
            {(['buy', 'sell', 'dividend'] as TxAction[]).map((a) => (
              <button key={a} className={action === a ? 'btn-primary' : 'btn-secondary'} onClick={() => setAction(a)}>
                {a}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Date</label>
            <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="label">Currency</label>
            <input className="input" placeholder="USD / CHF / EUR" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </div>
        </div>
        {isDiv ? (
          <div>
            <label className="label">Gross dividend (in currency)</label>
            <input type="number" className="input" value={grossAmount} onChange={(e) => setGrossAmount(e.target.value)} />
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label">Quantity</label>
              <input type="number" className="input" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </div>
            <div>
              <label className="label">Unit price</label>
              <input type="number" className="input" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
            </div>
            <div>
              <label className="label">Fees</label>
              <input type="number" className="input" value={fees} onChange={(e) => setFees(e.target.value)} />
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
