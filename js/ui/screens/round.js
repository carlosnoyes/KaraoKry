// Screens 8 and 9: the 3-2-1 countdown and the round itself. The singer scrolls
// the wrong lyrics and controls playback; only the position moves on its own.

import { go } from '../../router.js';
import { refs, songProgress } from '../dom.js';
import { getGame, currentPair, actions } from '../../game.js';
import { playback } from '../../playback/manager.js';
import {
  PremiumRequiredError, TrackUnplayableError, NeedsSpotifyAppError, EngineUnavailableError,
} from '../../playback/engine.js';
import { AuthRequiredError } from '../../auth.js';
import { SpotifyError } from '../../spotify-api.js';
import { recordError } from '../../debug.js';
import { LyricsView } from '../lyrics-view.js';
import { ScrubBar, formatTime } from '../scrub-bar.js';
import { longPress } from '../long-press.js';
import { confetti } from '../confetti.js';
import { vibrate, PATTERNS } from '../haptics.js';
import { toast } from '../toast.js';
import { menuSheet } from '../dialogs.js';
import { confirmEndGame, premiumRequired, loginExpired, setSnapshotProvider, saveSnapshot } from '../../app.js';
import { onStreamChange, onRecordingChange } from '../../recording.js';

const SLOW_START_MS = 8000;
const RESUME_CHECK_MS = 4000;
const VISIBLE_CHECK_MS = 1500;
const SAVE_EVERY_MS = 5000;
const SEEK_STEP_MS = 10_000;
const HOLD_TO_SKIP_MS = 700;
const COMMAND_GRACE_MS = 1500;
const ROUND_PHASES = new Set(['playing', 'paused', 'ended']);

const s = {
  key: null,            // "<game id>:<round>" currently rendered
  generation: -1,       // playback.generation when this round's song was loaded
  needsReload: true,    // the engine does not have this round's song loaded
  starting: false,
  playToken: 0,
  positionMs: 0,
  durationMs: 0,
  stretches: [],
  controlsEnabled: true,
  visible: false,
  noticeKind: null,
  lastCommandAt: 0,
  frame: 0,
  countdownTimer: null,
  slowTimer: null,
  resumeTimer: null,
  saveTimer: null,
  waitController: null,
};

let r;
let lyricsView;
let scrub;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function inRound() {
  const game = getGame();
  return Boolean(game && ROUND_PHASES.has(game.phase));
}

function currentPosition() {
  const game = getGame();
  if (game?.phase === 'playing' && !s.needsReload && !s.starting) {
    const pos = playback.getPosition();
    if (pos.current) return pos.positionMs;
  }
  return s.positionMs;
}

// ---- Rendering ---------------------------------------------------------------------------

function loadRound(game) {
  const { played, lyrics } = currentPair();
  r.progress.textContent = songProgress(game.round, game.songs.length);
  r.title.textContent = played.name;
  r.artist.textContent = played.artists.join(', ');
  lyricsView.applySavedSize();
  lyricsView.setText(lyrics.lyrics);

  s.durationMs = played.durationMs;
  s.stretches = played.instrumentalStretches ?? [];
  scrub.setDuration(s.durationMs);
  scrub.setStretches(s.stretches);
  r.legend.hidden = s.stretches.length === 0;
  r.total.textContent = formatTime(s.durationMs);

  s.positionMs = game.positionMs ?? 0;
  scrub.setPosition(s.positionMs);
  s.needsReload = true;
  s.playToken++;
  setStarting(false);
  clearNotice();
  hideEnded();
  s.key = `${game.id}:${game.round}`;
  const ratio = game.lyricsScrollRatio ?? 0;
  requestAnimationFrame(() => lyricsView.setScrollRatio(ratio));
}

function updateControls() {
  const phase = getGame()?.phase;
  const playing = phase === 'playing';
  r.play.classList.toggle('is-playing', playing && !s.starting);
  r.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  r.pausedLabel.hidden = phase !== 'paused';
}

