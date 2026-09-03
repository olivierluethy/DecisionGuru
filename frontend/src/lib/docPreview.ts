import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { renderAsync } from 'docx-preview';
// pdf.js positions and sizes every text-layer span through ITS OWN stylesheet, driven by a
// `--total-scale-factor` custom property. Hand-written rules cannot substitute: without them
// the spans keep the default 16px and no transform, so anything measured against that text —
// a selection, a search highlight — lands beside the glyphs it is supposed to cover.
import 'pdfjs-dist/web/pdf_viewer.css';

/**
 * Rendering the real document into the DOM — PDF via pdf.js, Word via docx-preview.
 *
 * Both produce the same shape for the viewer above them: a container of page elements
 * carrying `data-page`, each with selectable text in the DOM. That is what lets ONE zoom
 * control, ONE page navigator and ONE search implementation serve both formats, instead of
 * two viewers that drift apart.
 *
 * Zoom is deliberately NOT a re-render. Pages are rasterised once at a fixed, crisp scale
 * and the container is scaled with CSS, so a zoom step is instant even on a long document.
 * The text layer sits inside the same transformed container, so selection and search
 * highlights track the zoom for free.
 */

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * CSS pixels per PDF point. 96/72 puts an A4 page at 794x1123 — byte for byte the size
 * docx-preview gives a Word A4 page, which is what makes "100%", "fit width" and the
 * thumbnail rail mean the same thing in both formats instead of two sizes of paper.
 */
const CSS_SCALE = 96 / 72;
/** Bitmap resolution behind those CSS pixels. 1.5 stays sharp to ~150% zoom. */
const RASTER = 1.5;
const THUMB_SCALE = 0.22;

export const PAGE_CLASS = 'dg-doc-page';

export interface RenderedDocument {
  pageCount: number;
  /** Small page images for the thumbnail rail; empty when the format cannot supply them. */
  thumbnails: string[];
  /** Releases the underlying document. Safe to call twice. */
  destroy: () => void;
}

/** Renders a PDF blob into `container`, one `.dg-doc-page` per page, with a text layer. */
export async function renderPdf(
  blob: Blob, container: HTMLElement, signal?: AbortSignal,
): Promise<RenderedDocument> {
  const data = new Uint8Array(await blob.arrayBuffer());
  // Keep the loading task: `destroy()` lives on it, not on the document proxy, and it is
  // what tears the worker down when the preview switches format or closes.
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  container.replaceChildren();

  const thumbnails: string[] = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    if (signal?.aborted) break;
    const page = await doc.getPage(n);
    // Two viewports for one page: the layout one decides how big the page IS, the raster
    // one only how many pixels are painted behind it. Keeping them apart is what lets the
    // bitmap get sharper without the page getting bigger.
    const viewport = page.getViewport({ scale: CSS_SCALE });
    const rasterViewport = page.getViewport({ scale: CSS_SCALE * RASTER });

    const wrap = document.createElement('div');
    wrap.className = PAGE_CLASS;
    wrap.dataset.page = String(n);
    wrap.style.width = `${viewport.width}px`;
    wrap.style.height = `${viewport.height}px`;
    // Both names are read by different pdf.js versions; setting both is cheap insurance.
    wrap.style.setProperty('--scale-factor', String(CSS_SCALE));
    wrap.style.setProperty('--total-scale-factor', String(CSS_SCALE));

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(rasterViewport.width);
    canvas.height = Math.floor(rasterViewport.height);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    wrap.appendChild(canvas);

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    wrap.appendChild(textLayerDiv);
    container.appendChild(wrap);

    const ctx = canvas.getContext('2d');
    if (ctx) await page.render({ canvas, canvasContext: ctx, viewport: rasterViewport }).promise;

    // The text layer is what makes the document selectable and searchable; without it a
    // PDF preview is a picture of a document.
    try {
      const textLayer = new pdfjs.TextLayer({
        textContentSource: await page.getTextContent(),
        container: textLayerDiv,
        viewport,
      });
      await textLayer.render();
    } catch {
      /* a page whose text cannot be laid out still renders as an image */
    }

    thumbnails.push(await thumbnailOf(page, THUMB_SCALE));
    page.cleanup();
  }

  return {
    pageCount: doc.numPages,
    thumbnails,
    destroy: () => { void task.destroy(); },
  };
}

