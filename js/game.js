// Game state machine, rounds and persistence. No DOM access here: screens read
// state with getGame()/currentPair() and change it through `actions`.
// Keeping it this way makes a future scoring or teams mode easy to add.

import { kvGet, kvSet, kvDelete } from './storage.js';

export const GAME_KEY = 'game:current';
export const SCHEMA = 2;
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

// ---- Songs and their lyrics ------------------------------------------------------------
// A game holds every playable song of the playlist, in the shuffled order. Lyrics are
// looked up a few songs ahead while the game goes on: each song gets `checked: true`
// and `lyrics` (null when none were found). The last song always has lyrics, because
// round 0 shows them.

export function hasLyrics(song) {
  return typeof song?.lyrics === 'string' && song.lyrics.length > 0;
}

/** Stores a lyrics lookup result on a song. */
export function storeLyrics(song, found) {
  const ok = Boolean(found?.found && found.lyrics);
  song.checked = true;
  song.lyrics = ok ? found.lyrics : null;
  song.instrumentalStretches = ok ? (found.instrumentalStretches ?? []) : [];
}

/**
 * The song whose lyrics round `round` shows. Round 0 shows the last song's. Every
 * other round shows the song played just before; when that one has no lyrics, it
 * borrows from a song already played (the one shown least often, then the one shown
 * longest ago). Songs still to come are never used, except the last song when no
 * played song has lyrics: round 0 showed its lyrics already. The song being played
 * is never used.
 * @param {object[]} songs the play order
 * @param {(string|null)[]} sung the ids of the lyrics shown in earlier rounds
 * @returns {object|null}
 */
export function chooseLyrics(songs, round, sung = []) {
  const last = songs[songs.length - 1];
  const played = songs[round];
  if (round === 0) return hasLyrics(last) && last !== played ? last : null;
  const previous = songs[round - 1];
  if (hasLyrics(previous)) return previous;

  const candidates = songs.slice(0, round).filter(hasLyrics);
  if (!candidates.length) return hasLyrics(last) && last !== played ? last : null;
  const earlier = sung.slice(0, round);
  const timesShown = (song) => earlier.filter((id) => id === song.id).length;
  const lastShown = (song) => earlier.lastIndexOf(song.id);
  return candidates.reduce((best, song) => {
    const diff = timesShown(song) - timesShown(best) || lastShown(song) - lastShown(best);
    return diff < 0 ? song : best;
  });
}

/**
 * Stores a lyrics result for the song with this id. A song still to come that has no
 * lyrics moves to the back, just before the last song, so the songs with lyrics play
 * first and the round after each of them has fresh lyrics.
 * @returns {boolean} whether the song was found
 */
export function placeLyrics(songs, round, id, found) {
  const index = songs.findIndex((song) => song.id === id);
  if (index < 0) return false;
  const song = songs[index];
  storeLyrics(song, found);
  if (!hasLyrics(song) && index > round && index < songs.length - 2) {
    songs.splice(index, 1);
    songs.splice(songs.length - 1, 0, song);
  }
  return true;
}

/** Songs from the current round up to `ahead` songs later whose lyrics are not checked yet. */
export function songsToCheck(g, ahead) {
  if (!g) return [];
  return g.songs.slice(g.round, g.round + ahead + 1).filter((song) => !song.checked);
}

export function getGame() {
  return game;
}

// Only when no song played so far has lyrics and the last song is the one playing.
const NO_LYRICS = { name: '', artists: [], lyrics: 'No lyrics for this one.\n\nMake up your own words!' };

export function currentPair() {
  if (!game) return null;
  const id = game.sung?.[game.round];
  const lyrics = (id && game.songs.find((song) => song.id === id))
    || chooseLyrics(game.songs, game.round, game.sung)
    || NO_LYRICS;
  return { played: game.songs[game.round], lyrics };
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
  const { schema, id, savedAt, userId, clientId, playlist, songs, sung, round, phase, positionMs, wasPlaying,
    lyricsScrollRatio, roundsPlayed, roundStarted } = g;
  return { schema, id, savedAt, userId, clientId, playlist, songs, sung, round, phase, positionMs, wasPlaying,
    lyricsScrollRatio, roundsPlayed, roundStarted };
}

/** Saves the current game. Never saves a finished game. */
export function save() {
  if (!game || game.phase === 'over') return Promise.resolve(false);
  game.savedAt = new Date().toISOString();
  return kvSet(GAME_KEY, serialize(game)).catch(() => false);
}

/**
 * Schema 1 games (before 1.2.0) had lyrics for every song and no `sung` list. Their
 * pairing is what chooseLyrics gives for such a game, so they carry on unchanged.
 */
function upgrade(saved) {
  if (saved.schema !== 1) return saved;
  const songs = saved.songs.map((song) => ({ ...song, checked: true }));
  const sung = [];
  for (let round = 0; round <= saved.round; round++) sung.push(chooseLyrics(songs, round, sung)?.id ?? null);
  return { ...saved, schema: SCHEMA, songs, sung };
}

export function isValidSavedGame(saved) {
  return Boolean(saved)
    && (saved.schema === SCHEMA || saved.schema === 1)
    && Array.isArray(saved.songs)
    && saved.songs.length >= 3
    && saved.songs.every((song) => song?.uri && (song.lyrics == null || typeof song.lyrics === 'string'))
    && (saved.schema === SCHEMA ? Array.isArray(saved.sung) : saved.songs.every(hasLyrics))
    && hasLyrics(saved.songs[saved.songs.length - 1])
    && Number.isInteger(saved.round)
    && saved.round >= 0
    && saved.round < saved.songs.length
    && PHASES.includes(saved.phase)
    && saved.phase !== 'over';
}

export async function loadSavedGame() {
  try {
    const saved = await kvGet(GAME_KEY);
    return isValidSavedGame(saved) ? upgrade(saved) : null;
  } catch {
    return null;
  }
}

export function deleteSavedGame() {
  return kvDelete(GAME_KEY).catch(() => {});
}

// ---- Lifecycle -------------------------------------------------------------------

/**
 * Starts a new game and saves it straight away. `songs` is the shuffled order; its
 * last song must have lyrics (see arrangeSongs in prepare.js).
 */
export function newGame({ userId, clientId, playlist, songs }) {
  game = {
    schema: SCHEMA,
    id: randomId(),
    savedAt: new Date().toISOString(),
    userId,
    clientId,
    playlist,
    songs,
    sung: [chooseLyrics(songs, 0)?.id ?? null],
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
  game = { id: randomId(), roundStarted: false, ...upgrade(saved) };
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
  const round = game.round + 1;
  const sung = (game.sung ?? []).slice(0, round);
  sung[round] = chooseLyrics(game.songs, round, sung)?.id ?? null;
  return transition('pass', {
    round,
    sung,
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
  /** A background lyrics lookup finished. Saved, but not announced: no screen needs it. */
  lyricsChecked(id, found) {
    if (!game || game.phase === 'over') return false;
    const ok = placeLyrics(game.songs, game.round, id, found);
    if (ok) save();
    return ok;
  },
};
