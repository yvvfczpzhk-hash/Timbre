/* TIMBRE — service worker : l'app reste disponible sans réseau.
   Réseau d'abord : la dernière version publiée est servie dès qu'il y a du réseau ; la copie locale ne sert que
   hors ligne ou si le réseau ne répond pas en 5 secondes. */
const CACHE = 'timbre-page-v1';
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // la requête telle quelle (une navigation garde ainsi son traitement normal des redirections)
    const net = fetch(req).then(res => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
      return res;
    });
    net.catch(() => {});
    try {
      return await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('réseau lent')), 5000))]);
    } catch (err) {
      const hit = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? (await cache.match('./')) || (await cache.match('./index.html')) : null);
      return hit || net;                    // pas de copie locale : on attend le réseau (ou son erreur)
    }
  })());
});
