/**
 * Service Worker de Cache Offline-First e Suporte à Rede Mesh.
 * Mantém a interface estática, modelos 3D e o último estado da telemetria em cache local
 * para carregamento imediato mesmo sob sinal Wi-Fi fraco a grandes distâncias do veículo.
 */

const CACHE_NAME = 'solar-telemetry-v4';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css?v=20261106i',
  '/js/models3d.js?v=20261106i',
  '/js/charts.js?v=20261106i',
  '/js/mesh.js?v=20261106i',
  '/js/app.js?v=20261106i'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Nunca intercepta chamadas externas (API do GitHub / túnel Cloudflare) ou runtime-config
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.endsWith('/runtime-config.json')
  ) {
    return;
  }

  // Para arquivos da interface (HTML, CSS, JS), prioriza a rede e cai para o cache apenas quando sem conexão
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});

