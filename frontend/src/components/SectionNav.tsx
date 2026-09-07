import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { ChevronDown, type LucideIcon } from 'lucide-react';
import type { ExchangeStatus } from '../lib/api';
import { MarketStatusChip } from './MarketStatusChip';
import { KindBadge } from './ui';

export interface NavSection {
  id: string;
  label: string;
  icon?: LucideIcon;
}

/**
 * Compact asset identity shown in the sticky rail once the large header scrolls away.
 * Everything here is already loaded by the detail view — no extra fetch. `price` is
 * pre-formatted by the caller so the sticky bar keeps that view's exact currency /
 * precision / fallback semantics; `hours` drives the same live MarketStatusChip the
 * header uses. A closed/delisted asset simply omits price and hours (identity only).
 */
export interface AssetContext {
  symbol: string;
  name?: string | null;
  kind: string;
  price?: ReactNode;
  hours?: ExchangeStatus | null;
}

/** Nearest scrollable ancestor (the `<main>` scroll container), or null for the viewport. */
function getScrollParent(node: HTMLElement | null): HTMLElement | null {
  let el = node?.parentElement ?? null;
  while (el) {
    const oy = getComputedStyle(el).overflowY;
    if (oy === 'auto' || oy === 'scroll') return el;
    el = el.parentElement;
  }
  return null;
}

/**
 * Sticky "on this page" rail with scroll-spy. Gives a long detail view a table of
 * contents so a first-time viewer sees every chapter at a glance and can jump between
 * them without scrolling. Highlights the section currently in view; clicking a pill
 * scrolls to it via the target's own scrollIntoView, which reliably resolves the real
 * scroll container in either direction (the sections carry scroll-mt to clear the rail).
 *
 * The rail is adaptive so every chapter is discoverable without side-scrolling: while it
 * sits at the top of the page (the arrival state) the pills wrap onto as many rows as it
 * takes, so the whole table of contents is visible at once. Once the reader scrolls into
 * the content and the rail pins to the top, it collapses to a single space-saving row
 * (active pill auto-centered) with a chevron to re-expand the full grid on demand — so a
 * tall wrapped block never eats the viewport while reading, worst-case on mobile.
 *
 * When an `asset` is supplied, the rail also carries a Spotify-style compact asset
 * context (name · ticker · price · live market status) that fades/slides in the moment
 * the rail pins to the top — i.e. once the large header has scrolled out of view — so the
 * reader always knows which asset they're looking at. Only ever one asset header visible.
 */
