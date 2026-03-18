const CACHE_NAME = 'telegram-pages-mirror-v7';
const STATIC_ASSETS = [
  './manifest.webmanifest',
  './data/channels/pgp-official/media/channel-avatar.jpg',
  './data/channels/index.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isLocalAsset = url.origin === self.location.origin;
  const isDynamicData = isLocalAsset && url.pathname.includes('/data/');
  const isAppShellAsset =
    isLocalAsset &&
    /\.(?:html|css|js|webmanifest|svg|png|jpg|jpeg)$/i.test(url.pathname);

  if (event.request.mode === 'navigate' || isDynamicData || isAppShellAsset) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (!response || response.status !== 200) return response;
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  if (!isLocalAsset) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200) return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      });
    })
  );
});
