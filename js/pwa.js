// Installable-app plumbing: the service worker, Chrome's install prompt and the
// "New version ready" toast.

import { toast, dismissToast } from './ui/toast.js';

const UPDATE_SCREENS = new Set(['picker', 'game-over', 'settings']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

let installPrompt = null;
const installListeners = new Set();
let waitingWorker = null;
let updateRequested = false;
let lastScreen = null;

// ---- Install prompt --------------------------------------------------------------------

export function initInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    notifyInstall();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    notifyInstall();
  });
}

export function canInstall() {
  return Boolean(installPrompt);
}

export function onInstallChange(fn) {
  installListeners.add(fn);
  return () => installListeners.delete(fn);
}

function notifyInstall() {
  for (const fn of installListeners) fn(canInstall());
}

/** Shows Chrome's install dialog. The button goes away whatever the user picks. */
export async function promptInstall() {
  const prompt = installPrompt;
  if (!prompt) return;
  installPrompt = null;
  notifyInstall();
  try {
    await prompt.prompt();
    await prompt.userChoice;
  } catch {
    // ignore
  }
}

// ---- Service worker ------------------------------------------------------------------------

export function isLoopbackHost() {
  return LOOPBACK_HOSTS.has(location.hostname);
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  // During local development, a cached app shell only gets in the way.
  if (isLoopbackHost()) {
    navigator.serviceWorker.getRegistrations()
      .then((registrations) => registrations.forEach((reg) => reg.unregister()))
      .catch(() => {});
    return;
  }

  navigator.serviceWorker.register('sw.js').then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) setWaiting(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) setWaiting(worker);
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) reg.update().catch(() => {});
    });
  }).catch(() => {});

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Only reload when this window asked for the update, never in the middle of a round.
    if (updateRequested) location.reload();
  });
}

function setWaiting(worker) {
  waitingWorker = worker;
  showUpdateIfAllowed(lastScreen);
}

function applyUpdate() {
  if (!waitingWorker) return;
  updateRequested = true;
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}

/** Shows the update toast only on the picker, Game over and Settings screens. */
export function showUpdateIfAllowed(screenId) {
  lastScreen = screenId;
  if (!waitingWorker) return;
  if (UPDATE_SCREENS.has(screenId)) {
    toast('New version ready. Tap to refresh.', { sticky: true, id: 'update', action: { onClick: applyUpdate } });
  } else {
    dismissToast('update');
  }
}