async function thumbnailOf(page: pdfjs.PDFPageProxy, scale: number): Promise<string> {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL('image/png');
}

/**
 * Renders a .docx blob into `container`. docx-preview emits one `section.docx` per page
 * break; those are tagged so the rest of the viewer treats them exactly like PDF pages.
 */
export async function renderDocx(
  blob: Blob, container: HTMLElement, styleContainer: HTMLElement,
): Promise<RenderedDocument> {
  container.replaceChildren();
  await renderAsync(blob, container, styleContainer, {
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: false,
    experimental: true,
  });

  paginate(container);

  const pages = Array.from(container.querySelectorAll<HTMLElement>('section.docx'));
  pages.forEach((el, i) => {
    el.classList.add(PAGE_CLASS);
    el.dataset.page = String(i + 1);
  });

  return {
    pageCount: Math.max(pages.length, 1),
    // Word pages are live DOM, so the rail clones them rather than rasterising — a real
    // picture of the page without a second render pass.
    thumbnails: [],
    destroy: () => undefined,
  };
}

/** A4 aspect: page height as a multiple of page width. */
const A4_RATIO = 297 / 210;
/** Fill a page to this share of its usable height before breaking. The remainder absorbs the
 *  difference between our measurement and a real layout engine's, so content rarely spills. */
const FILL = 0.94;

/**
 * Slice the continuous flow docx-preview produced into page-shaped sections.
 *
 * A .docx stores a flow of paragraphs and ONE page-geometry declaration; it records nowhere
 * that "page 1 ends here". Word computes that when it opens the file and writes the result
 * back as `lastRenderedPageBreak` hints — which is why a Word-saved file looks paginated in a
 * web viewer and a generated one does not. Rather than forge those hints into the file (they
 * would be our guess, permanently, in a document the reader may edit), the split happens here,
 * in the view only. The downloaded file stays exactly what Word would paginate itself.
 *
 * The break points are therefore approximate: Word may move a line or two. The rail says so.
 */
