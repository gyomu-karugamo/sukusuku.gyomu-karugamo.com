// Service Worker for 業務かるがも PWA
const CACHE_NAME = 'karugamo-v1';
const STATIC_ASSETS = [
  '/app.html',
  '/assets/icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network first、失敗時のみキャッシュ
self.addEventListener('fetch', (e) => {
  // Supabase や LINE API は常にネットワーク
  if (e.request.url.includes('supabase.co') ||
      e.request.url.includes('line.me') ||
      e.request.url.includes('stripe.com')) {
    return;
  }
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
