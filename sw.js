// Service Worker: hält App und (verschlüsselte) Noten offline bereit.
const SHELL = "chornoten-shell-v3";
const DATA = "chornoten-data";
const SHELL_FILES = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest",
  "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k.startsWith("chornoten-shell") && k !== SHELL).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // meta.json: immer zuerst Netz (für Aktualisierungen), sonst Cache
  if (url.pathname.endsWith("/data/meta.json")) {
    e.respondWith(fetch(e.request, { cache: "no-store" }).then(r => {
      const copy = r.clone(); caches.open(DATA).then(c => c.put(e.request, copy)); return r;
    }).catch(() => caches.match(e.request)));
    return;
  }
  // App-Dateien: Netz zuerst (damit Updates ankommen), offline aus dem Cache
  if (!url.pathname.includes("/data/")) {
    e.respondWith(fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(m => m || caches.match("index.html"))));
    return;
  }
  // Notenseiten: Cache zuerst
  e.respondWith(caches.match(e.request).then(m => m || fetch(e.request)));
});
