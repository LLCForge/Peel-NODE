// H174: çevrimdışı çalışma. Yalnızca uygulamanın kendi kaynakları (aynı köken, GET) önbelleğe alınır;
// kullanıcı kodu hiçbir zaman ağ isteği olmadığı için önbelleğe de girmez.
// Kurulumda sayfa ve sayfanın referans verdiği derlenmiş dosyalar alınır; geri kalanlar (worker, WASM,
// isteğe bağlı parçalar) ilk kullanımda önbelleğe yazılır. Sayfa gezintisi ağ-öncelikli, dosyalar önbellek-önceliklidir.
const VERSION = 'peel-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './peel-icon.svg', './favicon.ico'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    // derlenmiş sayfanın script/stylesheet bağlantıları (hash'li dosya adları)
    const html = await (await cache.match('./index.html')).text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css|woff2|png|svg))"/g)]
      .map((m) => new URL(m[1], self.registration.scope))
      .filter((u) => u.origin === self.location.origin)
      .map((u) => u.href);
    await cache.addAll([...new Set(assets)]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // geliştirme sunucusu modülleri (Vite): asla önbellekten sunulmaz, yoksa eski kod çalışır
  if (/^\/(@vite|@id|@fs|src|node_modules)\//.test(url.pathname) || url.searchParams.has('v') || url.searchParams.has('t')) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(VERSION)).put('./index.html', res.clone());
        return res;
      } catch {
        return (await caches.match('./index.html')) ?? Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') (await caches.open(VERSION)).put(req, res.clone());
    return res;
  })());
});