function setControlsEnabled(on) {
  s.controlsEnabled = on;
  for (const button of [r.back10, r.play, r.fwd10, r.skip, r.gotIt, r.menu]) button.disabled = !on;
  scrub.setEnabled(on);
}

function setStarting(on) {
  s.starting = on;
  r.play.classList.toggle('is-busy', on);
  r.starting.textContent = on ? 'Starting...' : '';
  if (!on) clearTimeout(s.slowTimer);
  updateControls();
}

/**
 * Shows a message over the bottom of the lyrics.
 * @param {string} kind identifies the notice so it can be cleared selectively
 * @param {{label: string, onClick?: () => void, href?: string, primary?: boolean}[]} [buttons]
 */
function showNotice(kind, text, buttons = [], subtext = '') {
  s.noticeKind = kind;
  r.noticeText.textContent = text;
  r.noticeActions.replaceChildren(...buttons.map((b) => {
    const el = document.createElement(b.href ? 'a' : 'button');
    el.className = `btn ${b.primary ? 'btn--primary' : 'btn--secondary'}`;
    el.textContent = b.label;
    if (b.href) el.href = b.href;
    else el.type = 'button';
    if (b.onClick) el.addEventListener('click', b.onClick);
    return el;
  }));
  if (subtext) {
    const p = document.createElement('p');
    p.className = 'small muted';
    p.textContent = subtext;
    r.noticeActions.append(p);
  }
  r.notice.hidden = false;
}

function clearNotice(kind) {
  if (kind && s.noticeKind !== kind) return;
  s.noticeKind = null;
  r.notice.hidden = true;
  s.waitController?.abort();
  s.waitController = null;
}

function showEnded() {
  r.ended.hidden = false;
  r.skipStretch.hidden = true;
}

function hideEnded() {
  r.ended.hidden = true;
}

function updateSkipPill() {
  const phase = getGame()?.phase;
  const sec = s.positionMs / 1000;
  const stretch = (phase === 'playing' || phase === 'paused') && s.controlsEnabled
    ? s.stretches.find((st) => sec >= st.start && sec < st.end && st.end - sec > 5)
    : null;
  if (!stretch) {
    r.skipStretch.hidden = true;
    return;
  }
  r.skipStretch.textContent = stretch.start === 0 ? 'Skip intro' : 'Skip instrumental';
  r.skipStretch.dataset.target = String(Math.max(0, (stretch.end - 1) * 1000));
  r.skipStretch.hidden = false;
}

let lastElapsedText = '';
function frame() {
  if (!s.visible) return;
  const game = getGame();
  if (game?.phase === 'playing' && !s.needsReload && !s.starting) {
    const pos = playback.getPosition();
    if (pos.current) s.positionMs = pos.positionMs;
  }
  scrub.setPosition(s.positionMs);
  const text = formatTime(s.positionMs);
  if (text !== lastElapsedText) {
    r.elapsed.textContent = text;
    lastElapsedText = text;
  }
  updateSkipPill();
  s.frame = requestAnimationFrame(frame);
}

// ---- Countdown -----------------------------------------------------------------------------

function runCountdown() {
  clearInterval(s.countdownTimer);
  setControlsEnabled(false);
  r.countdown.hidden = false;
  r.countdown.classList.remove('is-leaving');
  let n = 3;
  const tick = () => {
    r.countNum.textContent = String(n);
    r.countNum.classList.remove('is-ticking');
    void r.countNum.offsetWidth; // restart the animation
    r.countNum.classList.add('is-ticking');
    vibrate(PATTERNS.tick);
  };
  tick();
  s.countdownTimer = setInterval(() => {
    n--;
    if (n > 0) tick();
    else finishCountdown();
  }, 1000);
}

function stopCountdown() {
  clearInterval(s.countdownTimer);
  s.countdownTimer = null;
  r.countdown.hidden = true;
  setControlsEnabled(true);
}

