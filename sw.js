// Service Worker — Finanças & Rotina
// Estratégia: network-first pro HTML (updates aparecem rápido)
//             cache-first pros assets (CSS/JS/SVG)
// Pra forçar atualização total: bumpe o número da versão abaixo.
"use strict";

const VERSION = "v26";
const CACHE = "financas-" + VERSION;

const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./db.js",
  "./app.js",
  "./planejamento.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-192.svg",
  "./icons/icon-512.svg",
  "./icons/icon-maskable.svg"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      // Cacheia cada asset individualmente — se um faltar, não quebra os outros
      Promise.all(ASSETS.map((a) =>
        c.add(a).catch((err) => console.warn("[SW] não cacheou:", a, err && err.message))
      ))
    )
  );
  // Não dá skipWaiting automático — espera o usuário aprovar via mensagem
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// Permite que o app peça pra ativar a nova versão ou consultar a versão
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
  if (e.data && e.data.type === "GET_VERSION") {
    // Responde pelo MessageChannel port se houver; senão pelo source
    if (e.ports && e.ports[0]) {
      e.ports[0].postMessage({ type: "VERSION", version: VERSION });
    } else if (e.source && typeof e.source.postMessage === "function") {
      e.source.postMessage({ type: "VERSION", version: VERSION });
    }
  }
});

// Click em notificação foca/abre o app
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientes) => {
      for (const c of clientes) {
        if ("focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});

function isNavigation(req) {
  return req.mode === "navigate"
      || (req.headers.get("accept") || "").includes("text/html");
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (!url.origin.startsWith(self.location.origin)) return;

  if (isNavigation(e.request)) {
    // Network-first pra HTML — busca online; só cai pro cache se offline
    e.respondWith(
      fetch(e.request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return resp;
        })
        .catch(() =>
          caches.match(e.request).then((cached) => cached || caches.match("./index.html"))
        )
    );
    return;
  }

  // Cache-first pros assets — rápido, cai pra rede se não tem em cache
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return resp;
        })
        .catch(() => cached);
    })
  );
});
