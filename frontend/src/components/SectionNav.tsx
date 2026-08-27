import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

export interface NavSection {
  id: string;
  label: string;
}

// Height (px) to leave clear above a target section so it isn't hidden under the
// sticky rail after a jump.
const SCROLL_OFFSET = 84;

/** Nearest scrollable ancestor, or null to fall back to the window. */
function getScrollParent(node: HTMLElement | null): HTMLElement | null {
  let el = node?.parentElement ?? null;
  while (el) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return null;
}

/**
 * Sticky "on this page" rail with scroll-spy. Gives a long detail view a table of
 * contents so a first-time viewer sees every chapter at a glance and can jump between
 * them without scrolling. Highlights the section currently in view; clicking a pill
 * scrolls to it inside the real scroll container (computed, not scrollIntoView — a
 * sticky element's scrollIntoView snaps the page back to its unstuck position).
 */
export function SectionNav({ sections }: { sections: NavSection[] }) {
  const [active, setActive] = useState(sections[0]?.id ?? '');
  const navRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const pillRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const ids = sections.map((s) => s.id).join(',');

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

  // Keep the active pill in view by nudging ONLY the rail's horizontal scroll — never
  // scrollIntoView, which would also move the vertical page scroll.
  useEffect(() => {
    const pill = pillRefs.current[active];
    const rail = railRef.current;
    if (!pill || !rail) return;
    const pr = pill.getBoundingClientRect();
    const rr = rail.getBoundingClientRect();
    rail.scrollLeft += pr.left - rr.left - (rr.width / 2 - pr.width / 2);
  }, [active]);

  const go = (id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    const behavior: ScrollBehavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth';
    const container = getScrollParent(navRef.current);
    if (container) {
      const top =
        target.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop -
        SCROLL_OFFSET;
      container.scrollTo({ top, behavior });
    } else {
      const top = target.getBoundingClientRect().top + window.scrollY - SCROLL_OFFSET;
      window.scrollTo({ top, behavior });
    }
    setActive(id);
  };

  if (sections.length < 2) return null;

  return (
    <nav
      ref={navRef}
      aria-label="On this page"
      className="sticky top-0 z-20 -mx-6 mb-6 px-6 py-2.5 bg-bg/85 backdrop-blur-md border-b border-hairline"
    >
      <div className="flex items-center gap-2">
        <span className="eyebrow shrink-0 hidden sm:block">On this page</span>
        <div ref={railRef} className="flex items-center gap-1 overflow-x-auto no-scrollbar">
          {sections.map((s) => {
            const on = active === s.id;
            return (
              <button
                key={s.id}
                ref={(el) => {
                  pillRefs.current[s.id] = el;
                }}
                onClick={() => go(s.id)}
                aria-current={on ? 'true' : undefined}
                className={clsx(
                  'px-3 h-8 rounded-full text-[13px] whitespace-nowrap transition-colors',
                  on
                    ? 'bg-azure/12 text-azure ring-1 ring-inset ring-azure/30'
                    : 'text-text-muted hover:text-text hover:bg-surface-2',
                )}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