function finishCountdown() {
  clearInterval(s.countdownTimer);
  s.countdownTimer = null;
  r.countdown.classList.add('is-leaving');
  setTimeout(() => {
    r.countdown.hidden = true;
  }, 300);
  setControlsEnabled(true);
  actions.startPlaying();
  startPlayback(0);
}

function cancelCountdown() {
  stopCountdown();
  actions.cancelCountdown();
  go('pass');
}

// ---- Playback ------------------------------------------------------------------------------

async function startPlayback(positionMs) {
  const pair = currentPair();
  if (!pair) return;
  clearNotice();
  hideEnded();
  s.positionMs = positionMs;
  scrub.setPosition(positionMs);
  s.lastCommandAt = performance.now();
  setStarting(true);
  s.slowTimer = setTimeout(() => {
    if (!s.starting) return;
    showNotice('slow', 'Spotify is taking a while.', [
      { label: 'Retry', primary: true, onClick: () => { playback.unlock(); startPlayback(s.positionMs); } },
    ]);
  }, SLOW_START_MS);

  const token = ++s.playToken;
  try {
    await playback.playTrack(pair.played.uri, positionMs);
    if (token !== s.playToken) {
      // Got It!, Skip or a new round happened while Spotify was starting.
      if (getGame()?.phase !== 'playing') playback.pause().catch(() => {});
      return;
    }
    s.needsReload = false;
    s.generation = playback.generation;
  } catch (err) {
    if (token !== s.playToken) return;
    handlePlayError(err);
  }
}

function pausePlayback() {
  s.positionMs = currentPosition();
  actions.pause(s.positionMs);
  clearTimeout(s.resumeTimer);
  s.lastCommandAt = performance.now();
  updateControls();
  if (!s.needsReload && !s.starting) playback.pause().catch(handleCommandError);
  if (s.starting) {
    s.playToken++;
    s.needsReload = true;
    setStarting(false);
  }
}

function resumePlayback() {
  clearNotice();
  actions.resume();
  updateControls();
  if (s.needsReload || playback.generation !== s.generation) {
    startPlayback(s.positionMs);
    return;
  }
  s.lastCommandAt = performance.now();
  playback.resume().catch(handleCommandError);
  watchResume();
}

/** If the music does not actually start after a resume, ask for another tap. */
function watchResume() {
  clearTimeout(s.resumeTimer);
  s.resumeTimer = setTimeout(() => {
    const pos = playback.getPosition();
    if (getGame()?.phase === 'playing' && !s.starting && (pos.paused || !pos.current)) needTap();
  }, RESUME_CHECK_MS);
}

function needTap(text = 'Tap play to continue.') {
  s.positionMs = currentPosition();
  if (getGame()?.phase === 'playing') actions.pause(s.positionMs);
  s.needsReload = true;
  setStarting(false);
  updateControls();
  showNotice('tap', text);
}

function togglePlay() {
  const game = getGame();
  if (!game || s.starting) return;
  if (game.phase === 'playing') {
    pausePlayback();
    return;
  }
  playback.unlock();
  if (game.phase === 'ended') playFrom(0);
  else resumePlayback();
}

function playFrom(ms) {
  hideEnded();
  playback.unlock();
  actions.resume();
  updateControls();
  startPlayback(ms);
}

function seekTo(ms) {
  const game = getGame();
  if (!game || !s.controlsEnabled) return;
  const target = clamp(ms, 0, Math.max(0, s.durationMs - 500));
  s.positionMs = target;
  actions.setPosition(target);
  scrub.setPosition(target);
  if (game.phase === 'ended') {
    playFrom(target);
    return;
  }
  if (s.needsReload || s.starting) {
    if (game.phase === 'playing') startPlayback(target);
    return;
  }
  s.lastCommandAt = performance.now();
  playback.seek(target).catch(handleCommandError);
}

function seekBy(deltaMs) {
  seekTo(currentPosition() + deltaMs);
}

