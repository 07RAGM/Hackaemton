/**
 * Mesh-ResQ GNSS — Service Worker del Cliente de Campo.
 * Estrategia: cache-first para el *app shell*, network-only para la API.
 * Permite abrir la PWA y registrar reportes sin ningún tipo de conexión.
 */
'use strict';

const CACHE = 'meshresq-shell-v1';
const SHELL = [
  '/cliente/',
  '/cliente/index.html',
  '/cliente/app.js',
  '/cliente/icon.svg',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((claves) =>
        Promise.all(claves.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Sólo gestiona el ámbito del cliente de campo: la API, el WebSocket y el
  // dashboard de control nunca pasan por el service worker.
  if (!url.pathname.startsWith('/cliente/')) {
    return;
  }

  // La API y el WebSocket nunca se cachean: son datos vivos del nodo mesh.
  if (req.method !== 'GET' || url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cacheado) => {
      if (cacheado) return cacheado;
      return fetch(req)
        .then((resp) => {
          if (resp.ok && url.origin === self.location.origin) {
            const copia = resp.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copia));
          }
          return resp;
        })
        .catch(() => caches.match('/cliente/index.html'));
    })
  );
});
