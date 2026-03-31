// Service Worker - 無効化版
// PWA白画面問題対策: キャッシュを一切使わない
const CACHE_NAME = 'karugamo-disabled-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  // 古いキャッシュを全削除
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
// fetchイベントを一切処理しない = 全てネットワークを使う
self.addEventListener('fetch', () => {});