// ---- Round endings ---------------------------------------------------------------------------

function gotIt() {
  const game = getGame();
  if (!game || !inRound()) return;
  const wasPlaying = game.phase === 'playing';
  s.positionMs = currentPosition();
  if (s.starting) {
    s.playToken++;
    s.needsReload = true;
    setStarting(false);
  } else if (wasPlaying && !s.needsReload) {
    playback.pause().catch(() => {});
  }
  clearTimeout(s.resumeTimer);
  confetti();
  vibrate(PATTERNS.gotIt);
  actions.gotIt({ positionMs: s.positionMs, wasPlaying, lyricsScrollRatio: lyricsView.getScrollRatio() });
  go('reveal');
}

function leaveRound({ toastText }) {
  s.playToken++;
  clearTimeout(s.resumeTimer);
  setStarting(false);
  playback.pause().catch(() => {});
  if (toastText) toast(toastText);
  const over = actions.skip();
  go(over ? 'game-over' : 'pass');
}

function skipSong() {
  if (!inRound()) return;
  vibrate(PATTERNS.skip);
  leaveRound({ toastText: 'Skipped' });
}

function trackWontPlay() {
  if (!inRound()) return;
  leaveRound({ toastText: "This song won't play right now. Skipping it." });
}

function revealFromEnded() {
  if (actions.reveal()) go('reveal');
}

// ---- Engine events and errors ------------------------------------------------------------------

function onState(pos) {
  const game = getGame();
  if (!game || !ROUND_PHASES.has(game.phase) || !pos.current) return;
  if (s.starting && !pos.paused) {
    setStarting(false);
    clearNotice('slow');
  }
  // Keep in step with pauses and plays from outside KaraoKry (lock screen, notification).
  const settled = performance.now() - s.lastCommandAt > COMMAND_GRACE_MS;
  if (settled && !s.starting && !s.needsReload) {
    if (game.phase === 'playing' && pos.paused) {
      s.positionMs = pos.positionMs;
      actions.pause(pos.positionMs);
    } else if (game.phase === 'paused' && !pos.paused) {
      actions.resume();
      clearNotice();
    }
  }
  updateControls();
}

function onEnded() {
  const game = getGame();
  if (!game || (game.phase !== 'playing' && game.phase !== 'paused')) return;
  s.positionMs = s.durationMs;
  setStarting(false);
  clearTimeout(s.resumeTimer);
  clearNotice();
  actions.songEnded(s.durationMs);
  showEnded();
  updateControls();
}

function onInterrupted() {
  s.needsReload = true;
  if (getGame()?.phase !== 'playing') return;
  needTap('Playback was interrupted. Tap play to continue.');
}

function onEngineError(err) {
  if (err.kind === 'premium') {
    premiumRequired();
    return;
  }
  if (err.kind === 'auth') {
    loginExpired();
    return;
  }
  if (!inRound()) {
    if (err.kind === 'not_ready') s.needsReload = true;
    return;
  }
  switch (err.kind) {
    case 'autoplay':
      showNotice('autoplay', 'The browser paused the music.', [{
        label: 'Tap to start the music',
        primary: true,
        onClick: () => {
          playback.unlock();
          clearNotice();
          playback.resume().catch(handleCommandError);
          watchResume();
        },
      }]);
      break;
    case 'not_ready':
      s.needsReload = true;
      toast('Connection lost, trying again...', { id: 'connection' });
      showNotice('reconnecting', 'Reconnecting...');
      break;
    case 'reconnected':
      clearNotice('reconnecting');
      if (getGame()?.phase === 'playing') needTap();
      break;
    case 'network':
      toast('Connection lost, trying again...', { id: 'connection' });
      break;
    case 'engine-failed':
      needTap();
      showNotice('engine', "Couldn't play inside KaraoKry on this phone. Try “Use the Spotify app” in Settings.", [
        { label: 'Open Settings', primary: true, onClick: () => go('settings') },
      ]);
      break;
    default:
      break;
  }
}