function paginate(container: HTMLElement): void {
  const source = container.querySelector<HTMLElement>('section.docx');
  if (!source) return;
  const host = source.querySelector<HTMLElement>('article') ?? source;
  if (host.children.length === 0) return;

  const style = getComputedStyle(source);
  // docx-preview writes the page height the file DECLARES onto the section; trust that over
  // an assumed paper size, and fall back to A4 only if it left the height open.
  const declared = parseFloat(style.minHeight);
  const pageHeight = declared > 0 ? Math.round(declared)
    : Math.round(source.offsetWidth * A4_RATIO);
  const usable =
    (pageHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) * FILL;
  if (!(usable > 0)) return;

  // Measure everything BEFORE moving anything: relocating a block changes the layout the
  // remaining measurements would be taken from. Row heights come along because a table is
  // the one block that can be divided later, and dividing it must not need a re-measure.
  const queue = Array.from(host.children) as HTMLElement[];
  const heights = new Map<Element, number>();
  const rowHeights = new Map<Element, number>();
  for (const el of queue) {
    heights.set(el, outerHeight(el));
    if (el instanceof HTMLTableElement) {
      for (const row of Array.from(el.rows)) {
        rowHeights.set(row, row.getBoundingClientRect().height);
      }
    }
  }

  const groups: HTMLElement[][] = [[]];
  let used = 0;
  while (queue.length > 0) {
    const el = queue.shift()!;
    const current = groups[groups.length - 1];
    const height = heights.get(el) ?? 0;
    if (used + height <= usable) {
      current.push(el);
      used += height;
      continue;
    }

    // It does not fit. A table can leave behind the rows that do and carry the rest to the
    // next page, which is exactly what Word does — hence the repeated header row.
    const rest = el instanceof HTMLTableElement
      ? splitTable(el, usable - used, heights, rowHeights)
      : null;
    if (rest) {
      current.push(el);
      queue.unshift(rest);
    } else if (current.length === 0) {
      // Nothing else is on this page and the block cannot be divided honestly: give it the
      // page and let it make that page longer. Better one long page than content silently
      // cropped by the section's `overflow: hidden`.
      current.push(el);
      used += height;
      continue;
    } else {
      queue.unshift(el);   // try again with a whole page to itself
    }
    groups.push([]);
    used = 0;
  }
  if (groups[groups.length - 1].length === 0) groups.pop();

  const parent = source.parentElement;
  if (!parent || groups.length <= 1) {
    source.style.minHeight = `${pageHeight}px`;
    return;
  }

  const made: HTMLElement[] = [];
  for (const group of groups) {
    const page = source.cloneNode(false) as HTMLElement;
    page.style.minHeight = `${pageHeight}px`;
    const article = host === source ? page : (host.cloneNode(false) as HTMLElement);
    if (article !== page) page.appendChild(article);
    group.forEach((el) => article.appendChild(el));
    made.push(page);
  }
  made.forEach((pageEl) => parent.insertBefore(pageEl, source));
  source.remove();
}

/** A block's height including the margins that push the next block down. */
function outerHeight(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  return el.getBoundingClientRect().height
    + parseFloat(cs.marginTop || '0') + parseFloat(cs.marginBottom || '0');
}

/**
 * Move the rows of `table` that do not fit in `room` into a copy of it placed right after,
 * and return that copy — or null when the table cannot usefully be divided here.
 *
 * A table is the only block that can be split without inventing anything: it is a list of
 * rows, and Word breaks one across pages exactly this way, which is why the document asks it
 * to repeat the header (`w:tblHeader`) in the first place. Left whole, a long table either
 * stretched its page far past A4 or was pushed down entire, leaving the page before it half
 * empty — neither is what the reader will get when Word opens the file.
 */
function splitTable(
  table: HTMLTableElement,
  room: number,
  heights: Map<Element, number>,
  rowHeights: Map<Element, number>,
): HTMLTableElement | null {
  const rows = Array.from(table.rows);
  // A header plus a single row is already the smallest a table gets.
  if (rows.length < 3) return null;

  const [header, ...body] = rows;
  const headerHeight = rowHeights.get(header) ?? header.getBoundingClientRect().height;
  let used = headerHeight;
  let keep = 0;
  for (const row of body) {
    const height = rowHeights.get(row) ?? row.getBoundingClientRect().height;
    if (used + height > room) break;
    used += height;
    keep += 1;
  }
  // A page carrying the header and nothing else is not worth making, and a table that fits
  // whole has nothing to give up.
  if (keep === 0 || keep === body.length) return null;

  const next = table.cloneNode(false) as HTMLTableElement;
  // Rows may sit in a <tbody> or directly under the table; mirror whichever it is so the
  // copy inherits the same styling hooks.
  const section = header.parentElement === table
    ? next
    : (header.parentElement!.cloneNode(false) as HTMLElement);
  if (section !== next) next.appendChild(section);

  const headerCopy = header.cloneNode(true) as HTMLTableRowElement;
  rowHeights.set(headerCopy, headerHeight);
  section.appendChild(headerCopy);
  for (const row of body.slice(keep)) section.appendChild(row);

  table.parentElement?.insertBefore(next, table.nextSibling);
  // Measuring here is safe: every other block was measured up front, and this one has just
  // taken its final shape.
  heights.set(next, outerHeight(next));
  return next;
}
