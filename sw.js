const CACHE = "scattered-v78";
const ASSETS = ["./", "./index.html", "./about.html", "./privacy.html", "./styles.css?v=78", "./sharing.css?v=78", "./model.js", "./workspace.js?v=78", "./sync-model.js", "./drive-sync.js?v=78", "./sync-config.js?v=68", "./svg-export.js", "./svg-export.js?v=75", "./i18n.js?v=78", "./app.js?v=78", "./share-ui.js?v=78", "./live-share.js", "./share-model.js", "./share-config.js", "./present.html", "./present.js?v=78", "./manifest.webmanifest", "./icon.svg", "./icon-180.png", "./icon-192.png", "./icon-512.png"];

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
