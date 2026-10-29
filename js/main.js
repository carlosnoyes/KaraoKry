// Boot: wire up the modules, finish a login, resume a game, start the router.

import { registerScreen, go, onScreenChange, currentScreenId } from './router.js';
import { setAuthHooks } from './spotify-api.js';
import {
  getValidToken, refreshAccessToken, completeLoginFromUrl, isLoggedIn, initAuthSync, onAuthEvent,
} from './auth.js';
import {
  MESSAGES, afterLogin, loginExpired, showOffline, saveSnapshot, syncWakeLock,
} from './app.js';
import { playback } from './playback/manager.js';
import { keepAwake } from './wake-lock.js';
import { initInstallPrompt, registerServiceWorker, showUpdateIfAllowed } from './pwa.js';
import { recordError } from './debug.js';

import { loading, loginDone, guestList, resume } from './ui/screens/simple.js';
import welcome from './ui/screens/welcome.js';
import howTo from './ui/screens/how-to.js';
import picker from './ui/screens/picker.js';
import preparing from './ui/screens/preparing.js';
import pass from './ui/screens/pass.js';
import round from './ui/screens/round.js';
import reveal from './ui/screens/reveal.js';
import gameOver from './ui/screens/game-over.js';
import settings from './ui/screens/settings.js';

setAuthHooks({ getToken: getValidToken, forceRefresh: refreshAccessToken });
initInstallPrompt();
registerServiceWorker();

for (const screen of [loading, welcome, loginDone, guestList, howTo, resume, picker, preparing, pass, round, reveal, gameOver, settings]) {
  registerScreen(screen);
}
go('loading');

onScreenChange((id) => {
  syncWakeLock(id);
  showUpdateIfAllowed(id);
});

// ---- Login state shared with other windows ------------------------------------------------

initAuthSync();
onAuthEvent((type) => {
  if (type === 'expired') {
    loginExpired();
  } else if (type === 'remote-login' && ['welcome', 'loading', 'guest-list'].includes(currentScreenId())) {
    // The login finished in a browser tab; pick it up in this window.
    afterLogin();
  } else if (type === 'remote-logout' && currentScreenId() !== 'welcome') {
    playback.reset();
    keepAwake(false);
    go('welcome');
  }
});

// ---- Saving and returning to the app --------------------------------------------------------

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    saveSnapshot();
  } else if (currentScreenId() === 'welcome' && isLoggedIn()) {
    afterLogin();
  }
});
window.addEventListener('pagehide', () => saveSnapshot());

// ---- Only one KaraoKry window plays at a time ------------------------------------------------

const windowId = crypto.getRandomValues(new Uint32Array(2)).join('-');
const openedAt = Date.now();
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('karaokry') : null;

function announceWindow() {
  channel?.postMessage({ type: 'hello', id: windowId, at: openedAt });
}

channel?.addEventListener('message', (event) => {
  const message = event.data;
  if (message?.type !== 'hello' || message.id === windowId || message.at < openedAt) return;
  // A newer window has opened: step aside.
  saveSnapshot();
  playback.reset();
  keepAwake(false);
  const overlay = document.getElementById('overlay-other-window');
  overlay.hidden = false;
  overlay.querySelector('[data-action="here"]').onclick = () => location.reload();
});

// ---- Start ----------------------------------------------------------------------------------

async function boot() {
  const login = await completeLoginFromUrl();
  if (login.status === 'ok' && login.elsewhere) {
    go('login-done');
    return;
  }
  announceWindow();
  if (login.status === 'ok') {
    await afterLogin();
    return;
  }
  if (login.status === 'cancelled') {
    go('welcome', { message: MESSAGES.cancelled });
    return;
  }
  if (login.status === 'state_mismatch' || login.status === 'error') {
    go('welcome', { message: MESSAGES.loginFailed, retry: true });
    return;
  }
  if (!navigator.onLine) {
    showOffline(boot);
    return;
  }
  if (!isLoggedIn()) {
    go('welcome');
    return;
  }
  await afterLogin();
}

boot().catch((err) => {
  recordError('boot', err);
  console.error(err);
  go('welcome', { message: MESSAGES.spotifyDown });
});
