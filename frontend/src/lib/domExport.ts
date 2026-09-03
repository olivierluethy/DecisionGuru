import { svgToPng } from './exporters';
import { compactBlocks, type ExportBlock, type ExportDoc } from './exportDoc';

/**
 * Turn a rendered analysis into an export document by reading what is on screen.
 *
 * Every analysis in this app already lays its numbers out — as tables, as charts, as a
 * verdict in prose, as labelled figures on cards. Writing a bespoke builder for each would
 * mean maintaining a second description of every analysis, and every new one would arrive
 * without an export until someone remembered. Reading the rendered section instead gives
 * every surface an export the moment it renders, and guarantees the document says what the
 * screen says.
 *
 * The trade-off is that extraction is a heuristic, so it is paired with the preview's
 * content picker: anything it picks up wrongly can be switched off before the file is built,
 * and the reader sees the result before saving. Interactive chrome is skipped outright, and
 * anything can be excluded explicitly with `data-export-skip`.
 */

/** Elements that are controls or navigation, never content. */
const SKIP_SELECTOR = [
  '[data-export-skip]', 'button', 'nav', 'input', 'select', 'textarea', 'label',
  '.dg-doc-chrome', '[role="tablist"]', '[aria-hidden="true"]',
].join(',');

const HEADING = /^H[1-4]$/;

function text(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function skip(el: Element): boolean {
  // A button that wraps a table cell's label is content, not chrome — only skip a control
  // when it is not inside a table.
  if (el.closest('table') && (el.tagName === 'BUTTON' || el.tagName === 'LABEL')) return false;
  return el.matches(SKIP_SELECTOR);
}

/** Smallest rendered size an SVG must have before it counts as a chart rather than an icon. */
const MIN_CHART_WIDTH = 180;
const MIN_CHART_HEIGHT = 100;

function isChart(el: Element): boolean {
  // Recharts labels its own drawing surface; trust that first and measure otherwise.
  if (el.classList.contains('recharts-surface')) return true;
  const { width, height } = el.getBoundingClientRect();
  return width >= MIN_CHART_WIDTH && height >= MIN_CHART_HEIGHT;
}

function tableFrom(el: HTMLTableElement, id: string, title?: string): ExportBlock | null {
  const headRow = el.querySelector('thead tr');
  const headers = headRow
    ? Array.from(headRow.children).map((c) => text(c))
    : [];
  const bodyRows = Array.from(el.querySelectorAll('tbody tr'));
  const rows = bodyRows
    .map((tr) => Array.from(tr.children).map((c) => text(c)))
    .filter((r) => r.some((c) => c.length > 0));
  if (!rows.length) return null;
  return {
    id,
    kind: 'table',
    title,
    headers: headers.length ? headers : rows[0].map((_, i) => `Column ${i + 1}`),
    rows,
  };
}

/**
 * Labelled figures on a card ("Fair value  CHF 412") become a two-column table.
 *
 * The app writes those labels with the `.eyebrow` class throughout, which makes them a
 * reliable anchor: the label is the eyebrow's text, the value is what remains of the block
 * it sits in once the label is removed.
 */
function figuresFrom(scope: Element, id: string, title?: string): ExportBlock | null {
  const rows: string[][] = [];
  for (const eyebrow of Array.from(scope.querySelectorAll('.eyebrow'))) {
    if (eyebrow.closest('table') || eyebrow.closest(SKIP_SELECTOR)) continue;
    const label = text(eyebrow);
    if (!label) continue;
    const host = eyebrow.parentElement;
    if (!host) continue;
    const whole = text(host);
    const value = whole.startsWith(label) ? whole.slice(label.length).trim() : '';
    if (value) rows.push([label, value]);
  }
  if (!rows.length) return null;
  return { id, kind: 'table', title, headers: ['Figure', 'Value'], rows };
}

/**
 * Extract an ExportDoc from a rendered container.
 *
 * `title` names the document; when omitted the container's own heading is used. Charts are
 * rasterised, which is why this is async.
 */
export async function docFromElement(
  container: HTMLElement,
  opts: { title?: string; subtitle?: string; filename?: string; meta?: ExportDoc['meta'] } = {},
): Promise<ExportDoc> {
  const blocks: (ExportBlock | null)[] = [];
  const seen = new Set<Element>();
  let n = 0;
  const nextId = (prefix: string) => `${prefix}-${(n += 1)}`;
  // The nearest heading above the current element titles whatever comes next.
  let heading: string | undefined;

  const visit = async (el: Element): Promise<void> => {
    if (seen.has(el) || skip(el)) return;

    if (HEADING.test(el.tagName)) {
      heading = text(el) || undefined;
      return;
    }

    if (el.tagName === 'TABLE') {
      seen.add(el);
      blocks.push(tableFrom(el as HTMLTableElement, nextId('table'), heading));
      heading = undefined;
      return;
    }

    if (el.tagName === 'svg') {
      seen.add(el);
      // Icons are SVGs too. Without a size floor every lucide glyph in the section becomes a
      // full-width image in the document — which is exactly what it did before this check.
      if (!isChart(el)) return;
      const image = await svgToPng(el as unknown as SVGSVGElement);
      if (image) blocks.push({ id: nextId('chart'), kind: 'chart', title: heading, image });
      heading = undefined;
      return;
    }

    if (el.tagName === 'P') {
      seen.add(el);
      const body = text(el);
      // Footnotes and captions are chrome for the screen, not content for a document.
      if (body.length >= 40) blocks.push({ id: nextId('text'), kind: 'text', title: heading, body });
      heading = undefined;
      return;
    }

    // A card with labelled figures and no table of its own becomes one figures table, so
    // the numbers travel as data rather than as a run-on sentence.
    if (el.classList.contains('card') && !el.querySelector('table') && !el.querySelector('svg')) {
      const figures = figuresFrom(el, nextId('figures'), heading);
      if (figures) {
        // The card's prose still matters — take it first, then the figures.
        for (const p of Array.from(el.querySelectorAll('p'))) {
          if (skip(p) || seen.has(p)) continue;
          seen.add(p);
          const body = text(p);
          if (body.length >= 40) blocks.push({ id: nextId('text'), kind: 'text', body });
        }
        blocks.push(figures);
        el.querySelectorAll('.eyebrow').forEach((e) => seen.add(e));
        seen.add(el);
        heading = undefined;
        return;
      }
    }

    for (const child of Array.from(el.children)) await visit(child);
  };

  for (const child of Array.from(container.children)) await visit(child);

  const ownHeading = container.querySelector('h1, h2, h3');
  return {
    title: opts.title ?? (ownHeading ? text(ownHeading) : 'DecisionGuru analysis'),
    subtitle: opts.subtitle,
    filename: opts.filename,
    meta: opts.meta ?? [{ label: 'As of', value: new Date().toISOString().slice(0, 10) }],
    blocks: compactBlocks(blocks),
  };
}
