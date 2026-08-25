import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { AlertTriangle, Info } from 'lucide-react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { useApp } from '../store';
import type { AppSettings, TaxSettings } from '@decisionguru/shared';

export function SettingsModal() {
  const { closeModal } = useApp();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const [s, setS] = useState<AppSettings | null>(null);

  useEffect(() => {
    if (data && !s) setS(structuredClone(data));
  }, [data, s]);

  const save = useMutation({
    mutationFn: () => api.saveSettings(s!),
    onSuccess: () => {
      qc.invalidateQueries();
      closeModal();
    },
  });
  const reset = useMutation({
    mutationFn: () => api.resetSettings(),
    onSuccess: (fresh) => {
      setS(structuredClone(fresh));
      qc.invalidateQueries();
    },
  });

  if (!s) return null;
  const tax = s.tax;
  const setTax = (patch: Partial<TaxSettings>) => setS({ ...s, tax: { ...s.tax, ...patch } });

  return (
    <Modal
      title="Tax & settings"
      subtitle="Swiss private-investor defaults. Every analysis recomputes when you save."
      onClose={closeModal}
      size="lg"
      footer={
        <>
          <button className="btn-ghost mr-auto" onClick={() => reset.mutate()}>
            Reset to defaults
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
      <div className="space-y-6">
        <Callout>
          Capital gains are <b>tax-free</b> for a private investor. Dividends — including the
          income component of <b>accumulating</b> ETFs — are taxed as income. Reinvestment does
          not avoid the dividend tax in Switzerland.
        </Callout>

        <Group title="Income & dividends">
          <PctField label="Marginal income rate" value={tax.marginalIncomeRate} onChange={(v) => setTax({ marginalIncomeRate: v })} hint="Combined federal + cantonal + municipal on dividends" />
          <PctField label="Default ETF income yield" value={tax.defaultEtfIncomeYield} onChange={(v) => setTax({ defaultEtfIncomeYield: v })} hint="Fallback taxable income component for funds" />
        </Group>

        <Group title="Withholding tax">
          <PctField label="Swiss withholding (VSt)" value={tax.swissWithholdingRate} onChange={(v) => setTax({ swissWithholdingRate: v })} />
          <BoolField label="Swiss withholding reclaimed" value={tax.swissWithholdingReclaimed} onChange={(v) => setTax({ swissWithholdingReclaimed: v })} hint="Fully reclaimed by declaring (default)" />
          <NumField label="Reclaim delay (months)" value={tax.reclaimDelayMonths} onChange={(v) => setTax({ reclaimDelayMonths: v })} />
          <PctField label="US withholding" value={tax.foreignWithholdingUS} onChange={(v) => setTax({ foreignWithholdingUS: v })} hint="Treaty rate via W-8BEN" />
          <PctField label="US reclaim fraction (DA-1)" value={tax.foreignReclaimFractionUS} onChange={(v) => setTax({ foreignReclaimFractionUS: v })} />
          <PctField label="Other foreign withholding" value={tax.foreignWithholdingGeneric} onChange={(v) => setTax({ foreignWithholdingGeneric: v })} />
          <PctField label="Other reclaim fraction" value={tax.foreignReclaimFractionGeneric} onChange={(v) => setTax({ foreignReclaimFractionGeneric: v })} />
        </Group>

        <Group title="Wealth & other">
          <PctField label="Wealth tax rate (p.a.)" value={tax.wealthTaxRate} onChange={(v) => setTax({ wealthTaxRate: v })} digits={3} />
          <PctField label="Stamp duty per side" value={tax.stampDutyRate} onChange={(v) => setTax({ stampDutyRate: v })} digits={3} />
        </Group>

        <Group title="Benchmarks">
          <div className="col-span-2">
            <label className="label">Default benchmark ETF</label>
            <select className="input" value={s.defaultBenchmarkSymbol} onChange={(e) => setS({ ...s, defaultBenchmarkSymbol: e.target.value })}>
              {s.benchmarks.map((b) => (
                <option key={b.symbol} value={b.symbol}>
                  {b.symbol} — {b.name}
                </option>
              ))}
            </select>
          </div>
        </Group>

        <Group title="Advanced">
          <BoolField
            label="Professional trader"
            value={tax.professionalTrader}
            onChange={(v) => setTax({ professionalTrader: v, capitalGainsTaxable: v ? true : tax.capitalGainsTaxable })}
            hint="If classified as a professional securities dealer, capital gains become taxable"
          />
          <BoolField label="Capital gains taxable" value={tax.capitalGainsTaxable} onChange={(v) => setTax({ capitalGainsTaxable: v })} hint="Off for private investors" />
          {tax.professionalTrader && (
            <div className="col-span-2 flex items-start gap-2 text-warn text-sm bg-warn/10 border border-warn/30 rounded p-3">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              As a professional trader, realised gains would be taxed as income — the private-investor thesis no longer applies cleanly.
            </div>
          )}
        </Group>
      </div>
    </Modal>
  );
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm bg-azure/10 border border-azure/30 rounded p-3 text-text">
      <Info size={16} className="shrink-0 mt-0.5 text-azure" />
      <p>{children}</p>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="eyebrow mb-3">{title}</div>
      <div className="grid sm:grid-cols-2 gap-4">{children}</div>
    </div>
  );
}

function PctField({ label, value, onChange, hint, digits = 2 }: { label: string; value: number; onChange: (v: number) => void; hint?: string; digits?: number }) {
  return (
    <div>
      <label className="label">{label}</label>
      <div className="relative">
        <input
          type="number"
          step={digits === 3 ? 0.001 : 0.01}
          className="input pr-8"
          value={+(value * 100).toFixed(digits + 1)}
          onChange={(e) => onChange(Number(e.target.value) / 100)}
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-text-faint text-sm">%</span>
      </div>
      {hint && <p className="text-[11px] text-text-faint mt-1">{hint}</p>}
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="label">{label}</label>
      <input type="number" className="input" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function BoolField({ label, value, onChange, hint }: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 bg-surface-2 rounded p-3">
      <div>
        <div className="text-sm text-text">{label}</div>
        {hint && <p className="text-[11px] text-text-faint mt-0.5">{hint}</p>}
      </div>
      <button
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`w-10 h-6 rounded-full shrink-0 transition-colors relative ${value ? 'bg-azure' : 'bg-hairline-strong'}`}
      >
        <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${value ? 'left-5' : 'left-1'}`} />
      </button>
    </div>
  );
}
