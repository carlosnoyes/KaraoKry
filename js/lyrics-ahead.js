// Looks up lyrics in the background while a game is on, always a few songs ahead of
// the current round, so nobody waits for them. LRCLIB trouble only pauses it for a
// while: a round whose previous song has no lyrics borrows another song's instead.

import { getGame, onGameChange, actions, songsToCheck, hasLyrics } from './game.js';
import { getLyrics, LyricsNetworkError } from './lyrics.js';
import { setDebug, recordError } from './debug.js';

export const AHEAD = 10;
const CONCURRENCY = 2;
const RETRY_MS = 30_000;
// A song whose lookup fails this many times is left unchecked for the rest of the
// game, so one song LRCLIB keeps failing on cannot hold up the songs after it.
const MAX_TRIES = 2;

let lookup = getLyrics;
let retryMs = RETRY_MS;
let run = null; // { game, controller, busy: Set of song ids, failures: Map id -> count, pausedUntil, timer }

/** Call once at startup. The options are for tests. */
export function initLyricsAhead({ lookupLyrics = getLyrics, retryAfterMs = RETRY_MS } = {}) {
  lookup = lookupLyrics;
  retryMs = retryAfterMs;
  onGameChange(() => pump());
  pump();
}

function stopRun() {
  if (!run) return;
  run.controller.abort();
  clearTimeout(run.timer);
  run = null;
}

function pump() {
  const game = getGame();
  if (!game || game.phase === 'over') {
    stopRun();
    return;
  }
  if (run?.game !== game) {
    stopRun();
    run = { game, controller: new AbortController(), busy: new Set(), failures: new Map(), pausedUntil: 0, timer: null };
  }
  const current = run;
  if (Date.now() >= current.pausedUntil) {
    for (const song of songsToCheck(game, AHEAD)) {
      if (current.busy.size >= CONCURRENCY) break;
      if (!current.busy.has(song.id) && (current.failures.get(song.id) ?? 0) < MAX_TRIES) check(current, song);
    }
  }
  report(game);
}

async function check(current, song) {
  current.busy.add(song.id);
  try {
    const found = await lookup(song, { signal: current.controller.signal });
    if (run === current) actions.lyricsChecked(song.id, found);
  } catch (err) {
    if (err?.name === 'AbortError' || run !== current) return;
    if (err instanceof LyricsNetworkError) {
      // Try again later. Until then, rounds borrow lyrics if they need to.
      current.failures.set(song.id, (current.failures.get(song.id) ?? 0) + 1);
      current.pausedUntil = Date.now() + retryMs;
      clearTimeout(current.timer);
      current.timer = setTimeout(() => {
        if (run === current) pump();
      }, retryMs);
    } else {
      recordError('lyrics', err);
      actions.lyricsChecked(song.id, { found: false });
    }
  } finally {
    current.busy.delete(song.id);
    if (run === current) pump();
  }
}

function report(game) {
  const checked = game.songs.filter((song) => song.checked);
  const ahead = game.songs.slice(game.round + 1, game.round + 1 + AHEAD).filter((song) => song.checked).length;
  const gaveUp = [...run.failures.values()].filter((count) => count >= MAX_TRIES).length;
  setDebug('lyricsAhead', `${checked.length} of ${game.songs.length} checked, ${checked.filter(hasLyrics).length} with lyrics; `
    + `next ${AHEAD}: ${ahead} checked${gaveUp ? `; ${gaveUp} failed twice` : ''}`
    + `${Date.now() < run.pausedUntil ? '; paused after a network error' : ''}`);
}
