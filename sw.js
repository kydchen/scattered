const CACHE = "scattered-v90p1";
const ASSETS = ["./", "./index.html", "./about.html", "./privacy.html", "./styles.css?v=88", "./sharing.css?v=78", "./model.js", "./model.js?v=89", "./workspace.js?v=89", "./sync-model.js?v=79", "./drive-sync.js?v=89", "./sync-config.js?v=68", "./svg-export.js", "./svg-export.js?v=75", "./i18n.js?v=89", "./app.js?v=90p1", "./note-editor.js?v=88", "./share-ui.js?v=89", "./live-share.js", "./share-model.js", "./share-config.js", "./present.html", "./present.js?v=89", "./manifest.webmanifest", "./icon.svg", "./icon-180.png", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  const network = fetch(event.request);
  // A late response may update the cache after the UI has already resumed.
  // Neither a server error nor a full cache should replace a working shell.
  event.waitUntil(network.then(async (response) => {
    if (!response.ok) return;
    const copy = response.clone();
    const cache = await caches.open(CACHE);
    await cache.put(event.request, copy);
  }).catch(() => {}));
  event.respondWith((async () => {
    const cached = await caches.open(CACHE).then(cache => cache.match(event.request)).catch(() => undefined);
    if (!cached) return network;
    if (self.navigator.onLine === false) return cached;
    // Radios and captive networks can stay "online" while fetch hangs. Bound
    // that wait only when this exact resource already has an offline copy.
    let timer;
    try {
      return await Promise.race([
        network.then(response => response.ok ? response : cached, () => cached),
        new Promise(resolve => { timer = setTimeout(() => resolve(cached), 1000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  })());
});
