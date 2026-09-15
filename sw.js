// Service worker simples: guarda em cache os arquivos do próprio app
// (HTML/CSS/JS/ícones) para abrir instantaneamente, mesmo sem internet.
// Os dados em tempo real continuam vindo só via MQTT (WebSocket), que
// não passa por aqui — isso só acelera/permite abrir a interface.

// CORRIGIDO: era "cache primeiro, atualiza depois" -- isso fazia o app
// continuar rodando uma versão antiga do app.js/index.html/styles.css
// mesmo depois de você substituir os arquivos, até um segundo reload.
// Como o valor desse app é mostrar dado ao vivo, faz mais sentido
// priorizar "sempre atual quando online" e só usar o cache como reserva
// para quando não há internet.
const CACHE_NAME = "piscina-shell-v10";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Só intercepta pedidos do próprio app (GET, mesma origem).
  // Chamadas ao broker MQTT são WebSocket, não passam por aqui.
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
