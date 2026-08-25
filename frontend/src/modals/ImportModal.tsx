import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  UploadCloud,
  CheckCircle2,
  AlertCircle,
  FileSpreadsheet,
  BadgeCheck,
  ArrowLeftRight,
  SlidersHorizontal,
  Landmark,
} from 'lucide-react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { useApp } from '../store';
import { fmtCHF, fmtDate, fmtMoney, fmtNum } from '../lib/format';
import type {
  AccountCommitResponse,
  AccountEventType,
  AccountPreviewRow,
  BrokerMappingRow,
  CanonicalField,
  ImportMapping,
  ImportPreviewRow,
  ParsedFile,
} from '@decisionguru/shared';

type Parsed = ParsedFile & { defaultActionMap: ImportMapping['actionMap'] };

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

type TxResult = { imported: number; skipped: number; corporateActions: number };

export function ImportModal() {
  const { closeModal } = useApp();
  const qc = useQueryClient();
  const [file, setFile] = useState<Parsed | null>(null);
  const [manualOverride, setManualOverride] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TxResult | null>(null);
  const [accountResult, setAccountResult] = useState<AccountCommitResponse | null>(null);

  const isAccount = file?.detectedKind === 'account';
  const detected = file?.detectedBroker === 'degiro' && !manualOverride;

  const onUpload = async (f: File) => {
    setBusy(true);
    setErr(null);
    try {
      const parsed = await api.uploadFile(f);
      setFile(parsed);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setFile(null);
    setResult(null);
    setAccountResult(null);
    setManualOverride(false);
    setErr(null);
  };

  const done = result || accountResult;

  return (
    <Modal
      title="Import DEGIRO data"
      subtitle="Drop the Account statement (Kontoauszug) for cash & dividends, and the Transactions export for holdings. Each is auto-detected."
      onClose={closeModal}
      size="xl"
      footer={<Footer result={done} onDone={closeModal} onMore={reset} />}
    >
      {err && (
        <div className="mb-4 flex items-center gap-2 text-loss text-sm bg-loss/10 border border-loss/30 rounded p-3">
          <AlertCircle size={16} /> {err}
        </div>
      )}

      {!file && <UploadStep busy={busy} onUpload={onUpload} />}

      {file && accountResult && <AccountResultScreen result={accountResult} />}
      {file && result && <ResultScreen result={result} />}

      {file && !done && isAccount && (
        <AccountPanel
          file={file}
          onCommitted={(r) => {
            setAccountResult(r);
            qc.invalidateQueries();
          }}
          setErr={setErr}
        />
      )}

      {file && !done && !isAccount && detected && (
        <DegiroPanel
          file={file}
          onCommitted={(r) => {
            setResult(r);
            qc.invalidateQueries();
          }}
          onAdjust={() => setManualOverride(true)}
          setErr={setErr}
        />
      )}

      {file && !done && !isAccount && !detected && (
        <ManualPanel
          file={file}
          onCommitted={(r) => {
            setResult(r);
            qc.invalidateQueries();
          }}
          setErr={setErr}
        />
      )}
    </Modal>
  );
}

// The footer is context-driven; the actual import buttons live in the panels to keep
// their local state. This just carries the "Done" affordance after a successful import.
function Footer({ result, onDone, onMore }: { result: unknown; onDone: () => void; onMore: () => void }) {
  if (!result) return <div className="text-[11px] text-text-faint">Local-first — your data never leaves this machine.</div>;
  return (
    <div className="ml-auto flex gap-2">
      <button className="btn-secondary" onClick={onMore}>
        Import another file
      </button>
      <button className="btn-primary" onClick={onDone}>
        Done
      </button>
    </div>
  );
}

// ---- Upload -------------------------------------------------------------

function UploadStep({ busy, onUpload }: { busy: boolean; onUpload: (f: File) => void }) {
  const [drag, setDrag] = useState(false);
  return (
    <div>
      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        <div className="flex items-start gap-2 text-sm text-text-muted bg-surface-2 border border-hairline rounded p-3">
          <Landmark size={16} className="text-azure shrink-0 mt-0.5" />
          <span>
            <b className="text-text">Account statement</b> (Kontoauszug) — DEGIRO → Reports → Account
            statement → export <span className="font-mono">CSV</span>. Brings cash, dividends by
            security, taxes, fees & deposits.
          </span>
        </div>
        <div className="flex items-start gap-2 text-sm text-text-muted bg-surface-2 border border-hairline rounded p-3">
          <BadgeCheck size={16} className="text-gain shrink-0 mt-0.5" />
          <span>
            <b className="text-text">Transactions</b> export — brings your holdings, quantities &
            cost basis. Merged with the account statement on ISIN.
          </span>
        </div>
      </div>
      <div className="text-[11px] text-text-faint mb-3">
        Both are auto-detected — drop either file (one at a time). Import both for the full overview.
      </div>
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
                <FileSpreadsheet size={12} /> DeGiro CSV (auto) · other XLS · XLSX · CSV · PDF (manual mapping)
              </div>
            </div>
          </>
        )}
        <input type="file" className="hidden" accept=".xls,.xlsx,.csv,.pdf" onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} />
      </label>
    </div>
  );
}