export function SectionNav({ sections, asset }: { sections: NavSection[]; asset?: AssetContext }) {
  const [active, setActive] = useState(sections[0]?.id ?? '');
  const [stuck, setStuck] = useState(false);
  // Manual override to re-open the full wrapped grid while the rail is pinned. Reset the
  // moment the rail unpins (scrolls back to the top) so the chevron state stays honest.
  const [userOpen, setUserOpen] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const pillRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const railId = useId();
  const ids = sections.map((s) => s.id).join(',');
  // Wrapped (every section visible) at the top of the page, or when explicitly re-opened;
  // collapsed to a single scrolling row once pinned to reclaim vertical space.
  const expanded = !stuck || userOpen;

  // Scroll-spy: a section is "active" once its top crosses ~45% down the viewport.
  useEffect(() => {
    const els = sections
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => !!el);
    if (els.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-72px 0px -55% 0px', threshold: 0 },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  // Track when the rail pins to the top — i.e. once the large header has scrolled out of
  // view. Detected by comparing the sticky rail's own top to the top of its scroll
  // container: while pinned they coincide. This is layout-agnostic (works whether the
  // container top is the viewport top on desktop or sits below the app bar on mobile, and
  // regardless of flex/block flow around the rail) and adds no DOM. Drives BOTH the
  // wrapped→row collapse and the compact asset context reveal, so it always runs — even
  // on views without an asset (e.g. the dashboard).
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const scroller = getScrollParent(nav);
    const target: HTMLElement | Window = scroller ?? window;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rootTop = scroller ? scroller.getBoundingClientRect().top : 0;
      const isStuck = nav.getBoundingClientRect().top <= rootTop + 0.5;
      setStuck(isStuck);
      // Back at the top: the full grid shows again, so drop any manual re-open.
      if (!isStuck) setUserOpen(false);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    target.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      target.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  // Keep the active pill in view by nudging ONLY the rail's horizontal scroll — never
  // scrollIntoView, which would also move (and fight) the vertical page scroll. Only
  // meaningful in the collapsed single-row state; the wrapped grid has no side-scroll.
  useEffect(() => {
    if (expanded) return;
    const pill = pillRefs.current[active];
    const rail = railRef.current;
    if (!pill || !rail) return;
    const pr = pill.getBoundingClientRect();
    const rr = rail.getBoundingClientRect();
    rail.scrollLeft += pr.left - rr.left - (rr.width / 2 - pr.width / 2);
  }, [active, expanded]);

  const go = (id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    setActive(id);
    // Picking a section from the re-opened grid returns to the compact row.
    setUserOpen(false);
  };

  if (sections.length < 2) return null;

  const displayName = asset?.name?.trim() || null;

  return (
    <nav
      ref={navRef}
      aria-label="On this page"
      className="sticky top-0 z-20 -mx-6 mb-6 px-6 bg-bg/85 backdrop-blur-md border-b border-hairline"
    >
        {asset && (
          <div
            className={clsx(
              'grid overflow-hidden transition-all duration-200 ease-out motion-reduce:transition-none',
              stuck ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0 pointer-events-none',
            )}
            aria-hidden={!stuck}
          >
            <div className="min-h-0">
              <div
                className={clsx(
                  'flex items-center gap-2.5 pt-2.5 pb-2 border-b border-hairline/70 transition-transform duration-200 ease-out motion-reduce:transition-none',
                  stuck ? 'translate-y-0' : '-translate-y-1',
                )}
              >
                <KindBadge kind={asset.kind} />
                <span
                  className="min-w-0 truncate font-medium text-text text-[14px]"
                  title={displayName ?? asset.symbol}
                >
                  {displayName ?? asset.symbol}
                </span>
                {displayName && (
                  <>
                    <span className="text-text-faint shrink-0" aria-hidden>·</span>
                    <span className="font-mono text-[13px] text-text-muted shrink-0">{asset.symbol}</span>
                  </>
                )}
                {asset.price != null && (
                  <span className="font-mono text-[13px] text-text tnum shrink-0">{asset.price}</span>
                )}
                {asset.hours && (
                  <span className="ml-auto shrink-0">
                    <MarketStatusChip hours={asset.hours} />
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        <div className={clsx('flex gap-2 py-2.5', expanded ? 'items-start' : 'items-center')}>
          <span className={clsx('eyebrow shrink-0 hidden sm:block', expanded && 'pt-2')}>
            On this page
          </span>
          <div
            ref={railRef}
            id={railId}
            className={clsx(
              'flex gap-1',
              expanded ? 'flex-wrap' : 'items-center overflow-x-auto no-scrollbar',
            )}
          >
            {sections.map((s) => {
              const on = active === s.id;
              const Icon = s.icon;
              return (
                <button
                  key={s.id}
                  ref={(el) => {
                    pillRefs.current[s.id] = el;
                  }}
                  onClick={() => go(s.id)}
                  aria-current={on ? 'true' : undefined}
                  className={clsx(
                    'inline-flex items-center gap-1.5 px-3 h-8 rounded-full text-[13px] whitespace-nowrap transition-colors',
                    on
                      ? 'bg-azure/12 text-azure ring-1 ring-inset ring-azure/30'
                      : 'text-text-muted hover:text-text hover:bg-surface-2',
                  )}
                >
                  {/* Inherit the pill's currentColor so the icon is exactly as legible as
                      its label (azure when active, muted otherwise). */}
                  {Icon && <Icon size={15} className="shrink-0" />}
                  {s.label}
                </button>
              );
            })}
          </div>
          {/* Only offered once pinned: at the top the full grid is already showing. Toggles
              the wrapped grid back open without leaving the reader's scroll position. */}
          {stuck && (
            <button
              type="button"
              onClick={() => setUserOpen((o) => !o)}
              aria-expanded={expanded}
              aria-controls={railId}
              aria-label={expanded ? 'Collapse section list' : 'Show all sections'}
              className="shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-full text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
            >
              <ChevronDown
                size={16}
                className={clsx('transition-transform motion-reduce:transition-none', expanded && 'rotate-180')}
              />
            </button>
          )}
        </div>
      </nav>
  );
}
