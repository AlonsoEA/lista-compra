// Sube este número cada vez que cambies la app para que el iPhone descargue la versión nueva.
const CACHE = 'compra-v2';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'store.js', 'firebase-config.js', 'manifest.json', 'vendor/firebase.js', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Solo los archivos de la propia app: primero la red (para recibir actualizaciones)
// y, si no hay conexión, la copia guardada. Las peticiones a Firebase no se tocan.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
