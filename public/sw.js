/*
 * juhyeonDS - service worker.
 * Lets the site be installed as an app and opened without a network connection.
 * Strategy: always try the network first (so updates show up immediately) and fall back to
 * the copy saved from the last successful visit.
 * Licensed under the GNU General Public License v3 or later.
 */
const CACHE = 'juhyeonds-v1';
const SHELL = [
  './',
  'index.html',
  'privacy.html',
  'config.js',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/audio.js',
  'js/audio-worklet.js',
  'js/backend-local.js',
  'js/backend-remote.js',
  'js/drive.js',
  'js/emu-runner.js',
  'js/emu-worker.js',
  'js/input.js',
  'js/storage.js',
  'js/systems.js',
  'js/vendor/fflate.js',
  'core/melonds.js',
  'core/melonds.wasm',
  'core/mgba.js',
  'core/mgba.wasm',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Only this site's own files; never the emulation server's API or anything cross-origin.
  if (url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() =>
        caches.match(request, { ignoreSearch: true }).then((cached) => {
          if (cached) return cached;
          if (request.mode === 'navigate') return caches.match('index.html');
          return Response.error();
        })
      )
  );
});
