/**
 * PWA plumbing — service-worker registration and the deferred install prompt.
 *
 * Installability has three requirements a browser checks: a manifest with `id`,
 * `start_url`, `display` and 192/512 icons (see `public/site.webmanifest`), a secure origin
 * (https, or localhost during development), and a controlling service worker with a fetch
 * handler (`public/sw.js`). The worker is registered in dev too — otherwise the app could
 * never be installed from `npm run dev` — but the `prod` flag tells it to keep its hands off
 * every request there, so Vite's HMR is untouched.
 *
 * `beforeinstallprompt` fires once, before the browser would show its own UI; the event has
 * to be captured at load or it is gone. It is stored here and replayed when the reader hits
 * the install button.
 */

/** The non-standard event Chromium fires when the app qualifies for installation. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<(available: boolean) => void>();

function emit() {
  for (const fn of listeners) fn(deferred != null);
}

/** Subscribe to "can the app be installed right now?". Returns an unsubscribe function. */
export function onInstallAvailability(fn: (available: boolean) => void): () => void {
  listeners.add(fn);
  fn(deferred != null);
  return () => listeners.delete(fn);
}

export function canInstall(): boolean {
  return deferred != null;
}

/** True when the app is already running as an installed window — no prompt is offered then. */
export function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches
    || (navigator as { standalone?: boolean }).standalone === true;
}

/** Replay the captured prompt. Resolves to whether the reader accepted. */
export async function promptInstall(): Promise<boolean> {
  const evt = deferred;
  if (!evt) return false;
  // A captured prompt is single-use: clear it before awaiting so a double click can't
  // replay a consumed event (which throws).
  deferred = null;
  emit();
  try {
    await evt.prompt();
    const { outcome } = await evt.userChoice;
    return outcome === 'accepted';
  } catch {
    return false;
  }
}

export function initPwa(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Suppress the browser's own mini-infobar so the app's button is the single entry point.
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    emit();
  });

  if (!('serviceWorker' in navigator)) return;
  const version = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? '0.3.0';
  const prod = import.meta.env.PROD ? '1' : '0';
  // Registered after load so it never competes with the first paint for bandwidth.
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`/sw.js?v=${encodeURIComponent(version)}&prod=${prod}`, { scope: '/' })
      .catch(() => undefined);  // an unavailable worker must never break the app
  });
}
