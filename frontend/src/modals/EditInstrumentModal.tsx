import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { useApp } from '../store';

export function EditInstrumentModal({ instrumentId }: { instrumentId: number }) {
  const { closeModal, setView } = useApp();
  const qc = useQueryClient();
  const { data: inst } = useQuery({ queryKey: ['instrument', instrumentId], queryFn: () => api.getInstrument(instrumentId) });
  const [form, setForm] = useState<Record<string, string>>({});

  const val = (k: string, fallback: unknown) => form[k] ?? (fallback == null ? '' : String(fallback));

  const save = useMutation({
    mutationFn: () =>
      api.updateInstrument(instrumentId, {
        name: val('name', inst?.name),
        kind: (val('kind', inst?.kind) as 'stock' | 'etf') || 'stock',
        domicile: val('domicile', inst?.domicile) || null,
        country: val('country', inst?.country) || null,
        currency: val('currency', inst?.currency) || 'USD',
        incomeYieldOverride: form.incomeYieldOverride ? Number(form.incomeYieldOverride) : inst?.incomeYieldOverride ?? null,
      }),
    onSuccess: () => {
      qc.invalidateQueries();
      closeModal();
    },
  });

  const del = useMutation({
    mutationFn: () => api.deleteInstrument(instrumentId),
    onSuccess: () => {
      qc.invalidateQueries();
      closeModal();
      setView('dashboard');
    },
  });

  if (!inst) return null;

  return (
    <Modal
      title={`Edit ${inst.symbol}`}
      subtitle="Correct classification and tax attributes. Domicile drives withholding treatment."
      onClose={closeModal}
      footer={
        <>
          <button className="btn-danger mr-auto" onClick={() => del.mutate()}>
            Delete position
          </button>
          <button className="btn-secondary" onClick={closeModal}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => save.mutate()}>
            Save
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label className="label">Name</label>
          <input className="input" value={val('name', inst.name)} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </div>
        <div>
          <label className="label">Kind</label>
          <select className="input" value={val('kind', inst.kind)} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
            <option value="stock">stock</option>
            <option value="etf">etf</option>
          </select>
        </div>
        <div>
          <label className="label">Currency</label>
          <input className="input" value={val('currency', inst.currency)} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))} />
        </div>
        <div>
          <label className="label">Domicile (ISO, e.g. US, CH, IE)</label>
          <input className="input" value={val('domicile', inst.domicile)} onChange={(e) => setForm((f) => ({ ...f, domicile: e.target.value.toUpperCase() }))} />
        </div>
        <div>
          <label className="label">HQ country</label>
          <input className="input" value={val('country', inst.country)} onChange={(e) => setForm((f) => ({ ...f, country: e.target.value.toUpperCase() }))} />
        </div>
        <div className="col-span-2">
          <label className="label">Income yield override (fraction, e.g. 0.018) — optional</label>
          <input
            className="input"
            type="number"
            step="0.001"
            placeholder={inst.incomeYieldOverride != null ? String(inst.incomeYieldOverride) : 'auto'}
            value={form.incomeYieldOverride ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, incomeYieldOverride: e.target.value }))}
          />
          <p className="text-xs text-text-faint mt-1">
            Used for the dividend/accumulating-fund income tax drag. Leave blank to estimate automatically.
          </p>
        </div>
      </div>
    </Modal>
  );
}
