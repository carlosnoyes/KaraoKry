// Game state machine, rounds and persistence. No DOM access here: screens read
// state with getGame()/currentPair() and change it through `actions`.
// Keeping it this way makes a future scoring or teams mode easy to add.

import { kvGet, kvSet, kvDelete } from './storage.js';

export const GAME_KEY = 'game:current';
export const SCHEMA = 1;
export const PHASES = ['pass', 'countdown', 'playing', 'paused', 'ended', 'reveal', 'over'];

// Allowed phase changes (spec section 11.8). Skip and End game are also allowed
// from `ended`, because the round menu stays available after a song finishes, and
// a song may end while paused when the pause reached Spotify too late.
const TRANSITIONS = {
  pass: ['countdown', 'over'],
  countdown: ['playing', 'pass', 'over'],
  playing: ['paused', 'ended', 'reveal', 'pass', 'over'],
  paused: ['playing', 'ended', 'reveal', 'pass', 'over'],
  ended: ['playing', 'reveal', 'pass', 'over'],
  reveal: ['pass', 'over', 'playing', 'paused'],
  over: [],
};

let game = null;
const listeners = new Set();

/** Round i plays songs[i] and shows the lyrics of songs[(i - 1 + N) % N]. */
export function lyricsIndexFor(round, count) {
  return (round - 1 + count) % count;
}

export function pairFor(songs, round) {
  return { played: songs[round], lyrics: songs[lyricsIndexFor(round, songs.length)] };
}

export function getGame() {
  return game;
}

export function currentPair() {
  return game ? pairFor(game.songs, game.round) : null;
}

export function isLastRound() {
  return Boolean(game) && game.round >= game.songs.length - 1;
}

export function onGameChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(game);
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- Persistence -------------------------------------------------------------------

function serialize(g) {
  const { schema, id, savedAt, userId, clientId, playlist, songs, round, phase, positionMs, wasPlaying,
    lyricsScrollRatio, roundsPlayed, roundStarted } = g;
  return { schema, id, savedAt, userId, clientId, playlist, songs, round, phase, positionMs, wasPlaying,
    lyricsScrollRatio, roundsPlayed, roundStarted };
}

/** Saves the current game. Never saves a finished game. */
export function save() {
  if (!game || game.phase === 'over') return Promise.resolve(false);
  game.savedAt = new Date().toISOString();
  return kvSet(GAME_KEY, serialize(game)).catch(() => false);
}

export function isValidSavedGame(saved) {
  return Boolean(saved)
    && saved.schema === SCHEMA
    && Array.isArray(saved.songs)
    && saved.songs.length >= 3
    && saved.songs.every((song) => song?.uri && typeof song.lyrics === 'string')
    && Number.isInteger(saved.round)
    && saved.round >= 0
    && saved.round < saved.songs.length
    && PHASES.includes(saved.phase)
    && saved.phase !== 'over';
}

export async function loadSavedGame() {
  try {
    const saved = await kvGet(GAME_KEY);
    return isValidSavedGame(saved) ? saved : null;
  } catch {
    return null;
  }
}

export function deleteSavedGame() {
  return kvDelete(GAME_KEY).catch(() => {});
}

// ---- Lifecycle -------------------------------------------------------------------

/** Starts a new game with a locked song order and saves it straight away. */
export function newGame({ userId, clientId, playlist, songs }) {
  game = {
    schema: SCHEMA,
    id: randomId(),
    savedAt: new Date().toISOString(),
    userId,
    clientId,
    playlist,
    songs,
    round: 0,
    phase: 'pass',
    positionMs: 0,
    wasPlaying: false,
    lyricsScrollRatio: 0,
    roundsPlayed: 0,
    roundStarted: false,
  };
  save();
  emit();
  return game;
}

/**
 * Adopts a saved game after a restart. A round that was mid-song comes back paused,
 * and a countdown comes back as the pass-the-phone screen.
 */
export function resumeGame(saved) {
  game = { id: randomId(), roundStarted: false, ...saved };
  if (game.phase === 'countdown') game.phase = 'pass';
  if (game.phase === 'playing') game.phase = 'paused';
  save();
  emit();
  return game;
}

/** Forgets the in-memory game (the saved copy is handled separately). */
export function clearGame() {
  game = null;
  emit();
}

function transition(phase, patch = {}) {
  if (!game) return false;
  if (!TRANSITIONS[game.phase]?.includes(phase)) return false;
  Object.assign(game, patch, { phase });
  save();
  emit();
  return true;
}

function startedRounds() {
  return game.round + (game.roundStarted ? 1 : 0);
}

function finishRound() {
  game.roundsPlayed = Math.max(game.roundsPlayed, game.round + 1);
  if (isLastRound()) return transition('over');
  return transition('pass', {
    round: game.round + 1,
    positionMs: 0,
    wasPlaying: false,
    lyricsScrollRatio: 0,
    roundStarted: false,
  });
}

export const actions = {
  /** "I'm ready" on Pass the phone. */
  ready() {
    return transition('countdown', { positionMs: 0, wasPlaying: false, lyricsScrollRatio: 0 });
  },
  /** Back during the countdown. */
  cancelCountdown() {
    return transition('pass');
  },
  /** The countdown finished and the song is starting. */
  startPlaying() {
    if (!game) return false;
    game.roundStarted = true;
    game.roundsPlayed = Math.max(game.roundsPlayed, game.round + 1);
    return transition('playing', { positionMs: 0 });
  },
  pause(positionMs = game?.positionMs ?? 0) {
    return transition('paused', { positionMs });
  },
  resume() {
    return transition('playing');
  },
  songEnded(positionMs = game?.positionMs ?? 0) {
    return transition('ended', { positionMs });
  },
  /** "Got It!": remembers whether the music was playing so Go back can resume it. */
  gotIt({ positionMs, wasPlaying, lyricsScrollRatio }) {
    return transition('reveal', {
      positionMs,
      wasPlaying: Boolean(wasPlaying),
      lyricsScrollRatio: lyricsScrollRatio ?? game?.lyricsScrollRatio ?? 0,
    });
  },
  /** "Reveal" on the end-of-song overlay. */
  reveal() {
    return transition('reveal', { wasPlaying: false });
  },
  /** "Go back" on the reveal screen. */
  goBack() {
    if (!game) return false;
    return transition(game.wasPlaying ? 'playing' : 'paused');
  },
  /** "Next singer" or "Finish". Returns true when the game is now over. */
  next() {
    if (!game) return false;
    finishRound();
    return game.phase === 'over';
  },
  /** Held skip. The skipped round still counts as played. Returns true when the game is now over. */
  skip() {
    if (!game) return false;
    finishRound();
    return game.phase === 'over';
  },
  /** "End game" from a menu. */
  end() {
    if (!game) return false;
    game.roundsPlayed = Math.max(game.roundsPlayed, startedRounds());
    return transition('over');
  },
  /** Position and scroll updates are kept in memory and written by the next save. */
  setPosition(positionMs) {
    if (game) game.positionMs = Math.max(0, Math.round(positionMs));
  },
  setLyricsScroll(ratio) {
    if (game) game.lyricsScrollRatio = Math.min(1, Math.max(0, ratio));
  },
};
