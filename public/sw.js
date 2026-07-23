/* Tracker Porti — service worker.
 *
 * Goal: make the app installable + fast to open, WITHOUT ever caching live or
 * authenticated data. Strategy:
 *   • /api/*           → not intercepted (always network; never cached).
 *   • cross-origin     → not intercepted (OSM/OpenSeaMap map tiles).
 *   • navigations      → network-first, fall back to the cached shell/offline
 *                        page when the network is unavailable (never caches the
 *                        response, so a login redirect can't poison the shell).
 *   • app code (/js/, /locales/, *.js) → network-first, so a deploy never serves
 *                        a MIX of old + new ES modules (a fresh module importing a
 *                        symbol absent from a stale sibling breaks the whole app);
 *                        falls back to cache offline.
 *   • other same-origin GET → stale-while-revalidate (CSS, icons, manifest) so the
 *                        app opens offline.
 *
 * Bump CACHE to invalidate everything on the next visit.
 */
const CACHE = 'tp-shell-v14';
const PRECACHE = [
  '/',
  '/index.html',
  '/offline.html',
  '/css/style.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  // Self-hosted Leaflet (was a CDN dependency): precache so the map works offline.
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/leaflet.css',
  '/vendor/leaflet/images/marker-icon.png',
  '/vendor/leaflet/images/marker-icon-2x.png',
  '/vendor/leaflet/images/marker-shadow.png',
  '/vendor/leaflet/images/layers.png',
  '/vendor/leaflet/images/layers-2x.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Add individually so one failure can't abort the whole install.
      await Promise.allSettled(PRECACHE.map((u) => cache.add(u)));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never touch writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // CDN/tiles → network
  if (url.pathname.startsWith('/api')) return; // live/auth data → network only

  // Navigations: network-first, fall back to the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match(req)) ||
            (await cache.match('/index.html')) ||
            (await cache.match('/offline.html')) ||
            Response.error()
          );
        }
      })()
    );
    return;
  }

  // App code (ES modules + locales): network-first to avoid mixing module versions
  // across a deploy. Cache the fresh copy for offline; fall back to it when offline.
  if (url.pathname.startsWith('/js/') || url.pathname.startsWith('/locales/') || url.pathname.endsWith('.js')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await fetch(req);
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        } catch {
          return (await cache.match(req)) || (await cache.match('/offline.html')) || Response.error();
        }
      })()
    );
    return;
  }

  // Other static assets (CSS, icons, manifest): stale-while-revalidate.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          // Only cache OK, basic (same-origin, non-redirect) responses.
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      return cached || (await network) || (await cache.match('/offline.html')) || Response.error();
    })()
  );
});
