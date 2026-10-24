const CACHE = 'gpp-shell-v8';
const base = new URL('./', self.registration.scope);
const asset = name => new URL(name, base).toString();
const ASSETS = ['index.html','login.html','manifest.webmanifest','config.js','app.js','editor.js','login.js','theme.js','feedback.js','styles.css','login.css','icons/icon.svg','icons/icon-192.png','icons/icon-512.png'].map(asset);
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('gpp-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) { event.respondWith(fetch(event.request)); return; }
  const update = fetch(event.request).then(async response => {
    if (response.ok) {
      try {
        const cache = await caches.open(CACHE);
        await cache.put(event.request, response.clone());
      } catch (error) {
        console.warn('Unable to update cached site asset.', error);
      }
    }
    return response;
  }).catch(() => null);
  event.waitUntil(update.then(() => undefined));
  event.respondWith(caches.match(event.request).then(cached => cached || update.then(response => response || caches.match(asset('index.html')))));
});
