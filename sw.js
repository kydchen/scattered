const CACHE = "scattered-v75";
const ASSETS = ["./", "./index.html", "./about.html", "./privacy.html", "./styles.css?v=72", "./sharing.css?v=74", "./model.js", "./workspace.js", "./sync-model.js", "./drive-sync.js", "./sync-config.js?v=68", "./svg-export.js", "./svg-export.js?v=75", "./i18n.js?v=73", "./app.js?v=73", "./share-ui.js?v=73", "./live-share.js", "./share-model.js", "./share-config.js", "./present.html", "./present.js?v=75", "./manifest.webmanifest", "./icon.svg", "./icon-180.png", "./icon-192.png", "./icon-512.png"];

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
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
