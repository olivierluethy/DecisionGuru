import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Download, FileText, FileType, Loader2, Maximize2,
  Minus, Plus, Printer, Search, SlidersHorizontal, X,
} from 'lucide-react';
import { useApp } from '../store';
import { Modal } from '../components/Modal';
import { buildExportBlob, saveBlob } from '../lib/api';
import {
  blockDetail, blockLabel, toExportBody, type ExportDoc,
} from '../lib/exportDoc';
import { PAGE_CLASS, renderDocx, renderPdf, type RenderedDocument } from '../lib/docPreview';
import { clearHighlights, focusHit, highlight, type SearchHit } from '../lib/docSearch';

/**
 * Document preview — see the real document before it lands on disk.
 *
 * The bytes on screen are the bytes that download: the preview renders what the backend
 * actually produced, and the download button saves that same blob rather than asking for a
 * fresh build. A preview that could disagree with the file would be worse than none.
 *
 * PDF and Word are the same document in two formats, so they share one toolbar — the format
 * tabs rebuild and re-render, everything else (zoom, pages, search, print, the content
 * picker) is format-agnostic by construction. Excel is deliberately absent: a spreadsheet
 * has no pages to preview, and a mocked-up HTML table would only look like the file.
 */

type Format = 'pdf' | 'docx';

const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

