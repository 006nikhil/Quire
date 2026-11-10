// Quire service worker.
// App code (html, css, js) is fetched fresh from the network first, so updates arrive on the next
// launch; the cached copy is used when offline or when the network is slow. Large libraries and
// icons rarely change, so those are served from the cache.
const VERSION = 'quire-v9';
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
  "vendor/pdf.worker.min.js"
];
self.addEventListener('install', (e) => {
  // cache: 'reload' skips Safari's short-term HTTP cache, so a new version never stores old files
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== 'quire-fonts').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]); }
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    e.respondWith(caches.open('quire-fonts').then(async (c) => {
      const hit = await c.match(e.request); if (hit) return hit;
      try { const r = await fetch(e.request); if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; } catch (err) { return Response.error(); }
    }));
    return;
  }
  if (url.origin !== location.origin) return; // Supabase etc. go straight to the network
  const stable = /\/(vendor|icons)\//.test(url.pathname);
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    if (stable && hit) return hit;
    try {
      const r = await withTimeout(fetch(e.request, { cache: 'no-cache' }), hit ? 3500 : 20000);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch (err) {
      return hit || (await c.match('./index.html')) || Response.error();
    }
  }));
});
