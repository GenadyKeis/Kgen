const CACHE_NAME = 'japan-v2-shell-61';

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  // Cache-first, like the rest of the shell: almanac.html is a finished reference
  // document, and 640 KB is not worth re-fetching on every load. ⚠ That means an
  // almanac EDIT reaches installed clients only via a CACHE_NAME bump — the same
  // rule the other shell files follow.
  './almanac.html',
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
  './data/sos.json',
  './data/reservations.json'
];

const ALL_ASSETS = SHELL_ASSETS.concat(DATA_ASSETS);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // ⚠ NOT cache.addAll — and this is not a style preference. addAll fetches through
      // the BROWSER'S OWN HTTP CACHE, so a stale disk copy can populate a brand-new
      // CACHE_NAME and the version bump silently delivers old bytes. Measured 2026-08-18:
      // cache `japan-v2-shell-31`, created minutes earlier, held a 3,261-byte index.html
      // while the server was serving 3,904. The stale one predated the Almanac nav tab,
      // so a feature shipped 2026-08-15 was ABSENT from the nav on a version bump whose
      // whole job is to deliver such changes — with a current app.js beside it, i.e. a
      // MISMATCHED shell, which is worse than an old one.
      // `cache: 'reload'` bypasses the HTTP cache and writes what the server actually has.
      // Kept fail-fast like addAll: if any asset 404s, the install rejects and the old
      // service worker stays in charge rather than a half-built cache taking over.
      .then(cache => Promise.all(ALL_ASSETS.map(url =>
        fetch(url, { cache: 'reload' }).then(res => {
          if (!res.ok) throw new Error('precache failed: ' + url + ' — HTTP ' + res.status);
          return cache.put(url, res);
        })
      )))
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
  const url = new URL(event.request.url);

  // Network-only for weather API
  if (url.hostname === 'api.open-meteo.com') {
    event.respondWith(fetch(event.request));
    return;
  }

  const sameOrigin = url.origin === self.location.origin;

  // Data JSON: network-first with cache fallback — data edits reach installed
  // clients without a cache-version bump, and offline still works (audit S12)
  if (sameOrigin && url.pathname.includes('/data/') && url.pathname.endsWith('.json')) {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for everything else; cache-on-first-load only for trip-data
  // attachments (PDFs) — not arbitrary same-origin pages (audit S12)
  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request).then(response => {
        if (response.ok && event.request.method === 'GET' &&
            sameOrigin && url.pathname.includes('/trip-data/')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }))
  );
});
