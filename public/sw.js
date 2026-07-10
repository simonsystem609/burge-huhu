'use strict';

/* Service worker: makes the app installable and playable-looking offline.
 * Strategy: network-first for every same-origin GET (so deploys are picked
 * up immediately), falling back to the cache when offline. The socket.io
 * endpoint is never touched. */

const CACHE = 'burge-v1';
const PRECACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/client.js',
  '/i18n.js',
  '/cards.js',
  '/manifest.webmanifest',
  '/ur/',
  '/ur/index.html',
  '/ur/style.css',
  '/ur/client.js',
  '/ur/board-source.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/socket.io')) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: url.pathname === '/' }))
  );
});
