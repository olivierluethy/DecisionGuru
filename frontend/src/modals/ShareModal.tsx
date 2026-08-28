import { useState } from 'react';
import { FileText, FileType, Sheet, Image as ImageIcon, Share2, Mail } from 'lucide-react';
import { useApp } from '../store';
import { Modal } from '../components/Modal';
import { api, downloadExport } from '../lib/api';
import { buildPositionExport } from '../lib/exporters';
import { renderAnalysisImage, downloadBlob, type AnalysisImageInput } from '../lib/shareImage';

/**
 * Share / export an analysis. A held position gets the full document suite (PDF/DOCX/XLSX)
 * plus an image; a not-yet-owned opportunity (symbol only) gets the image. Sharing uses the
 * Web Share API where the browser can share files, else it downloads the image. Email is a
 * mailto compose — it NEVER claims the mail was sent, and the attachment is downloaded
 * separately (browsers can't attach through mailto).
 */
export function ShareModal({
  context,
  instrumentId,
  symbol,
  name,
}: {
  context: 'portfolio' | 'position' | 'symbol';
  instrumentId?: number;
  symbol?: string;
  name?: string | null;
}) {
  const { closeModal } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const positionMode = context === 'position' && instrumentId != null;

  async function doDoc(kind: 'pdf' | 'docx' | 'excel') {
    setBusy(kind);
    try {
      const [p, cf] = await Promise.all([
        api.position(instrumentId!),
        api.counterfactual(instrumentId!),
      ]);
      const notes = (await api.listNotes('instrument', instrumentId!).catch(() => [])).map((n) => n.body);
      const payload = await buildPositionExport(p, cf, kind, notes);
      await downloadExport(kind, payload, `${p.instrument.symbol}-vs-${cf.benchmarkSymbol}`);
    } catch {
      setMsg('Could not build the export — please try again.');
    } finally {
      setBusy(null);
    }
  }

  async function imageInput(): Promise<AnalysisImageInput> {
    let sym = symbol ?? '';
    let nm = name ?? null;
    let isin: string | null = null;
    if (positionMode) {
      const pos = await api.position(instrumentId!);
      sym = pos.instrument.symbol;
      nm = pos.instrument.name;
      isin = pos.instrument.isin ?? null;
    }
    const [val, fit] = await Promise.all([
      api.valuation(sym).catch(() => null),
      api.fit(sym).catch(() => null),
    ]);
    return {
      symbol: sym,
      name: nm,
      isin,
      actionLabel: val?.recommendation?.action?.label ?? val?.recommendation?.label ?? null,
      owned: fit?.owned ?? null,
      price: val?.price ?? null,
      currency: val?.currency ?? null,
      fairValue: val?.fairValue ?? null,
      marginOfSafetyPct: val?.marginOfSafety ?? null,
      bandLabel: val?.band?.label ?? null,
      fitLine: fit?.diversification?.note ?? null,
    };
  }

  async function doImage(share: boolean) {
    setBusy(share ? 'share' : 'image');
    try {
      const input = await imageInput();
      const blob = await renderAnalysisImage(input);
      const file = new File([blob], `${input.symbol}-analysis.png`, { type: 'image/png' });
      const nav = navigator as Navigator & {
        canShare?: (d: ShareData) => boolean;
        share?: (d: ShareData) => Promise<void>;
      };
      if (share && nav.canShare?.({ files: [file] }) && nav.share) {
        await nav.share({ files: [file], title: `${input.symbol} analysis` });
      } else {
        downloadBlob(blob, file.name);
        if (share) setMsg('Your browser can’t share files directly — the image was downloaded so you can attach it.');
      }
    } catch {
      setMsg('Could not render the image — please try again.');
    } finally {
      setBusy(null);
    }
  }

  async function doEmail() {
    setBusy('email');
    try {
      const input = await imageInput();
      downloadBlob(await renderAnalysisImage(input), `${input.symbol}-analysis.png`);
      const mos =
        input.marginOfSafetyPct != null ? `${(input.marginOfSafetyPct * 100).toFixed(1)}%` : '—';
      const subject = encodeURIComponent(`${input.symbol} — DecisionGuru analysis`);
      const body = encodeURIComponent(
        `${input.symbol}${input.name ? ' (' + input.name + ')' : ''}\n` +
          `Recommendation: ${input.actionLabel ?? '—'}\n` +
          `Fair value: ${input.fairValue ?? '—'} · Margin of safety: ${mos}\n\n` +
          `The analysis image was downloaded to your device — attach it before sending.\n` +
          `(Model estimates — not financial advice.)`,
      );
      window.open(`mailto:?subject=${subject}&body=${body}`, '_blank');
      setMsg('Opened your email client. Nothing is sent until you press Send — remember to attach the downloaded image.');
    } catch {
      setMsg('Could not prepare the email — please try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal title="Share analysis" subtitle={symbol ?? undefined} onClose={closeModal} size="md">
      {positionMode ? (
        <div className="mb-5">
          <p className="eyebrow mb-2">Export document</p>
          <div className="flex gap-2 flex-wrap">
            <button className="btn-secondary" disabled={!!busy} onClick={() => doDoc('pdf')}>
              <FileText size={15} /> PDF
            </button>
            <button className="btn-secondary" disabled={!!busy} onClick={() => doDoc('docx')}>
              <FileType size={15} /> Word
            </button>
            <button className="btn-secondary" disabled={!!busy} onClick={() => doDoc('excel')}>
              <Sheet size={15} /> Excel
            </button>
            <button className="btn-secondary" disabled={!!busy} onClick={() => doImage(false)}>
              <ImageIcon size={15} /> Image
            </button>
          </div>
        </div>
      ) : (
        <div className="mb-5">
          <p className="eyebrow mb-2">Export</p>
          <button className="btn-secondary" disabled={!!busy} onClick={() => doImage(false)}>
            <ImageIcon size={15} /> Image
          </button>
        </div>
      )}
      <div>
        <p className="eyebrow mb-2">Share via</p>
        <div className="flex gap-2 flex-wrap">
          <button className="btn-secondary" disabled={!!busy} onClick={() => doImage(true)}>
            <Share2 size={15} /> System share
          </button>
          <button className="btn-secondary" disabled={!!busy} onClick={doEmail}>
            <Mail size={15} /> Email
          </button>
        </div>
      </div>
      {msg && <p className="text-[12px] text-text-faint mt-4">{msg}</p>}
    </Modal>
  );
}
