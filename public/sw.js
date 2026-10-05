const CACHE = 'gpp-shell-v5';
const base = new URL('./', self.registration.scope);
const asset = name => new URL(name, base).toString();
const ASSETS = ['index.html','manifest.webmanifest','config.js','theme.js','feedback.js','app.js','styles.css','icons/icon.svg','icons/icon-192.png','icons/icon-512.png'].map(asset);
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) { event.respondWith(fetch(event.request)); return; }
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request).then(response => response || caches.match(asset('index.html')))));
});
