const CACHE_NAME = 'japan-v2-shell-8';

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

const DATA_ASSETS = [
  './data/meta.json',
  './data/days.json',
  './data/places.json',
  './data/food.json',
  './data/phrases.json',
  './data/sos.json'
];

const ALL_ASSETS = SHELL_ASSETS.concat(DATA_ASSETS);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ALL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(key => key !== CACHE_NAME)
        .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Network-only for weather API
  if (url.includes('api.open-meteo.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Cache-first for everything else
  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request).then(response => {
        // Cache same-origin GETs on first load (e.g. reservation PDFs added later)
        if (response.ok && event.request.method === 'GET' &&
            new URL(event.request.url).origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }))
  );
});
