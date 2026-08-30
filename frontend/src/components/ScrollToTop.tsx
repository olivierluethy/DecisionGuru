import { useEffect, useState, type RefObject } from 'react';
import { ArrowUp } from 'lucide-react';
import clsx from 'clsx';

/**
 * Floating "back to top" control for the whole app. Once the main content has scrolled past
 * roughly a screenful, a button fades in at the bottom-right; clicking it returns the view to
 * the top so a long page never has to be scrolled back by hand (reduced-motion is respected).
 *
 * The page scrolls inside the app's own <main> container, not the window, so the button is
 * bound to that element's scroll rather than the global one.
 */
export function ScrollToTop({
  scrollRef,
  threshold = 400,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  threshold?: number;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      setVisible(el.scrollTop > threshold);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [scrollRef, threshold]);

  const toTop = () => {
    const el = scrollRef.current;
    if (!el) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  };

  return (
    <button
      type="button"
      onClick={toTop}
      aria-label="Back to top"
      title="Back to top"
      tabIndex={visible ? 0 : -1}
      aria-hidden={!visible}
      className={clsx(
        'fixed bottom-6 right-6 z-40 grid place-items-center w-11 h-11 rounded-full',
        'bg-surface-2/90 backdrop-blur border border-hairline-strong text-text-muted shadow-modal',
        'hover:text-text hover:border-azure/50 hover:bg-surface-2 hover:shadow-glow-azure',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-azure/50 focus-visible:ring-offset-0',
        'transition-all duration-200 ease-out motion-reduce:transition-none',
        visible
          ? 'opacity-100 translate-y-0 pointer-events-auto'
          : 'opacity-0 translate-y-3 pointer-events-none',
      )}
    >
      <ArrowUp size={18} />
    </button>
  );
}
