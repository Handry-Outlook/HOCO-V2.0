// HOCO v3 service worker: makes the app installable and lets the page open offline.
// Network first for our own files (so updates show straight away), cache as the fallback.
// Forecast data, maps, radar and sign-in always go to the network and are never cached here.
const CACHE = 'hoco-v3-shell-14';
const SHELL = ['./', './index.html', './styles.css', './severity.js', './export.js', './gif-encoder.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './privacy.html'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || !u.pathname.includes('/v3/')) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(u.origin + u.pathname, copy)).catch(() => {}); }
    return r;
  }).catch(() => caches.match(u.origin + u.pathname).then(m => m || caches.match('./'))));
});