function handlePlayError(err) {
  setStarting(false);
  if (err?.name === 'AbortError') return;
  recordError('play', err);
  if (err instanceof PremiumRequiredError) {
    premiumRequired();
    return;
  }
  if (err instanceof AuthRequiredError) {
    loginExpired();
    return;
  }
  if (err instanceof TrackUnplayableError) {
    trackWontPlay();
    return;
  }
  if (err instanceof NeedsSpotifyAppError) {
    wakeSpotify();
    return;
  }
  // Stay on the round, paused, so the next tap on play retries.
  s.needsReload = true;
  if (getGame()?.phase === 'playing') actions.pause(s.positionMs);
  updateControls();
  if (err instanceof EngineUnavailableError) {
    showNotice('engine', "Couldn't start the music inside KaraoKry on this phone.", [
      { label: 'Try again', primary: true, onClick: () => { playback.unlock(); resumePlayback(); } },
      { label: 'Open Settings', onClick: () => go('settings') },
    ]);
  } else if (err instanceof SpotifyError && err.code === 'network') {
    toast('Connection lost, trying again...', { id: 'connection' });
    showNotice('tap', 'Tap play to continue.');
  } else if (err instanceof SpotifyError && err.code === 'rate_limited') {
    toast('Spotify is busy. Try again in a moment.');
  } else {
    toast('Spotify had a hiccup. Try again.');
  }
}

function handleCommandError(err) {
  if (err instanceof PremiumRequiredError) {
    premiumRequired();
  } else if (err instanceof AuthRequiredError) {
    loginExpired();
  } else if (err instanceof SpotifyError && err.code === 'network') {
    toast('Connection lost, trying again...', { id: 'connection' });
    s.needsReload = true;
  } else {
    recordError('player command', err);
    s.needsReload = true;
  }
}

/** Connect engine: the Spotify app is not running, so ask for it and wait. */
function wakeSpotify() {
  s.needsReload = true;
  if (getGame()?.phase === 'playing') actions.pause(s.positionMs);
  updateControls();
  showNotice('wake', 'KaraoKry needs the Spotify app open for a moment.', [
    { label: 'Open Spotify', primary: true, href: 'spotify:' },
  ], 'Then come straight back here.');
  const controller = new AbortController();
  s.waitController = controller;
  playback.waitForSpotifyApp({ signal: controller.signal }).then((found) => {
    if (controller.signal.aborted) return;
    s.waitController = null;
    if (!found) {
      showNotice('tap', "Couldn't find the Spotify app. Open it, then tap play.");
      return;
    }
    clearNotice();
    if (getGame()?.phase === 'paused') resumePlayback();
  }).catch((err) => {
    if (err instanceof PremiumRequiredError) premiumRequired();
  });
}

// ---- Menu ---------------------------------------------------------------------------------------

async function openMenu({ fromBack = false } = {}) {
  const game = getGame();
  if (!game) return;
  if (fromBack && game.phase === 'playing') pausePlayback();
  const items = [];
  if (getGame().phase === 'paused') items.push({ label: 'Resume', value: 'resume' });
  items.push({ label: 'Skip this song', value: 'skip' }, { label: 'End game', value: 'end', danger: true });
  if (!fromBack) items.push({ label: 'Settings', value: 'settings' }, { label: 'How to play', value: 'howto' });
  const choice = await menuSheet(items);
  if (getGame() !== game) return;
  if (choice === 'resume' && game.phase === 'paused') {
    playback.unlock();
    resumePlayback();
  } else if (choice === 'skip') {
    skipSong();
  } else if (choice === 'end') {
    confirmEndGame();
  } else if (choice === 'settings') {
    go('settings');
  } else if (choice === 'howto') {
    go('how-to');
  }
}

// ---- Screen ---------------------------------------------------------------------------------------

