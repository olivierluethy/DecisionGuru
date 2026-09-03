import { useState } from 'react';
import { FileDown, Loader2 } from 'lucide-react';
import { useApp } from '../store';
import { docFromElement } from '../lib/domExport';
import type { ExportDoc } from '../lib/exportDoc';

/**
 * "PDF / Word" — the export affordance that belongs on every analysis.
 *
 * It resolves its own content at click time: either from a builder the caller supplies (for
 * the few analyses whose document carries more than the screen shows — a position's full
 * transaction list, say), or by reading the rendered section it sits in. Resolving lazily
 * matters: rasterising charts and walking the DOM on every render, for every section on a
 * long page, would cost far more than the feature is worth.
 *
 * It never downloads directly — it opens the preview, which is where the reader chooses the
 * format and sees the document before saving it.
 */
export function ExportAction({
  /** Resolves the rendered section to read, at click time. Ignored when `build` is given. */
  target,
  /** Explicit document builder, for analyses that carry more than the screen shows. */
  build,
  title,
  subtitle,
  filename,
  label = 'PDF / Word',
  className,
}: {
  target?: () => HTMLElement | null;
  build?: () => Promise<ExportDoc> | ExportDoc;
  title?: string;
  subtitle?: string;
  filename?: string;
  label?: string;
  className?: string;
}) {
  const openModal = useApp((s) => s.openModal);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const el = build ? null : target?.() ?? null;
      const doc = build
        ? await build()
        : el
          ? await docFromElement(el, { title, subtitle, filename })
          : null;
      if (doc) openModal({ kind: 'doc-preview', doc });
    } catch {
      // Nothing to recover: the preview simply does not open. Swallowing here keeps a
      // failed chart rasterisation from surfacing as an unhandled rejection.
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      title="Preview and download this analysis as PDF or Word"
      // Excluded from extraction: the button must never end up inside the document it makes.
      data-export-skip
      className={className ?? 'inline-flex items-center gap-1.5 h-7 px-2 rounded-sm border border-hairline text-[12px] text-text-muted hover:text-text hover:border-hairline-strong disabled:opacity-50'}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />} {label}
    </button>
  );
}
