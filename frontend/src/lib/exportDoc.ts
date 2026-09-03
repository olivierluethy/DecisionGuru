/**
 * The export document model.
 *
 * Every analysis in the app that is worth taking away describes itself as an `ExportDoc`:
 * a title, a provenance line, and an ordered list of blocks. The backend renders that same
 * list to PDF and to Word, so the two documents are genuinely the same document in two
 * formats rather than two independently-drifting layouts.
 *
 * Blocks carry a stable `id` because the preview's content picker toggles them — and
 * because a toggled-off block must be able to come back in the same place.
 */

export type ExportBlock =
  | { id: string; kind: 'text'; title?: string; body: string }
  | { id: string; kind: 'table'; title?: string; headers: string[]; rows: (string | number)[][] }
  /** `image` is a data: URI — charts are rasterised client-side before they travel. */
  | { id: string; kind: 'chart'; title?: string; image: string }
  | { id: string; kind: 'notes'; title?: string; items: string[] };

export interface ExportDoc {
  title: string;
  subtitle?: string;
  /** Provenance, rendered as one line: as-of date, currency, benchmark. */
  meta?: { label: string; value: string }[];
  blocks: ExportBlock[];
  disclaimer?: string;
  /** Basename for the downloaded file, without extension. */
  filename?: string;
}

export const DEFAULT_DISCLAIMER =
  'Not financial advice. Figures are model estimates on Swiss private-investor assumptions.';

/** A short human label for a block, used by the content picker. */
export function blockLabel(b: ExportBlock): string {
  if (b.title) return b.title;
  switch (b.kind) {
    case 'chart': return 'Chart';
    case 'notes': return 'Notes';
    case 'text': return b.body.slice(0, 40) + (b.body.length > 40 ? '…' : '');
    case 'table': return `Table · ${b.headers.length} columns`;
  }
}

/** A one-line description of what a block contributes, for the picker's second line. */
export function blockDetail(b: ExportBlock): string {
  switch (b.kind) {
    case 'chart': return 'Image';
    case 'notes': return `${b.items.length} note${b.items.length === 1 ? '' : 's'}`;
    case 'text': return 'Text';
    case 'table': return `${b.rows.length} row${b.rows.length === 1 ? '' : 's'}`;
  }
}

/**
 * The wire payload for `/export/pdf` and `/export/docx`.
 *
 * `include` is the set of block ids the reader kept. Passing `undefined` keeps everything —
 * the common case, and what a caller that never opens the picker gets.
 */
export function toExportBody(doc: ExportDoc, include?: ReadonlySet<string>) {
  return {
    title: doc.title,
    subtitle: doc.subtitle,
    meta: doc.meta,
    blocks: doc.blocks.filter((b) => !include || include.has(b.id)),
    disclaimer: doc.disclaimer ?? DEFAULT_DISCLAIMER,
  };
}

/** Convenience for the common "one table" analysis. */
export function tableBlock(
  id: string, title: string, headers: string[], rows: (string | number)[][],
): ExportBlock {
  return { id, kind: 'table', title, headers, rows };
}

export function textBlock(id: string, title: string, body: string): ExportBlock {
  return { id, kind: 'text', title, body };
}

/** Drops empty tables and blank text so a document never carries an empty heading. */
export function compactBlocks(blocks: (ExportBlock | null | undefined)[]): ExportBlock[] {
  return blocks.filter((b): b is ExportBlock => {
    if (!b) return false;
    if (b.kind === 'table') return b.rows.length > 0;
    if (b.kind === 'notes') return b.items.length > 0;
    if (b.kind === 'text') return b.body.trim().length > 0;
    return Boolean(b.image);
  });
}
