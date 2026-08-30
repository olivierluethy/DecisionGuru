import { useEffect, useState, type RefObject } from 'react';
import clsx from 'clsx';
import type { NavSection } from './SectionNav';

/**
 * Vertical, always-visible section rail for a dense modal. Where the page-level
 * `SectionNav` is a horizontal top rail keyed to the window, this one spies within a
 * specific scroll container — the modal body — so a first-time reader can see every
 * chapter at once and jump between them with a single click. It highlights whichever
 * section is nearest the top; clicking scrolls to it (the sections carry `scroll-mt`).
 *
 * On narrow widths the rail collapses to icons only, keeping navigation within reach
 * without stealing the content's horizontal room.
 */
export function ModalSectionRail({
  sections,
  scrollRef,
  label = 'On this page',
}: {
  sections: NavSection[];
  scrollRef: RefObject<HTMLElement | null>;
  label?: string;
}) {
  const [active, setActive] = useState(sections[0]?.id ?? '');
  const ids = sections.map((s) => s.id).join(',');

  useEffect(() => {
    const root = scrollRef.current;
    const els = sections
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => !!el);
    if (els.length === 0) return;

    // A section is "active" once its top crosses into the top third of the modal body.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { root: root ?? null, rootMargin: '-8px 0px -68% 0px', threshold: 0 },
    );
    els.forEach((el) => observer.observe(el));

    // Pin the final section active once the body is scrolled to the bottom — a short last
    // section's top may never cross the activation line, so the observer alone can't reach it.
    const onScroll = () => {
      if (!root) return;
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) {
        setActive(sections[sections.length - 1].id);
      }
    };
    root?.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      observer.disconnect();
      root?.removeEventListener('scroll', onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, scrollRef]);

  const go = (id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    setActive(id);
  };

  if (sections.length < 2) return null;

  return (
    <nav
      aria-label={label}
      className="sticky top-0 self-start shrink-0 z-10 w-14 sm:w-52 max-h-[70vh] overflow-y-auto no-scrollbar border-r border-hairline bg-surface/40 backdrop-blur-sm px-2 sm:px-3 py-4"
    >
      <div className="eyebrow px-2 mb-2 hidden sm:block">{label}</div>
      <ul className="space-y-1">
        {sections.map((s) => {
          const on = active === s.id;
          const Icon = s.icon;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => go(s.id)}
                aria-current={on ? 'true' : undefined}
                title={s.label}
                className={clsx(
                  'flex w-full items-center justify-center sm:justify-start gap-2.5 rounded-md px-0 sm:px-2.5 h-9 text-[13px] text-left transition-colors',
                  on
                    ? 'bg-azure/12 text-azure ring-1 ring-inset ring-azure/25'
                    : 'text-text-muted hover:text-text hover:bg-surface-2',
                )}
              >
                {Icon && <Icon size={16} className="shrink-0" />}
                <span className="truncate hidden sm:block">{s.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
