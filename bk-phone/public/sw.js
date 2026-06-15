// ===========================================================================
// bk-phone / sw.js  —  service worker
// ---------------------------------------------------------------------------
// Makes the app load instantly and keep working with a flaky signal by caching
// the "shell" (styles, scripts, icons). Live data (conversations, messages) is
// always fetched fresh from the network; only the static shell is cached.
// Bump CACHE when shell files change to retire the old cache.
// ===========================================================================

const CACHE = 'bkphone-v1';

// Public, non-sensitive assets only. We never pre-cache pages or API responses
// (those can contain customer data and require a login).
const SHELL = [
  '/css/app.css',
  '/css/settings.css',
  '/js/app.js',
  '/js/threads.js',
  '/js/thread.js',
  '/js/settings.js',
  '/icons/icon-192.png',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never touch sends/logins

  const url = new URL(req.url);

  // Pages + API: network-first so data is always fresh; fall back if offline.
  if (req.mode === 'navigate' || url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // Static shell assets: cache-first for instant loads.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((resp) => {
      if (resp.ok && url.origin === self.location.origin) {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return resp;
    }).catch(() => cached))
  );
});
