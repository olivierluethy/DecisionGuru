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

/** Render scale for the canvas bitmap. 1.5 stays sharp up to ~200% CSS zoom. */
const BASE_SCALE = 1.5;
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
    const viewport = page.getViewport({ scale: BASE_SCALE });

    const wrap = document.createElement('div');
    wrap.className = PAGE_CLASS;
    wrap.dataset.page = String(n);
    wrap.style.width = `${viewport.width}px`;
    wrap.style.height = `${viewport.height}px`;
    // Both names are read by different pdf.js versions; setting both is cheap insurance.
    wrap.style.setProperty('--scale-factor', String(BASE_SCALE));
    wrap.style.setProperty('--total-scale-factor', String(BASE_SCALE));

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    wrap.appendChild(canvas);

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    wrap.appendChild(textLayerDiv);
    container.appendChild(wrap);

    const ctx = canvas.getContext('2d');
    if (ctx) await page.render({ canvas, canvasContext: ctx, viewport }).promise;

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
