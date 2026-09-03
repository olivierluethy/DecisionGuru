import { PAGE_CLASS } from './docPreview';

/**
 * Full-text search across a rendered document.
 *
 * Highlights are painted with the CSS Custom Highlight API over live `Range` objects — the
 * DOM is never touched. That is not a stylistic preference: pdf.js positions every text-layer
 * span absolutely and stretches it with a per-span `transform: scaleX(k)` so the browser's
 * glyph widths match the PDF's. Wrapping part of such a span in a `<mark>` measures that mark
 * in UNSCALED coordinates, so the highlight box drifts further from its word the deeper into
 * the span the match sits — boxes land beside the text, or in the margin. Ranges are resolved
 * by the browser after the transform, so they always sit exactly on the glyphs.
 *
 * Where the API is missing the old wrapping behaviour is kept as a fallback: imperfect on a
 * PDF, correct on a Word document, and better than no search at all.
 */

const HITS = 'dg-find';
const ACTIVE = 'dg-find-active';
const MARK = 'dg-find';

const supportsHighlights = (): boolean =>
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

export interface SearchHit {
  /** 1-based page the hit sits on. */
  page: number;
  range: Range;
  /** The element the hit lives in — what scrolling targets. */
  host: HTMLElement | null;
}

/** Removes every highlight, by both mechanisms. */
export function clearHighlights(root: HTMLElement): void {
  if (supportsHighlights()) {
    CSS.highlights.delete(HITS);
    CSS.highlights.delete(ACTIVE);
  }
  root.querySelectorAll(`mark.${MARK}`).forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(m.textContent ?? ''), m);
    parent.normalize();
  });
}

/** Text nodes worth searching, in document order. */
function textNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest(`mark.${MARK}`)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const out: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/**
 * Highlights every case-insensitive occurrence of `query` and returns the hits in document
 * order. A query shorter than two characters is ignored — one letter matches everything and
 * the highlight becomes noise.
 */
export function highlight(root: HTMLElement, query: string): SearchHit[] {
  clearHighlights(root);
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];

  const hits: SearchHit[] = [];
  const useRanges = supportsHighlights();

  for (const node of textNodes(root)) {
    const text = node.nodeValue ?? '';
    const lower = text.toLowerCase();
    if (!lower.includes(needle)) continue;

    if (useRanges) {
      for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        hits.push({ page: pageOf(node.parentElement), range, host: node.parentElement });
      }
      continue;
    }

    // Fallback: split the text node and wrap the matches.
    const frag = document.createDocumentFragment();
    let from = 0;
    for (let at = lower.indexOf(needle, from); at !== -1; at = lower.indexOf(needle, from)) {
      if (at > from) frag.appendChild(document.createTextNode(text.slice(from, at)));
      const mark = document.createElement('mark');
      mark.className = MARK;
      mark.textContent = text.slice(at, at + needle.length);
      frag.appendChild(mark);
      const range = document.createRange();
      range.selectNode(mark);
      hits.push({ page: pageOf(node.parentElement), range, host: mark });
      from = at + needle.length;
    }
    if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
    node.parentNode?.replaceChild(frag, node);
  }

  if (useRanges && hits.length) {
    CSS.highlights.set(HITS, new Highlight(...hits.map((h) => h.range)));
  }
  return hits;
}

/** Marks one hit as current and scrolls it into view. */
export function focusHit(hits: SearchHit[], index: number): void {
  const hit = hits[index];
  if (!hit) return;

  if (supportsHighlights()) {
    CSS.highlights.set(ACTIVE, new Highlight(hit.range));
  } else {
    hits.forEach((h) => h.host?.classList.remove(`${MARK}-active`));
    hit.host?.classList.add(`${MARK}-active`);
  }
  hit.host?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function pageOf(el: Element | null): number {
  const page = el?.closest<HTMLElement>(`.${PAGE_CLASS}`)?.dataset.page;
  return page ? Number(page) : 1;
}
