// Service worker for Waiting Game PWA.
// Caches the app shell and game assets for offline play.
const CACHE = 'waiting-game-v6';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './src/main.js',
  './src/scenes/Boot.js',
  './src/scenes/Menu.js',
  './src/scenes/FloorPlanEditor.js',
  './src/scenes/GuestEditor.js',
  './src/scenes/Game.js',
  './src/data/defaults.js',
  './src/data/catalog.js',
  './src/data/assetIndex.js',
  './src/core/Storage.js',
  './src/core/Palette.js',
  './src/core/MobileControls.js',
  // Summary only. Per-sheet detail under game-assets/asset-index/ and the themed
  // PNGs are fetched on demand and picked up by the runtime cache below.
  './game-assets/asset-index.json',
  './game-assets/tiles/1_Generic_48x48.png',
  './game-assets/tiles/12_Kitchen_48x48.png',
  './game-assets/tiles/Room_Builder_48x48.png',
  './game-assets/tiles/Room_Builder_Floors_48x48.png',
  './game-assets/tiles/Room_Builder_Walls_48x48.png',
  './game-assets/tiles/Room_Builder_3d_walls_48x48.png',
  './game-assets/tiles/Room_Builder_borders_48x48.png',
  './game-assets/ui/UI_48x48.png',
  './game-assets/ui/icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // Network-first for modules, cache fallback.
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
  );
});