// ---- DeGiro auto-mapped panel ------------------------------------------

function DegiroPanel({
  file,
  onCommitted,
  onAdjust,
  setErr,
}: {
  file: Parsed;
  onCommitted: (r: { imported: number; skipped: number; corporateActions: number }) => void;
  onAdjust: () => void;
  setErr: (s: string | null) => void;
}) {
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.previewImport>> | null>(null);
  const [busy, setBusy] = useState(false);

  const mapping: ImportMapping = {
    fileId: file.fileId,
    sheetName: file.sheets[0]?.name ?? 'CSV',
    headerRowIndex: 0,
    mapping: {},
    actionMap: file.defaultActionMap,
    broker: 'degiro',
  };

  useEffect(() => {
    api.previewImport(mapping).then(setPreview).catch((e) => setErr((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.fileId]);

  const commit = async () => {
    setBusy(true);
    try {
      onCommitted(await api.commitImport(mapping));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 bg-gain/10 border border-gain/30 rounded p-3">
        <div className="flex items-start gap-2">
          <BadgeCheck size={18} className="text-gain shrink-0 mt-0.5" />
          <div>
            <div className="text-sm text-text font-medium">Detected format: {file.brokerName}</div>
            <div className="text-xs text-text-muted mt-0.5">
              Columns mapped automatically · encoding {file.encoding} · {file.sheets[0]?.rows.length ?? 0} rows
            </div>
          </div>
        </div>
        <button className="btn-ghost !px-2 text-xs shrink-0" onClick={onAdjust}>
          <SlidersHorizontal size={13} /> Adjust mapping
        </button>
      </div>

      <MappingTable rows={file.brokerMapping ?? []} />

      {preview ? (
        <PreviewSummary preview={preview} />
      ) : (
        <div className="text-sm text-text-muted py-4">Building preview…</div>
      )}

      {preview && <DegiroPreviewTable rows={preview.rows} />}

      <div className="flex justify-end pt-1">
        <button className="btn-primary" disabled={busy || !preview?.okCount} onClick={commit}>
          {busy ? 'Importing…' : `Import ${preview?.okCount ?? 0} rows`}
        </button>
      </div>
    </div>
  );
}

function MappingTable({ rows }: { rows: BrokerMappingRow[] }) {
  return (
    <div>
      <div className="label">Applied mapping (read-only)</div>
      <div className="border border-hairline rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="th">DeGiro column</th>
              <th className="th">→ Field</th>
              <th className="th">Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="td font-mono text-text-muted">{r.header}</td>
                <td className="td font-mono text-azure">{r.field}</td>
                <td className="td text-xs text-text-faint">{r.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PreviewSummary({ preview }: { preview: Awaited<ReturnType<typeof api.previewImport>> }) {
  const issues = preview.total - preview.okCount;
  return (
    <div className="flex flex-wrap items-center gap-4 text-sm">
      <span className="flex items-center gap-1.5 text-gain">
        <CheckCircle2 size={15} /> {preview.trades} trades
      </span>
      <span className="flex items-center gap-1.5 text-gold">
        <ArrowLeftRight size={15} /> {preview.corporateActions} corporate actions
      </span>
      <span className={`flex items-center gap-1.5 ${issues ? 'text-loss' : 'text-text-faint'}`}>
        {issues ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />} {issues} issues
      </span>
    </div>
  );
}

function CategoryBadge({ row }: { row: ImportPreviewRow }) {
  const corp = row.category === 'corporate_action';
  return (
    <span
      className={`chip !py-0 !px-2 ${corp ? 'text-gold border-gold/40' : 'text-azure border-azure/40'}`}
      title={corp ? 'Excluded from P/L' : undefined}
    >
      {row.label ?? (corp ? 'Corporate action' : 'Trade')}
    </span>
  );
}

function DegiroPreviewTable({ rows }: { rows: ImportPreviewRow[] }) {
  return (
    <div className="border border-hairline rounded overflow-hidden max-h-[42vh] overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0">
          <tr>
            <th className="th">Date</th>
            <th className="th">Type</th>
            <th className="th">Instrument</th>
            <th className="th text-right">Qty</th>
            <th className="th text-right">Price</th>
            <th className="th text-right">Value CHF</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.category === 'corporate_action' ? 'bg-gold/5' : ''}>
              <td className="td font-mono tnum text-text-muted whitespace-nowrap">{fmtDate(r.tx.date)}</td>
              <td className="td">
                <CategoryBadge row={r} />
              </td>
              <td className="td">
                <div className="max-w-[280px]">
                  <div className="truncate text-text">{r.tx.name}</div>
                  <div className="font-mono text-[11px] text-text-faint">{r.tx.isin}</div>
                </div>
              </td>
              <td className="td text-right font-mono tnum">{r.tx.quantity}</td>
              <td className="td text-right font-mono tnum whitespace-nowrap">
                {r.tx.nativePrice
                  ? fmtMoney(r.tx.nativePrice, r.tx.priceCurrency ?? 'USD')
                  : '—'}
              </td>
              <td className="td text-right font-mono tnum">{fmtCHF(r.tx.valueCHF, true)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- DEGIRO Account statement panel ------------------------------------

const ACCOUNT_TYPE_META: Record<AccountEventType, { label: string; cls: string }> = {
  deposit: { label: 'Deposit', cls: 'text-azure border-azure/40' },
  cash_sweep: { label: 'Cash sweep', cls: 'text-text-muted border-hairline' },
  fx_conversion: { label: 'FX', cls: 'text-gold border-gold/40' },
  dividend: { label: 'Dividend', cls: 'text-gain border-gain/40' },
  withholding_tax: { label: 'Div. tax', cls: 'text-loss border-loss/40' },
  corp_action_fee: { label: 'CA fee', cls: 'text-warn border-warn/40' },
  connectivity_fee: { label: 'Connectivity', cls: 'text-warn border-warn/40' },
  unknown: { label: 'Unknown', cls: 'text-warn border-warn/60 font-medium' },
};

function AccountTypeBadge({ type }: { type: AccountEventType }) {
  const m = ACCOUNT_TYPE_META[type];
  return <span className={`chip !py-0 !px-2 ${m.cls}`}>{m.label}</span>;
}

function AccountPanel({
  file,
  onCommitted,
  setErr,
}: {
  file: Parsed;
  onCommitted: (r: AccountCommitResponse) => void;
  setErr: (s: string | null) => void;
}) {
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.previewAccount>> | null>(null);
  const [busy, setBusy] = useState(false);

  const mapping: ImportMapping = {
    fileId: file.fileId,
    sheetName: file.sheets[0]?.name ?? 'CSV',
    headerRowIndex: 0,
    mapping: {},
    actionMap: file.defaultActionMap,
    kind: 'account',
  };

  useEffect(() => {
    api.previewAccount(mapping).then(setPreview).catch((e) => setErr((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.fileId]);

  const commit = async () => {
    setBusy(true);
    try {
      onCommitted(await api.commitAccount(mapping));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-2 bg-azure/10 border border-azure/30 rounded p-3">
        <Landmark size={18} className="text-azure shrink-0 mt-0.5" />
        <div>
          <div className="text-sm text-text font-medium">Detected format: {file.brokerName}</div>
          <div className="text-xs text-text-muted mt-0.5">
            Parsed by position (blank amount/balance columns) · encoding {file.encoding} ·{' '}
            {file.sheets[0]?.rows.length ?? 0} rows
          </div>
        </div>
      </div>

      {preview ? <AccountSummary preview={preview} /> : <div className="text-sm text-text-muted py-4">Building preview…</div>}
      {preview && <AccountPreviewTable rows={preview.rows} />}

      <div className="flex justify-end pt-1">
        <button className="btn-primary" disabled={busy || !preview?.okCount} onClick={commit}>
          {busy ? 'Importing…' : `Import ${preview?.okCount ?? 0} events`}
        </button>
      </div>
    </div>
  );
}

function AccountSummary({ preview }: { preview: Awaited<ReturnType<typeof api.previewAccount>> }) {
  const t = preview.byType;
  const chip = (label: string, n: number | undefined, cls: string) =>
    n ? (
      <span className={`flex items-center gap-1.5 ${cls}`}>
        <CheckCircle2 size={15} /> {n} {label}
      </span>
    ) : null;
  return (
    <div className="flex flex-wrap items-center gap-4 text-sm">
      {chip('dividends', t.dividend, 'text-gain')}
      {chip('taxes', t.withholding_tax, 'text-loss')}
      {chip('deposits', t.deposit, 'text-azure')}
      {chip('FX', t.fx_conversion, 'text-gold')}
      {chip('sweeps', t.cash_sweep, 'text-text-muted')}
      {(t.corp_action_fee || t.connectivity_fee) && (
        <span className="flex items-center gap-1.5 text-warn">
          <CheckCircle2 size={15} /> {(t.corp_action_fee ?? 0) + (t.connectivity_fee ?? 0)} fees
        </span>
      )}
      {preview.reversedCount > 0 && (
        <span className="flex items-center gap-1.5 text-text-faint">
          <ArrowLeftRight size={15} /> {preview.reversedCount} netted (storno)
        </span>
      )}
      <span className={`flex items-center gap-1.5 ${preview.unknownCount ? 'text-warn' : 'text-text-faint'}`}>
        {preview.unknownCount ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />} {preview.unknownCount} unknown
      </span>
    </div>
  );
}

function AccountPreviewTable({ rows }: { rows: AccountPreviewRow[] }) {
  return (
    <div className="border border-hairline rounded overflow-hidden max-h-[42vh] overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10">
          <tr>
            <th className="th">Date</th>
            <th className="th">Type</th>
            <th className="th">Security / description</th>
            <th className="th text-right">Amount</th>
            <th className="th text-right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const e = r.event;
            const dim = e.reversed ? 'opacity-40 line-through' : '';
            return (
              <tr key={i} className={r.type === 'unknown' ? 'bg-warn/5' : ''}>
                <td className={`td font-mono tnum text-text-muted whitespace-nowrap ${dim}`}>{fmtDate(e.date)}</td>
                <td className="td">
                  <AccountTypeBadge type={r.type} />
                </td>
                <td className="td">
                  <div className={`max-w-[300px] ${dim}`}>
                    <div className="truncate text-text">{e.name || e.description}</div>
                    {e.isin && <div className="font-mono text-[11px] text-text-faint">{e.isin}</div>}
                  </div>
                </td>
                <td className={`td text-right font-mono tnum whitespace-nowrap ${dim} ${e.amount < 0 ? 'text-loss' : 'text-text'}`}>
                  {fmtNum(e.amount)} {e.currency}
                </td>
                <td className={`td text-right font-mono tnum text-text-faint whitespace-nowrap ${dim}`}>
                  {e.balance != null ? `${fmtNum(e.balance)} ${e.balanceCurrency ?? ''}` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AccountResultScreen({ result }: { result: AccountCommitResponse }) {
  return (
    <div className="flex flex-col items-center py-10 text-center">
      <CheckCircle2 size={40} className="text-gain mb-3" />
      <h3 className="font-display text-lg">Imported {result.importedEvents} account events</h3>
      <p className="text-sm text-text-muted mt-1 max-w-md">
        {result.dividends} securities with dividends · {result.linked} events linked to holdings by ISIN.{' '}
        {result.skipped > 0 ? `${result.skipped} duplicates skipped. ` : 'No duplicates. '}
        {result.summary.unknownCount > 0 && `${result.summary.unknownCount} unknown events kept for review. `}
      </p>
    </div>
  );
}

// ---- Manual fallback (unrecognised formats) ----------------------------

function ManualPanel({
  file,
  onCommitted,
  setErr,
}: {
  file: Parsed;
  onCommitted: (r: { imported: number; skipped: number; corporateActions: number }) => void;
  setErr: (s: string | null) => void;
}) {
  const [sheetName, setSheetName] = useState(file.sheets[0]?.name ?? '');
  const sheet = file.sheets.find((s) => s.name === sheetName) ?? file.sheets[0];
  const [mapping, setMapping] = useState<Record<string, CanonicalField>>(sheet?.suggestedMapping ?? {});
  const [actionMap, setActionMap] = useState(file.defaultActionMap);
  const [defaultCurrency, setDefaultCurrency] = useState('');
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.previewImport>> | null>(null);
  const [busy, setBusy] = useState(false);

  const buildMapping = (): ImportMapping => ({
    fileId: file.fileId,
    sheetName,
    headerRowIndex: 0,
    mapping,
    actionMap,
    defaultCurrency: defaultCurrency || undefined,
  });

  const runPreview = async () => {
    setBusy(true);
    try {
      setPreview(await api.previewImport(buildMapping()));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    try {
      onCommitted(await api.commitImport(buildMapping()));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!sheet) return <div className="text-text-muted text-sm">No rows found in file.</div>;

  return (
    <div className="space-y-5">
      <div className="text-xs text-text-muted bg-surface-2 border border-hairline rounded p-2.5">
        Unrecognised format — map the columns below. (DeGiro files are mapped automatically.)
      </div>

      {file.sheets.length > 1 && (
        <div>
          <label className="label">Sheet</label>
          <select
            className="input !w-auto"
            value={sheetName}
            onChange={(e) => {
              setSheetName(e.target.value);
              const s = file.sheets.find((x) => x.name === e.target.value);
              if (s) setMapping(s.suggestedMapping);
              setPreview(null);
            }}
          >
            {file.sheets.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name} ({s.rows.length})
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
                onChange={(e) => {
                  setMapping((m) => ({ ...m, [h]: e.target.value as CanonicalField }));
                  setPreview(null);
                }}
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
          <label className="label">Default currency (if no column)</label>
          <input className="input" placeholder="e.g. CHF" value={defaultCurrency} onChange={(e) => setDefaultCurrency(e.target.value.toUpperCase())} />
        </div>
      </div>

      <div>
        <div className="label">Action keywords (comma-separated)</div>
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

      {preview && <PreviewSummary preview={preview} />}
      {preview && <DegiroPreviewTable rows={preview.rows} />}

      <div className="flex justify-end gap-2">
        {!preview ? (
          <button className="btn-primary" onClick={runPreview} disabled={busy}>
            Preview
          </button>
        ) : (
          <button className="btn-primary" onClick={commit} disabled={busy || !preview.okCount}>
            {busy ? 'Importing…' : `Import ${preview.okCount} rows`}
          </button>
        )}
      </div>
    </div>
  );
}

// ---- Result -------------------------------------------------------------

function ResultScreen({ result }: { result: { imported: number; skipped: number; corporateActions: number } }) {
  return (
    <div className="flex flex-col items-center py-10 text-center">
      <CheckCircle2 size={40} className="text-gain mb-3" />
      <h3 className="font-display text-lg">Imported {result.imported} transactions</h3>
      <p className="text-sm text-text-muted mt-1">
        {result.corporateActions > 0 && `${result.corporateActions} tagged as corporate actions. `}
        {result.skipped > 0 ? `${result.skipped} duplicates skipped. ` : 'No duplicates. '}
        Market data is resolving in the background.
      </p>
    </div>
  );
}
