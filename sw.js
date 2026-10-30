// KaraoKry service worker: caches the app shell only, so the installed app opens
// instantly. Spotify, its SDK and LRCLIB always go to the network.
//
// VERSION must match APP_VERSION in config.js. Bump both on every deploy.

const VERSION = '1.2.2';
const CACHE = `karaokry-shell-${VERSION}`;

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'config.js',
  'css/app.css',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'js/app.js',
  'js/auth.js',
  'js/debug.js',
  'js/game.js',
  'js/lyrics-ahead.js',
  'js/lyrics.js',
  'js/main.js',
  'js/playlists.js',
  'js/prepare.js',
  'js/pwa.js',
  'js/recording.js',
  'js/router.js',
  'js/spotify-api.js',
  'js/storage.js',
  'js/wake-lock.js',
  'js/playback/connect-engine.js',
  'js/playback/engine.js',
  'js/playback/manager.js',
  'js/playback/sdk-engine.js',
  'js/ui/confetti.js',
  'js/ui/dialogs.js',
  'js/ui/dom.js',
  'js/ui/haptics.js',
  'js/ui/long-press.js',
  'js/ui/lyrics-view.js',
  'js/ui/scrub-bar.js',
  'js/ui/toast.js',
  'js/ui/screens/game-over.js',
  'js/ui/screens/how-to.js',
  'js/ui/screens/pass.js',
  'js/ui/screens/picker.js',
  'js/ui/screens/preparing.js',
  'js/ui/screens/reveal.js',
  'js/ui/screens/round.js',
  'js/ui/screens/settings.js',
  'js/ui/screens/simple.js',
  'js/ui/screens/welcome.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL.map((path) => new Request(path, { cache: 'reload' })))),
  );
  // No skipWaiting here: the app shows "New version ready. Tap to refresh." instead.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('karaokry-shell-') && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Spotify, scdn.co and LRCLIB (and anything else off-site) always use the network.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // The OAuth redirect lands on ?code=...: serve the cached page whatever the query string.
    event.respondWith(
      caches.match('index.html', { cacheName: CACHE }).then((cached) => cached ?? fetch(request)),
    );
    return;
  }

  event.respondWith(
    caches.match(request, { cacheName: CACHE, ignoreSearch: true }).then((cached) => cached ?? fetch(request)),
  );
});
