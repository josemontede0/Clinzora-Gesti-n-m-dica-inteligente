/*
 * Service worker de Clinzora (PWA).
 * Política de caché por privacidad: SOLO recursos estáticos públicos (código de la interfaz, estilos, logos,
 * íconos) y una página "sin conexión". NUNCA se guardan respuestas de la API (/backend) ni páginas con datos:
 * la información de pacientes no debe quedar almacenada en el dispositivo.
 */
const VERSION = 'clinzora-v1';
const STATIC_CACHE = `${VERSION}-static`;
const PRECACHE = ['/offline.html', '/icon-192.png', '/icon-512.png', '/brand/clinzora-icono.svg', '/brand/clinzora-logo-vertical.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isStatic = (url) =>
  url.origin === self.location.origin &&
  (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/brand/') || /\.(?:png|svg|ico|woff2?)$/.test(url.pathname));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // API y cualquier otro origen: siempre red, sin caché.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/backend')) return;

  if (req.mode === 'navigate') {
    // Páginas: siempre desde la red; si no hay conexión, página sin conexión (no se guardan páginas).
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }

  if (isStatic(url)) {
    // Estáticos con hash/inmutables: caché primero y actualización en segundo plano.
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
  }
});
