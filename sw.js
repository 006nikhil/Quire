// Quire service worker: the whole app works offline once installed.
const VERSION = 'quire-v1';
const ASSETS = [
  "./",
  "css/app.css",
  "icons/apple-touch-icon.png",
  "icons/icon-1024.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "index.html",
  "js/app.js",
  "js/comic.js",
  "js/convert.js",
  "js/db.js",
  "js/marginalia.js",
  "js/reader.js",
  "js/source.js",
  "js/util.js",
  "manifest.webmanifest",
  "vendor/epub.min.js",
  "vendor/jszip.min.js",
  "vendor/libarchive/libarchive.js",
  "vendor/libarchive/libarchive.wasm",
  "vendor/libarchive/worker-bundle.js",
  "vendor/mammoth.browser.min.js",
  "vendor/pdf.min.js",
  "vendor/pdf.worker.min.js",
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== 'quire-fonts').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Google Fonts: cache on first use
  if (url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    e.respondWith(caches.open('quire-fonts').then(async (c) => {
      const hit = await c.match(e.request); if (hit) return hit;
      try { const r = await fetch(e.request); if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; } catch (err) { return hit || Response.error(); }
    }));
    return;
  }
  if (url.origin !== location.origin) return; // Supabase etc. always go to the network
  // serve from cache instantly, refresh the cached copy in the background
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || (await c.match('./index.html')) || Response.error();
  }));
});
