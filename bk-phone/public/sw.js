// ===========================================================================
// bk-phone / sw.js  —  service worker
// ---------------------------------------------------------------------------
// Makes the app load instantly and keep working with a flaky signal by caching
// the "shell" (styles, scripts, icons). Live data (conversations, messages) is
// always fetched fresh from the network; only the static shell is cached.
// Bump CACHE when shell files change to retire the old cache.
// ===========================================================================

const CACHE = 'bkphone-v2';

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

  // Same-origin (our pages, API, scripts, styles): NETWORK-FIRST so the app
  // always runs the latest deployed code; fall back to cache only when offline.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req).then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return resp;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Cross-origin assets (e.g. Google Fonts): cache-first for speed.
  event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});

// ---- Push notifications ---------------------------------------------------
// Show a notification when a new text arrives (even with the app closed).
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* ignore */ }
  const title = data.title || 'New message';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.threadId ? ('thread-' + data.threadId) : undefined,
    data: { url: data.threadId ? ('/thread/' + data.threadId) : '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping a notification opens (or focuses) that conversation.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const c of wins) {
        if ('focus' in c) { c.navigate(url); return c.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