export function DocumentPreviewModal({ doc }: { doc: ExportDoc }) {
  const closeModal = useApp((s) => s.closeModal);

  const [format, setFormat] = useState<Format>('pdf');
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  // Blob and format travel together. Held apart, switching format re-runs the renderer with
  // the previous format's bytes before the new build lands — a PDF handed to the .docx
  // reader, which fails with "is this a zip file?".
  const [built, setBuilt] = useState<{ blob: Blob; format: Format } | null>(null);
  const [building, setBuilding] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState<'width' | 'page' | null>('width');
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [renderNonce, setRenderNonce] = useState(0);
  const [outline, setOutline] = useState<{ key: string; title: string; el: HTMLElement }[]>([]);
  const [showPicker, setShowPicker] = useState(false);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [hitIndex, setHitIndex] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const renderedRef = useRef<RenderedDocument | null>(null);

  const include = useMemo(
    () => new Set(doc.blocks.map((b) => b.id).filter((id) => !excluded.has(id))),
    [doc.blocks, excluded],
  );
  const includeKey = [...include].sort().join('|');

  // --- build: ask the backend for the real file ---------------------------------------
  useEffect(() => {
    let alive = true;
    setBuilding(true);
    setError(null);
    buildExportBlob(format, toExportBody(doc, include))
      .then((b) => { if (alive) setBuilt({ blob: b, format }); })
      .catch(() => { if (alive) setError('Could not build the document.'); })
      .finally(() => { if (alive) setBuilding(false); });
    return () => { alive = false; };
    // `includeKey` stands in for the Set, which is a new object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, includeKey, doc]);

  // --- render: put it on screen --------------------------------------------------------
  useEffect(() => {
    const container = pagesRef.current;
    // Only render bytes that were built FOR the format now selected.
    if (!built || built.format !== format || !container) return;
    const blob = built.blob;
    const ctl = new AbortController();
    let alive = true;

    setHits([]);
    renderedRef.current?.destroy();
    renderedRef.current = null;

    (async () => {
      try {
        const rendered = format === 'pdf'
          ? await renderPdf(blob, container, ctl.signal)
          : await renderDocx(blob, container, styleRef.current ?? container);
        if (!alive) { rendered.destroy(); return; }
        renderedRef.current = rendered;
        setError(null);
        setPageCount(rendered.pageCount);
        setPage(1);
        setThumbs(rendered.thumbnails);
        setRenderNonce((n) => n + 1);
        // Read the headings back out of the rendered document rather than trusting the
        // blocks we sent: what the reader navigates is what the file actually contains.
        // docx-preview maps Word's Heading styles onto `docx_heading*` classes.
        setOutline(
          Array.from(container.querySelectorAll<HTMLElement>(
            'h1, h2, h3, [class*="heading1"], [class*="heading2"], [class*="heading3"]',
          ))
            .map((el, i) => ({ key: `${i}`, title: (el.textContent ?? '').trim(), el }))
            .filter((o) => o.title.length > 0),
        );
      } catch (err) {
        // The reason never reaches the reader, but it must reach the console — an
        // unrenderable document is otherwise a dead end with no way to diagnose it.
        console.error('[preview] render failed', err);
        if (alive) setError('Could not display this document.');
      }
    })();

    return () => { alive = false; ctl.abort(); };
  }, [built, format]);

  useEffect(() => () => { renderedRef.current?.destroy(); }, []);

  // --- fit: translate "fit width/page" into a zoom factor -------------------------------
  const applyFit = useCallback(() => {
    const scroll = scrollRef.current;
    const first = pagesRef.current?.querySelector<HTMLElement>(`.${PAGE_CLASS}`);
    if (!scroll || !first || !fit) return;
    // offsetWidth is the UNSCALED page size — the CSS transform is applied to the wrapper,
    // so measuring here is independent of the zoom already in effect.
    const padding = 48;
    const next = fit === 'width'
      ? (scroll.clientWidth - padding) / first.offsetWidth
      : Math.min((scroll.clientWidth - padding) / first.offsetWidth,
                 (scroll.clientHeight - padding) / first.offsetHeight);
    if (Number.isFinite(next) && next > 0) {
      setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));
    }
  }, [fit]);

  useEffect(() => { applyFit(); }, [applyFit, pageCount, built]);
  useEffect(() => {
    if (!fit) return;
    const onResize = () => applyFit();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [fit, applyFit]);

  // --- which page am I looking at? -----------------------------------------------------
  useEffect(() => {
    const scroll = scrollRef.current;
    const container = pagesRef.current;
    if (!scroll || !container || pageCount === 0) return;
    const onScroll = () => {
      const mid = scroll.scrollTop + scroll.clientHeight / 2;
      let current = 1;
      for (const el of container.querySelectorAll<HTMLElement>(`.${PAGE_CLASS}`)) {
        if (el.offsetTop * zoom <= mid) current = Number(el.dataset.page ?? 1);
      }
      setPage(current);
    };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => scroll.removeEventListener('scroll', onScroll);
  }, [pageCount, zoom]);

  const goToPage = (n: number) => {
    const target = Math.min(Math.max(1, n), Math.max(pageCount, 1));
    const el = pagesRef.current?.querySelector<HTMLElement>(`.${PAGE_CLASS}[data-page="${target}"]`);
    const scroll = scrollRef.current;
    if (el && scroll) scroll.scrollTo({ top: el.offsetTop * zoom - 12, behavior: 'smooth' });
    setPage(target);
  };

  // --- search --------------------------------------------------------------------------
  useEffect(() => {
    const container = pagesRef.current;
    if (!container) return;
    const id = window.setTimeout(() => {
      const found = highlight(container, query);
      setHits(found);
      setHitIndex(0);
      if (found.length) focusHit(found, 0);
    }, 200);
    return () => window.clearTimeout(id);
  }, [query, pageCount, format]);

  useEffect(() => () => {
    if (pagesRef.current) clearHighlights(pagesRef.current);
  }, []);

  const stepHit = (delta: number) => {
    if (!hits.length) return;
    const next = (hitIndex + delta + hits.length) % hits.length;
    setHitIndex(next);
    focusHit(hits, next);
  };

  // --- actions -------------------------------------------------------------------------
  const zoomBy = (dir: 1 | -1) => {
    setFit(null);
    setZoom((z) => {
      const next = dir > 0
        ? ZOOM_STEPS.find((s) => s > z + 0.001) ?? MAX_ZOOM
        : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? MIN_ZOOM;
      return next;
    });
  };

  const download = () => {
    if (!blob) return;
    const base = doc.filename || doc.title || 'decisionguru-export';
    saveBlob(blob, `${base.replace(/[^\w\-]+/g, '-').slice(0, 60)}.${format}`);
  };

  const print = () => {
    if (!blob) return;
    if (format === 'pdf') {
      // Hand the real PDF to the browser's own print pipeline rather than printing a
      // screenshot of the canvas.
      const url = URL.createObjectURL(blob);
      const frame = document.createElement('iframe');
      frame.style.position = 'fixed';
      frame.style.right = '0';
      frame.style.bottom = '0';
      frame.style.width = '0';
      frame.style.height = '0';
      frame.style.border = '0';
      frame.src = url;
      frame.onload = () => {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
        // Give the print dialog time to take its own copy before the object URL dies.
        window.setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 60_000);
      };
      document.body.appendChild(frame);
    } else {
      // The Word preview is live DOM; a print stylesheet hides everything but the pages.
      document.body.classList.add('dg-printing-doc');
      window.print();
      window.setTimeout(() => document.body.classList.remove('dg-printing-doc'), 500);
    }
  };

  // Word documents built by python-docx have no rendered page breaks, so the viewer gets a
  // single flowing page rather than a paginated one.
  const continuous = format === 'docx' && pageCount <= 1;
  const ready = built?.format === format;
  const busy = building || (!ready && !error);
  const blob = ready ? built!.blob : null;

  return (
    <Modal
      title="Document preview"
      subtitle={doc.title}
      onClose={closeModal}
      size="xl"
      // The viewer owns its layout and its panes scroll individually; letting the modal
      // body scroll too would put a second scrollbar beside the page pane.
      bodyClassName="p-0 !overflow-hidden"
      footer={
        <>
          <span className="mr-auto text-[11px] text-text-faint">
            What you see here is the file you get — the download saves these exact bytes.
          </span>
          <button className="btn-secondary" onClick={print} disabled={!blob}>
            <Printer size={15} /> Print
          </button>
          <button className="btn-secondary" onClick={closeModal}>Close</button>
          <button className="btn-primary" onClick={download} disabled={!blob}>
            <Download size={15} /> Download {format === 'pdf' ? 'PDF' : 'Word'}
          </button>
        </>
      }
    >
      {/* Toolbar */}
      <div className="flex flex-col h-[70vh]">
      <div className="shrink-0 border-b border-hairline px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-2 dg-doc-chrome">
        <div className="flex items-center gap-1 rounded bg-surface-2 border border-hairline p-0.5">
          <FormatTab active={format === 'pdf'} onClick={() => setFormat('pdf')} icon={FileText} label="PDF" />
          <FormatTab active={format === 'docx'} onClick={() => setFormat('docx')} icon={FileType} label="Word" />
        </div>

        <div className="flex items-center gap-1">
          <IconBtn onClick={() => zoomBy(-1)} title="Zoom out" disabled={zoom <= MIN_ZOOM}><Minus size={14} /></IconBtn>
          <span className="font-mono tnum text-[12px] text-text-muted w-12 text-center">{Math.round(zoom * 100)}%</span>
          <IconBtn onClick={() => zoomBy(1)} title="Zoom in" disabled={zoom >= MAX_ZOOM}><Plus size={14} /></IconBtn>
          <button className={chip(fit === 'width')} onClick={() => setFit('width')}>Fit width</button>
          <button className={chip(fit === 'page')} onClick={() => setFit('page')}>Fit page</button>
          <button className={chip(!fit && Math.abs(zoom - 1) < 0.001)}
            onClick={() => { setFit(null); setZoom(1); }} title="Actual size">
            <Maximize2 size={12} /> 100%
          </button>
        </div>

        <div className="flex items-center gap-1">
          <IconBtn onClick={() => goToPage(page - 1)} title="Previous page" disabled={page <= 1}><ChevronLeft size={14} /></IconBtn>
          {continuous ? (
            // A .docx carries no page breaks until Word lays it out, so docx-preview renders
            // one continuous page. Saying "Page 1 of 1" for a long document would be a lie.
            <span className="text-[12px] text-text-muted whitespace-nowrap"
              title="Word decides the page breaks when it opens the file; this preview shows the document as one flow.">
              Continuous
            </span>
          ) : (
            <span className="text-[12px] text-text-muted whitespace-nowrap">
              Page <span className="font-mono tnum text-text">{page}</span> of{' '}
              <span className="font-mono tnum">{pageCount || '–'}</span>
            </span>
          )}
          <IconBtn onClick={() => goToPage(page + 1)} title="Next page" disabled={page >= pageCount}><ChevronRight size={14} /></IconBtn>
        </div>

        <div className="flex items-center gap-1.5 ml-auto">
          <div className="relative">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-faint" />
            <input
              className="input !h-8 !w-52 !pl-7 text-[12px]"
              placeholder="Find in document"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') stepHit(e.shiftKey ? -1 : 1); }}
            />
            {query && (
              <button className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-faint hover:text-text"
                onClick={() => setQuery('')} aria-label="Clear search"><X size={13} /></button>
            )}
          </div>
          {query.trim().length >= 2 && (
            <span className="text-[11px] text-text-muted tnum whitespace-nowrap">
              {hits.length ? `${hitIndex + 1} / ${hits.length}` : 'no matches'}
            </span>
          )}
          <IconBtn onClick={() => stepHit(-1)} title="Previous match" disabled={!hits.length}><ChevronLeft size={14} /></IconBtn>
          <IconBtn onClick={() => stepHit(1)} title="Next match" disabled={!hits.length}><ChevronRight size={14} /></IconBtn>
          <button className={chip(showPicker)} onClick={() => setShowPicker((v) => !v)} title="Choose what goes in">
            <SlidersHorizontal size={12} /> Contents
          </button>
        </div>
      </div>

      {/* min-h-0 is what lets the panes scroll instead of stretching the column. */}
      <div className="flex flex-1 min-h-0">
        {/* Left rail: page thumbnails when the document has pages, an outline when it does
            not. A continuous Word document rendered as a single "thumbnail" is a squashed
            ribbon of the whole file — unreadable and unclickable; its headings are not. */}
        <aside className={`shrink-0 border-r border-hairline overflow-y-auto bg-bg-elev p-2 dg-doc-chrome ${
          continuous ? 'w-[184px] space-y-1' : 'w-[132px] space-y-2'}`}>
          {continuous ? (
            <>
              <div className="eyebrow px-1 pb-1">Outline</div>
              {outline.length === 0 && (
                <p className="text-[11px] text-text-faint px-1">This document has no headings.</p>
              )}
              {outline.map((o) => (
                <button
                  key={o.key}
                  onClick={() => o.el.scrollIntoView({ block: 'start', behavior: 'smooth' })}
                  title={`Jump to “${o.title}”`}
                  className="block w-full text-left px-2 py-1.5 rounded-sm text-[12px] text-text-muted hover:text-text hover:bg-surface-2 truncate"
                >
                  {o.title}
                </button>
              ))}
              <p className="text-[10px] text-text-faint px-1 pt-2 leading-snug">
                Word decides the page breaks when it opens the file, so there are no pages to
                show here yet.
              </p>
            </>
          ) : (
            <>
              {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  onClick={() => goToPage(n)}
                  className={`block w-full rounded border overflow-hidden transition-colors ${
                    n === page ? 'border-azure' : 'border-hairline hover:border-hairline-strong'}`}
                  title={`Page ${n}`}
                >
                  {thumbs[n - 1]
                    ? <img src={thumbs[n - 1]} alt={`Page ${n}`} className="w-full block bg-white" />
                    : <DocxThumbnail pagesRef={pagesRef} page={n} nonce={renderNonce} />}
                  <span className="block text-[10px] text-text-faint py-0.5">{n}</span>
                </button>
              ))}
              {pageCount === 0 && <p className="text-[11px] text-text-faint px-1">No pages yet.</p>}
              {format === 'docx' && pageCount > 0 && (
                <p className="text-[10px] text-text-faint px-1 pt-1 leading-snug">
                  Approximate pages — the file carries no breaks of its own, so Word may move a
                  line or two when it opens it.
                </p>
              )}
            </>
          )}
        </aside>

        {/* Pages */}
        <div ref={scrollRef} className="flex-1 min-w-0 overflow-auto bg-[#2A3242] p-6 dg-doc-scroll">
          {busy && (
            <div className="h-full grid place-items-center text-text-muted text-sm">
              <span className="inline-flex items-center gap-2">
                <Loader2 size={16} className="animate-spin" /> Building the {format === 'pdf' ? 'PDF' : 'Word document'}…
              </span>
            </div>
          )}
          {error && !busy && <div className="h-full grid place-items-center text-loss text-sm">{error}</div>}
          <div
            className="origin-top mx-auto w-fit"
            style={{ transform: `scale(${zoom})`, display: busy || error ? 'none' : undefined }}
          >
            <div ref={pagesRef} className="dg-doc-pages" />
          </div>
          {/* docx-preview writes the document's own stylesheet here, scoped to the pages. */}
          <div ref={styleRef} className="hidden" />
        </div>

        {/* Content picker */}
        {showPicker && (
          <aside className="w-[260px] shrink-0 border-l border-hairline overflow-y-auto p-3 dg-doc-chrome">
            <div className="eyebrow mb-2">What goes in the document</div>
            <div className="space-y-1.5">
              {doc.blocks.map((b) => {
                const on = !excluded.has(b.id);
                return (
                  <label key={b.id}
                    className="flex items-start gap-2 p-2 rounded hover:bg-surface-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-azure"
                      checked={on}
                      onChange={() => setExcluded((prev) => {
                        const next = new Set(prev);
                        if (on) next.add(b.id); else next.delete(b.id);
                        return next;
                      })}
                    />
                    <span className="min-w-0">
                      <span className="block text-[13px] text-text truncate">{blockLabel(b)}</span>
                      <span className="block text-[11px] text-text-faint">{blockDetail(b)}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            {include.size === 0 && (
              <p className="text-[11px] text-warn mt-3">
                Everything is switched off — the document will hold only its title and the disclaimer.
              </p>
            )}
            <p className="text-[11px] text-text-faint mt-3">
              Changes rebuild the document, so the preview always shows the real result.
            </p>
          </aside>
        )}
      </div>
      </div>
    </Modal>
  );
}

/**
 * Thumbnail for a Word page. docx-preview leaves the page as live DOM, so the rail shows a
 * scaled clone of the real thing rather than a blank placeholder — and cloning costs nothing
 * next to a second render pass. The clone is stripped of the page marker so neither the
 * search walker nor the page-scroll query can ever find it.
 */
function DocxThumbnail({ pagesRef, page, nonce }: {
  pagesRef: React.RefObject<HTMLDivElement | null>; page: number; nonce: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const src = pagesRef.current?.querySelector<HTMLElement>(`.${PAGE_CLASS}[data-page="${page}"]`);
    const host = hostRef.current;
    if (!src || !host || !host.clientWidth || !src.offsetWidth) return;
    const clone = src.cloneNode(true) as HTMLElement;
    clone.removeAttribute('data-page');
    clone.classList.remove(PAGE_CLASS);
    clone.style.boxShadow = 'none';

    // docx-preview scopes the document's own stylesheet to `.docx-wrapper`. A clone lifted
    // out of that ancestor loses every one of those rules and silently falls back to browser
    // defaults — which is why the thumbnail showed centred text beside a left-aligned page.
    // Rebuilding the wrapper around it restores the exact appearance of the real page.
    const wrapper = document.createElement('div');
    wrapper.className = 'docx-wrapper dg-doc-thumb';
    wrapper.appendChild(clone);

    const scale = host.clientWidth / src.offsetWidth;
    wrapper.style.transform = `scale(${scale})`;
    wrapper.style.transformOrigin = '0 0';
    host.replaceChildren(wrapper);
    host.style.height = `${src.offsetHeight * scale}px`;
    return () => host.replaceChildren();
  }, [pagesRef, page, nonce]);
  return <div ref={hostRef} className="w-full overflow-hidden bg-white" />;
}

function FormatTab({ active, onClick, icon: Icon, label }: {
  active: boolean; onClick: () => void; icon: typeof FileText; label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sm text-[12px] font-medium transition-colors ${
        active ? 'bg-azure text-bg' : 'text-text-muted hover:text-text'}`}
    >
      <Icon size={13} /> {label}
    </button>
  );
}

function IconBtn({ children, onClick, title, disabled }: {
  children: React.ReactNode; onClick: () => void; title: string; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className="inline-flex items-center justify-center w-7 h-7 rounded-sm bg-surface-2 border border-hairline text-text-muted hover:text-text hover:border-hairline-strong disabled:opacity-35 disabled:pointer-events-none"
    >
      {children}
    </button>
  );
}

function chip(active: boolean): string {
  return `inline-flex items-center gap-1 h-7 px-2 rounded-sm border text-[12px] transition-colors ${
    active
      ? 'border-azure/50 text-text bg-surface-2'
      : 'border-hairline text-text-muted hover:text-text hover:border-hairline-strong'}`;
}
