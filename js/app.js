// App-level flows shared by the screens: what happens after login, starting and
// resuming games, ending them, logging out, and app-wide notices.

import { go, currentScreenId } from './router.js';
import { getMe, listPlaylists } from './playlists.js';
import { getAuth, setUser, logout as clearLogin, AuthRequiredError } from './auth.js';
import { SpotifyError } from './spotify-api.js';
import { lsGet } from './storage.js';
import {
  actions, getGame, clearGame, deleteSavedGame, loadSavedGame, resumeGame, save, onGameChange,
} from './game.js';
import { playback } from './playback/manager.js';
import { keepAwake } from './wake-lock.js';
import {
  startCamera, stopCamera, cameraFailed, isRecordingEnabled, isRecordingSupported,
  beginRound, recordPlaying, recordPaused, finishRound, discardRound,
} from './recording.js';
import { confirmDialog, infoDialog } from './ui/dialogs.js';
import { toast } from './ui/toast.js';

export const MESSAGES = {
  expired: 'Your Spotify login has expired. Please log in again.',
  cancelled: 'Spotify login was cancelled.',
  loginFailed: "The Spotify login didn't finish. Try logging in again.",
  spotifyDown: "Couldn't reach Spotify. Please try again.",
  premium: 'Spotify Premium is needed to host a game on this phone.',
};

const IN_GAME_SCREENS = new Set(['pass', 'round', 'reveal', 'settings', 'how-to']);

let playlistCache = null;
let snapshotProvider = null;
let premiumNoticeOpen = false;

// ---- Login and home --------------------------------------------------------------------

let afterLoginRun = null;

/** Confirms the login with GET /me, then continues to the right screen. Concurrent calls share one run. */
export function afterLogin() {
  if (!afterLoginRun) {
    afterLoginRun = runAfterLogin().finally(() => {
      afterLoginRun = null;
    });
  }
  return afterLoginRun;
}

async function runAfterLogin() {
  go('loading');
  let me;
  try {
    me = await getMe();
  } catch (err) {
    handleStartupError(err, afterLogin);
    return;
  }
  setUser(me);
  playback.preload();
  await routeHome();
}

export function handleStartupError(err, retry) {
  if (err instanceof AuthRequiredError) {
    go('welcome', { message: err.reason === 'expired' ? MESSAGES.expired : null });
  } else if (err instanceof SpotifyError && err.status === 403) {
    go('guest-list');
  } else if (err instanceof SpotifyError && err.code === 'network') {
    showOffline(retry);
  } else {
    go('welcome', { message: MESSAGES.spotifyDown });
  }
}

/** How to play (first time), then the Resume prompt or the playlist picker. */
export async function routeHome() {
  if (lsGet('kk.seenHowTo') !== true) {
    go('how-to', { onDone: routeHome });
    return;
  }
  const saved = await loadSavedGame();
  const userId = getAuth()?.userId;
  if (saved && userId && saved.userId === userId) {
    go('resume', { saved });
    return;
  }
  if (saved) await deleteSavedGame();
  go('picker');
}

export async function getPlaylists({ force = false } = {}) {
  if (playlistCache && !force) return playlistCache;
  playlistCache = await listPlaylists(getAuth()?.userId);
  return playlistCache;
}

// ---- Games ---------------------------------------------------------------------------------

/**
 * Call inside the Start or Resume tap: readies playback and keeps the screen awake.
 * `engineFactory` is only used by the development demo.
 */
export function enterGame({ engineFactory = null } = {}) {
  playback.useDemo(engineFactory);
  playback.prepare({ newGame: true });
  keepAwake(true);
  startFilming();
}

/** Starts the selfie camera (inside a tap, so the browser can ask for permission). */
export function startFilming() {
  if (!isRecordingEnabled() || !isRecordingSupported()) return;
  startCamera().then((ok) => {
    if (!ok && cameraFailed()) {
      toast("Camera or microphone blocked, so singers won't be filmed. Allow them in Chrome's site settings.", { ms: 5000 });
    }
  });
}

/**
 * Keeps the recording in step with the game: record while the song plays, pause
 * with it, finish on Got It! or Reveal (for the replay), start over on a new round.
 */
export function initRecordingSync() {
  onGameChange((game) => {
    if (!game) {
      stopCamera();
      return;
    }
    beginRound(`${game.id}:${game.round}`);
    switch (game.phase) {
      case 'playing':
        recordPlaying();
        break;
      case 'paused':
      case 'ended':
        recordPaused();
        break;
      case 'reveal':
        finishRound();
        break;
      case 'over':
        stopCamera();
        break;
      default:
        discardRound();
    }
  });
}

/** "Resume" on the resume prompt. Must run inside the tap. */
export function resumeSavedGame(saved) {
  const game = resumeGame(saved);
  enterGame();
  if (game.phase === 'reveal') go('reveal');
  else if (game.phase === 'pass') go('pass');
  else go('round', { resumed: true });
}

/** Asks first, then ends the game and shows Game over. */
export async function confirmEndGame() {
  const ok = await confirmDialog({
    title: 'End this game?',
    body: "You won't be able to resume it.",
    confirmLabel: 'End game',
    cancelLabel: 'Cancel',
    danger: true,
  });
  if (!ok) return false;
  playback.pause().catch(() => {});
  actions.end();
  go('game-over');
  return true;
}

/** Leaves the game for the picker (the saved game stays, so it can be resumed later). */
export function leaveGame() {
  playback.pause().catch(() => {});
  keepAwake(false);
  stopCamera();
  go('picker');
}

export async function premiumRequired() {
  if (premiumNoticeOpen) return;
  premiumNoticeOpen = true;
  saveSnapshot();
  playback.pause().catch(() => {});
  await infoDialog({ title: 'Premium needed', body: MESSAGES.premium });
  premiumNoticeOpen = false;
  leaveGame();
}

export function loginExpired() {
  saveSnapshot();
  playback.reset();
  keepAwake(false);
  stopCamera();
  if (currentScreenId() !== 'welcome') go('welcome', { message: MESSAGES.expired });
}

export async function logout() {
  playback.reset();
  keepAwake(false);
  stopCamera();
  clearLogin();
  await deleteSavedGame();
  clearGame();
  playlistCache = null;
  go('welcome');
}

/** Keeps the wake lock in step with the screen: on during a game, off elsewhere. */
export function syncWakeLock(screenId) {
  const game = getGame();
  keepAwake(Boolean(game && game.phase !== 'over' && IN_GAME_SCREENS.has(screenId)));
}

// ---- Saving the round position ---------------------------------------------------------------

/** The round screen registers a function that copies the live position into the game. */
export function setSnapshotProvider(fn) {
  snapshotProvider = fn;
}

export function saveSnapshot() {
  if (!getGame()) return;
  try {
    snapshotProvider?.();
  } catch {
    // ignore
  }
  save();
}

// ---- Offline notice -------------------------------------------------------------------------

export function showOffline(retry) {
  const overlay = document.getElementById('overlay-offline');
  const button = overlay.querySelector('[data-action="retry"]');
  overlay.hidden = false;
  button.focus({ preventScroll: true });
  button.onclick = () => {
    overlay.hidden = true;
    retry();
  };
}
