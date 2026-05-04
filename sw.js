// NEXUS v2 — Service Worker
// Enables PWA install on Android Chrome (Add to Home Screen)
// Caches core assets for fast load on local network

const CACHE = 'nexus-v2-cache';
const CORE = [
  '/',
  '/index.html',
  '/css/nexus.css',
  '/js/nexus.js',
  '/manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Never cache API calls or WebSocket upgrades
  if (url.pathname.startsWith('/api/') || e.request.headers.get('upgrade') === 'websocket') {
    return e.respondWith(fetch(e.request));
  }
  // Network first, fall back to cache for app shell
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        const clone = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
