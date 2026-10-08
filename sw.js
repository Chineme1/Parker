// sw.js — enough of a service worker to make the app installable and to let it
// open instantly. Deliberately does NOT cache Overpass, Nominatim or tiles:
// stale lot data is worse than no lot data.

const VERSION = 'parker-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './geo.js',
  './parking.js',
  './providers.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return; // tiles and APIs go straight to network

  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        }),
    ),
  );
});
