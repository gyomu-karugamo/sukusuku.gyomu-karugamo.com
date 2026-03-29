const CACHE_NAME = 'moriris-v1';
const STATIC_ASSETS = [
  '/assets/favicon.png',
  '/assets/logo-moriris.png',
  '/assets/hero-forest.png',
  '/assets/home-img.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Supabase / Stripe / 外部API はキャッシュしない
  if (
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('stripe.com') ||
    url.hostname.includes('videodelivery.net') ||
    url.hostname.includes('cloudflare') ||
    url.hostname.includes('googletagmanager') ||
    url.protocol === 'chrome-extension:'
  ) {
    return;
  }

  // 静的アセット: Cache First
  if (
    event.request.destination === 'image' ||
    event.request.url.includes('/assets/')
  ) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        return cached || fetch(event.request).then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // HTML: Network First（常に最新を取得）
  if (event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }
});