export default {
  id: 'round',

  init(el) {
    r = refs(el);
    lyricsView = new LyricsView(r.lyrics, { onScroll: (ratio) => actions.setLyricsScroll(ratio) });
    scrub = new ScrubBar(r.scrub, { onSeek: (ms) => seekTo(ms) });

    r.back10.addEventListener('click', () => seekBy(-SEEK_STEP_MS));
    r.fwd10.addEventListener('click', () => seekBy(SEEK_STEP_MS));
    r.play.addEventListener('click', () => togglePlay());
    r.gotIt.addEventListener('click', () => gotIt());
    r.menu.addEventListener('click', () => openMenu());
    r.reveal.addEventListener('click', () => revealFromEnded());
    r.again.addEventListener('click', () => playFrom(0));
    r.skipStretch.addEventListener('click', () => seekTo(Number(r.skipStretch.dataset.target)));
    longPress(r.skip, {
      duration: HOLD_TO_SKIP_MS,
      onComplete: () => skipSong(),
      onCancel: () => toast('Hold to skip', { id: 'hold' }),
    });

    playback.on('state', onState);
    playback.on('ended', onEnded);
    playback.on('interrupted', onInterrupted);
    playback.on('error', onEngineError);
    playback.on('track-error', () => trackWontPlay());
    playback.on('switched', () => toast('Using the Spotify app for playback on this phone.'));
    playback.on('replay', () => {
      if (getGame()?.phase === 'playing') startPlayback(currentPosition());
      else s.needsReload = true;
    });

    // Selfie preview of the singer while they are filmed, with a blinking REC dot.
    onStreamChange((stream) => {
      r.selfieVideo.srcObject = stream;
      r.selfie.hidden = !stream;
      if (stream) r.selfieVideo.play().catch(() => {});
    });
    onRecordingChange((recording) => r.selfie.classList.toggle('is-recording', recording));

    setSnapshotProvider(() => {
      const game = getGame();
      if (!game || !s.key || s.key !== `${game.id}:${game.round}`) return;
      if (ROUND_PHASES.has(game.phase)) actions.setPosition(currentPosition());
      if (s.visible) actions.setLyricsScroll(lyricsView.getScrollRatio());
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !s.visible) return;
      // Coming back from the background: the browser may have stopped the audio.
      if (getGame()?.phase === 'playing' && !s.needsReload && !s.starting) {
        setTimeout(() => {
          const pos = playback.getPosition();
          if (s.visible && getGame()?.phase === 'playing' && !s.starting && (pos.paused || !pos.current)) needTap();
        }, VISIBLE_CHECK_MS);
      }
    });
  },

  show(params = {}) {
    const game = getGame();
    if (!game) {
      go('picker');
      return;
    }
    s.visible = true;
    if (`${game.id}:${game.round}` !== s.key) loadRound(game);
    lyricsView.applySavedSize();

    if (params.countdown) {
      runCountdown();
    } else {
      if (params.resumed) {
        s.positionMs = game.positionMs ?? 0;
        s.needsReload = true;
        if (game.phase === 'ended') showEnded();
      }
      if (playback.generation !== s.generation && !s.needsReload) {
        // The engine changed (for example in Settings) while this round was open.
        s.needsReload = true;
        if (game.phase === 'playing') needTap();
      }
      if (params.fromReveal && game.phase === 'playing') resumePlayback();
    }
    updateControls();

    cancelAnimationFrame(s.frame);
    s.frame = requestAnimationFrame(frame);
    clearInterval(s.saveTimer);
    s.saveTimer = setInterval(() => {
      if (getGame()?.phase === 'playing') saveSnapshot();
    }, SAVE_EVERY_MS);
  },

  hide() {
    saveSnapshot();
    s.visible = false;
    cancelAnimationFrame(s.frame);
    clearInterval(s.saveTimer);
    if (s.countdownTimer) stopCountdown();
  },

  back() {
    if (s.countdownTimer) cancelCountdown();
    else openMenu({ fromBack: true });
  },
};
