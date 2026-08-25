import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { UploadCloud, CheckCircle2, AlertCircle, FileSpreadsheet } from 'lucide-react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { useApp } from '../store';
import type {
  CanonicalField,
  ImportMapping,
  ImportPreviewRow,
  ParsedFile,
} from '@decisionguru/shared';

const FIELDS: { value: CanonicalField; label: string }[] = [
  { value: 'ignore', label: '— ignore —' },
  { value: 'date', label: 'Date' },
  { value: 'action', label: 'Action (buy/sell/div)' },
  { value: 'symbol', label: 'Symbol / ticker' },
  { value: 'isin', label: 'ISIN' },
  { value: 'name', label: 'Name' },
  { value: 'quantity', label: 'Quantity' },
  { value: 'unitPrice', label: 'Unit price' },
  { value: 'fees', label: 'Fees' },
  { value: 'currency', label: 'Currency' },
  { value: 'grossAmount', label: 'Gross amount' },
  { value: 'netAmount', label: 'Net amount' },
  { value: 'withholding', label: 'Withholding tax' },
];

type Step = 1 | 2 | 3;

export function ImportModal() {
  const { closeModal } = useApp();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>(1);
  const [file, setFile] = useState<(ParsedFile & { defaultActionMap: ImportMapping['actionMap'] }) | null>(null);
  const [sheetName, setSheetName] = useState('');
  const [mapping, setMapping] = useState<Record<string, CanonicalField>>({});
  const [actionMap, setActionMap] = useState<ImportMapping['actionMap']>({ buy: [], sell: [], dividend: [] });
  const [defaultCurrency, setDefaultCurrency] = useState('');
  const [preview, setPreview] = useState<{ rows: ImportPreviewRow[]; okCount: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null);

  const sheet = file?.sheets.find((s) => s.name === sheetName);

  const onUpload = async (f: File) => {
    setBusy(true);
    setErr(null);
    try {
      const parsed = await api.uploadFile(f);
      setFile(parsed);
      const first = parsed.sheets[0];
      setSheetName(first?.name ?? '');
      setMapping(first?.suggestedMapping ?? {});
      setActionMap(parsed.defaultActionMap);
      setStep(2);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const selectSheet = (name: string) => {
    setSheetName(name);
    const s = file?.sheets.find((x) => x.name === name);
    if (s) setMapping(s.suggestedMapping);
  };

  const buildMapping = (): ImportMapping => ({
    fileId: file!.fileId,
    sheetName,
    headerRowIndex: 0,
    mapping,
    actionMap,
    defaultCurrency: defaultCurrency || undefined,
  });

  const runPreview = async () => {
    setBusy(true);
    setErr(null);
    try {
      const p = await api.previewImport(buildMapping());
      setPreview(p);
      setStep(3);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    try {
      const r = await api.commitImport(buildMapping());
      setResult(r);
      qc.invalidateQueries();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Import trading history"
      subtitle="Any broker — map the columns once and we adapt to the layout."
      onClose={closeModal}
      size="xl"
      footer={
        <>
          <Steps step={step} />
          <div className="ml-auto flex gap-2">
            {step === 2 && (
              <button className="btn-primary" onClick={runPreview} disabled={busy}>
                Preview
              </button>
            )}
            {step === 3 && !result && (
              <>
                <button className="btn-secondary" onClick={() => setStep(2)}>
                  Back
                </button>
                <button className="btn-primary" onClick={commit} disabled={busy || !preview?.okCount}>
                  Import {preview?.okCount ?? 0} rows
                </button>
              </>
            )}
            {result && (
              <button className="btn-primary" onClick={closeModal}>
                Done
              </button>
            )}
          </div>
        </>
      }
    >
      {err && (
        <div className="mb-4 flex items-center gap-2 text-loss text-sm bg-loss/10 border border-loss/30 rounded p-3">
          <AlertCircle size={16} /> {err}
        </div>
      )}

      {step === 1 && <UploadStep busy={busy} onUpload={onUpload} />}

      {step === 2 && sheet && (
        <div className="space-y-5">
          {file!.sheets.length > 1 && (
            <div>
              <label className="label">Sheet</label>
              <select className="input !w-auto" value={sheetName} onChange={(e) => selectSheet(e.target.value)}>
                {file!.sheets.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name} ({s.rows.length} rows)
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <div className="label">Map columns</div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {sheet.headers.map((h) => (
                <div key={h} className="bg-surface-2 rounded p-2.5">
                  <div className="text-xs text-text-muted truncate mb-1.5" title={h}>
                    {h}
                  </div>
                  <select
                    className="input !h-8 text-sm"
                    value={mapping[h] ?? 'ignore'}
                    onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value as CanonicalField }))}
                  >
                    {FIELDS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Default currency (if column absent)</label>
              <input className="input" placeholder="e.g. CHF" value={defaultCurrency} onChange={(e) => setDefaultCurrency(e.target.value.toUpperCase())} />
            </div>
          </div>

          <div>
            <div className="label">Action keywords (comma-separated, matched in the Action column)</div>
            <div className="grid sm:grid-cols-3 gap-3">
              {(['buy', 'sell', 'dividend'] as const).map((k) => (
                <div key={k}>
                  <div className="text-xs text-text-muted mb-1 capitalize">{k}</div>
                  <input
                    className="input !h-8 text-sm"
                    value={actionMap[k].join(', ')}
                    onChange={(e) => setActionMap((a) => ({ ...a, [k]: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) }))}
                  />
                </div>
              ))}
            </div>
          </div>

          <RawPreview sheet={sheet} />
        </div>
      )}

      {step === 3 && preview && !result && (
        <div>
          <div className="flex items-center gap-4 mb-3 text-sm">
            <span className="flex items-center gap-1.5 text-gain">
              <CheckCircle2 size={15} /> {preview.okCount} valid
            </span>
            <span className="flex items-center gap-1.5 text-loss">
              <AlertCircle size={15} /> {preview.total - preview.okCount} with issues
            </span>
          </div>
          <div className="border border-hairline rounded overflow-hidden max-h-[46vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0">
                <tr>
                  <th className="th"></th>
                  <th className="th">Date</th>
                  <th className="th">Action</th>
                  <th className="th">Instrument</th>
                  <th className="th text-right">Qty</th>
                  <th className="th text-right">Price</th>
                  <th className="th">Ccy</th>
                  <th className="th">Issues</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 200).map((r, i) => (
                  <tr key={i} className={r.ok ? '' : 'bg-loss/5'}>
                    <td className="td">{r.ok ? <CheckCircle2 size={14} className="text-gain" /> : <AlertCircle size={14} className="text-loss" />}</td>
                    <td className="td font-mono tnum">{r.tx.date ?? '—'}</td>
                    <td className="td">{r.tx.action ?? '—'}</td>
                    <td className="td font-mono">{r.tx.symbol || r.tx.isin || r.tx.name || '—'}</td>
                    <td className="td text-right font-mono tnum">{r.tx.quantity || '—'}</td>
                    <td className="td text-right font-mono tnum">{r.tx.unitPrice || '—'}</td>
                    <td className="td">{r.tx.currency ?? '—'}</td>
                    <td className="td text-xs text-loss">{r.errors.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result && (
        <div className="flex flex-col items-center py-8 text-center">
          <CheckCircle2 size={40} className="text-gain mb-3" />
          <h3 className="font-display text-lg">Imported {result.imported} transactions</h3>
          <p className="text-sm text-text-muted mt-1">
            {result.skipped > 0 ? `${result.skipped} duplicates skipped.` : 'No duplicates.'} Market data
            is being fetched in the background.
          </p>
        </div>
      )}
    </Modal>
  );
}

function Steps({ step }: { step: Step }) {
  const items = ['Upload', 'Map', 'Confirm'];
  return (
    <div className="flex items-center gap-3 text-xs">
      {items.map((label, i) => {
        const n = (i + 1) as Step;
        const active = n === step;
        const done = n < step;
        return (
          <div key={label} className="flex items-center gap-1.5">
            <span
              className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-mono ${
                active ? 'bg-azure text-bg' : done ? 'bg-gain/20 text-gain' : 'bg-surface-2 text-text-faint'
              }`}
            >
              {String(n).padStart(2, '0')}
            </span>
            <span className={active ? 'text-text' : 'text-text-faint'}>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function UploadStep({ busy, onUpload }: { busy: boolean; onUpload: (f: File) => void }) {
  const [drag, setDrag] = useState(false);
  return (
    <label
      className={`flex flex-col items-center justify-center gap-3 border-2 border-dashed rounded-lg py-16 cursor-pointer transition-colors ${
        drag ? 'border-azure bg-azure/5' : 'border-hairline hover:border-hairline-strong'
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files[0]) onUpload(e.dataTransfer.files[0]);
      }}
    >
      {busy ? (
        <span className="text-text-muted">Parsing…</span>
      ) : (
        <>
          <UploadCloud size={32} className="text-azure" />
          <div className="text-center">
            <div className="text-text">Drop a file or click to browse</div>
            <div className="text-xs text-text-faint mt-1 flex items-center gap-1.5 justify-center">
              <FileSpreadsheet size={12} /> XLS · XLSX · CSV · PDF
            </div>
          </div>
        </>
      )}
      <input
        type="file"
        className="hidden"
        accept=".xls,.xlsx,.csv,.pdf"
        onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
      />
    </label>
  );
}

function RawPreview({ sheet }: { sheet: ParsedFile['sheets'][number] }) {
  return (
    <div>
      <div className="label">Raw data preview</div>
      <div className="border border-hairline rounded overflow-x-auto max-h-48 overflow-y-auto">
        <table className="text-xs">
          <thead className="sticky top-0">
            <tr>
              {sheet.headers.map((h, i) => (
                <th key={i} className="th whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.slice(0, 8).map((r, i) => (
              <tr key={i}>
                {sheet.headers.map((_, j) => (
                  <td key={j} className="td whitespace-nowrap text-text-muted">
                    {r[j] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
