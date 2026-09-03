/**
 * Scroll to a section that may not be mounted yet.
 *
 * Jumping from one view to another (Decisions → a position) switches the store first and
 * renders on the next frame, so the anchor does not exist at click time. A fixed timeout
 * would be a guess; this polls on animation frames until the element appears, then gives up
 * silently rather than leaving the reader at an arbitrary scroll offset.
 *
 * The URL hash is owned by the router (it encodes the view), so it is deliberately not used
 * for anchors here.
 */
export function scrollToSectionWhenReady(id: string, timeoutMs = 2000): void {
  const deadline = performance.now() + timeoutMs;
  const tick = () => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (performance.now() < deadline) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
