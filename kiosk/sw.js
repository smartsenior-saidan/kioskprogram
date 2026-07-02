// SmartSenior Kiosk — Service Worker
// Caches the app shell so the kiosk loads instantly and survives brief network drops.

const CACHE = 'smartsenior-v20';

const APP_SHELL = [
  './index.html',
  './profile.html',
  './family.html',
  './slideshow.html',
  './thankyou.html',
  './css/style.css',
  './css/kiosk.css',
  './js/config.js',
  './js/search.js',
  './js/profile.js',
  './js/firebase.js',
  './js/tenant-bg.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Install: cache the app shell
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate: remove old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for Firebase/CDN, cache-first for app shell
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Always go to the network for Firebase and external CDNs
  if (
    url.hostname.includes('firebase') ||
    url.hostname.includes('google') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('firebaseapp') ||
    url.hostname.includes('jsdelivr')
  ) {
    return; // let the browser handle it normally
  }

  // Cache-first for same-origin app shell assets
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request).then((res) => {
        // Refresh the cache entry on successful fetch
        if (res.ok) {
          caches.open(CACHE).then((cache) => cache.put(e.request, res.clone()));
        }
        return res;
      });
      return cached || network;
    })
  );
});
