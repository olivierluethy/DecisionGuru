/* DecisionGuru service worker.
 *
 * Its first job is installability: a browser only offers "Install app" for a page that
 * controls a service worker with a fetch handler. Its second is that an installed window
 * opens instantly and still paints when the network is gone.
 *
 * Two hard rules:
 *   1. `/api` is NEVER cached. All portfolio data is local and authoritative in the backend's
 *      SQLite file; a stale cached response would show numbers that are quietly wrong.
 *   2. Caching is enabled only when the registration says so (`?prod=1`, set from
 *      `import.meta.env.PROD`). Under `vite dev` the worker is a pure pass-through, so it
 *      cannot intercept module requests or fight HMR — it is there purely to make the app
 *      installable from the dev server too.
 *
 * The cache name carries the app version, so a new release drops the old one on activate.
 */
const PARAMS = new URL(self.location.href).searchParams;
const CACHING = PARAMS.get('prod') === '1';
const VERSION = PARAMS.get('v') || 'dev';
const CACHE = `decisionguru-${VERSION}`;
const SHELL = '/index.html';

// Content-hashed build output and the static icon/manifest set — safe to serve from cache
// first, because a changed file arrives under a different URL.
const isImmutable = (url) =>
  url.pathname.startsWith('/assets/') ||
  /^\/(favicon\.(ico|svg)|apple-touch-icon\.png|icon-\d+(-maskable)?\.png|site\.webmanifest)$/.test(url.pathname);

self.addEventListener('install', (event) => {
  // Take over as soon as the new worker is ready rather than waiting for every tab to close,
  // so an update never leaves a half-old shell in place.
  self.skipWaiting();
  if (!CACHING) return;
  event.waitUntil(caches.open(CACHE).then((c) => c.add(SHELL)).catch(() => undefined));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith('decisionguru-') && n !== CACHE).map((n) => caches.delete(n)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!CACHING || req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api')) return;  // rule 1 — local data is never cached

  // Navigations: network first so a rebuilt shell is picked up immediately, cached copy as
  // the offline fallback.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(SHELL, fresh.clone());
        return fresh;
      } catch {
        return (await caches.match(SHELL)) || Response.error();
      }
    })());
    return;
  }

  // Hashed assets: cache first, populate on miss.
  if (isImmutable(url)) {
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const fresh = await fetch(req);
      if (fresh.ok) (await caches.open(CACHE)).put(req, fresh.clone());
      return fresh;
    })());
  }
});
