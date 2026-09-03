import { PAGE_CLASS } from './docPreview';

/**
 * Full-text search across a rendered document.
 *
 * Both renderers leave real text in the DOM — pdf.js through its text layer, docx-preview
 * natively — so one implementation serves both formats. Matches are wrapped in `<mark>`
 * rather than tracked as offsets, which keeps the highlight glued to the text through zoom
 * and reflow without a second coordinate system to keep in sync.
 */

const MARK = 'dg-find';
const ACTIVE = 'dg-find-active';

export interface SearchHit {
  /** 1-based page the hit sits on. */
  page: number;
  el: HTMLElement;
}

/** Removes every highlight and restitches the split text nodes. */
export function clearHighlights(root: HTMLElement): void {
  root.querySelectorAll(`mark.${MARK}`).forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(m.textContent ?? ''), m);
    parent.normalize();
  });
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
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      // Never descend into an existing highlight, or the walk would match its own output.
      const parent = node.parentElement;
      if (!parent || parent.closest(`mark.${MARK}`)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  // Collect first, mutate after: splitting text nodes while walking invalidates the walk.
  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n.nodeValue ?? '').toLowerCase().includes(needle)) targets.push(n as Text);
  }

  for (const node of targets) {
    const text = node.nodeValue ?? '';
    const lower = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let from = 0;
    for (let at = lower.indexOf(needle, from); at !== -1; at = lower.indexOf(needle, from)) {
      if (at > from) frag.appendChild(document.createTextNode(text.slice(from, at)));
      const mark = document.createElement('mark');
      mark.className = MARK;
      mark.textContent = text.slice(at, at + needle.length);
      frag.appendChild(mark);
      hits.push({ page: pageOf(node.parentElement), el: mark });
      from = at + needle.length;
    }
    if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
    node.parentNode?.replaceChild(frag, node);
  }

  return hits;
}

/** Marks one hit as current and scrolls it into view. */
export function focusHit(hits: SearchHit[], index: number): void {
  hits.forEach((h) => h.el.classList.remove(ACTIVE));
  const hit = hits[index];
  if (!hit) return;
  hit.el.classList.add(ACTIVE);
  hit.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function pageOf(el: Element | null): number {
  const page = el?.closest<HTMLElement>(`.${PAGE_CLASS}`)?.dataset.page;
  return page ? Number(page) : 1;
}
