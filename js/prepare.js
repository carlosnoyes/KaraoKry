// Game preparation: playlist entries -> filtered tracks -> shuffled order -> lyrics for
// the first few songs. The rest are looked up during the game (lyrics-ahead.js).
// Nothing here touches the DOM.

import { readPlaylistItems } from './playlists.js';
import { getLyrics, cleanTitle, foldText, LyricsNetworkError } from './lyrics.js';
import { hasLyrics, storeLyrics } from './game.js';

export const MIN_SONGS = 3;
export const MIN_DURATION_MS = 60_000;
export const LYRICS_CONCURRENCY = 4;
export const MAX_CONSECUTIVE_NETWORK_FAILURES = 5;
// Songs with lyrics found before the game starts: one for round 0 (it goes to the end
// of the order), and a few to play first. The rest are found while the game goes on.
export const START_WITH_LYRICS = 4;

export class PrepareError extends Error {
  /** @param {'too_few'|'no_lyrics'|'lyrics_down'} code */
  constructor(code, details = {}) {
    super(code);
    this.name = 'PrepareError';
    this.code = code;
    Object.assign(this, details);
  }
}

function pickImages(images) {
  const list = (Array.isArray(images) ? images : []).filter((img) => img?.url);
  if (!list.length) return { large: null, small: null };
  if (list.every((img) => !img.width)) return { large: list[0].url, small: list[list.length - 1].url };
  const sorted = [...list].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  const upTo640 = sorted.find((img) => (img.width ?? 0) <= 640);
  return { large: (upTo640 ?? sorted[sorted.length - 1]).url, small: sorted[sorted.length - 1].url };
}

export function normalizeTrack(track) {
  const images = pickImages(track.album?.images);
  return {
    id: track.id,
    uri: track.uri,
    name: track.name ?? '',
    artists: (track.artists ?? []).map((artist) => artist?.name).filter(Boolean),
    album: track.album?.name ?? '',
    imageUrl: images.large,
    imageUrlSmall: images.small,
    durationMs: track.duration_ms,
    explicit: Boolean(track.explicit),
  };
}

/**
 * Applies the filters of the spec (section 8.3). Lyrics are not a filter: a song with
 * no lyrics is still played, and its round borrows lyrics from another song.
 * @param {any[]} entries playlist item entries, new ({item}) or old ({track}) shape
 * @returns {{kept: ReturnType<typeof normalizeTrack>[], dropped: {reason: string}[]}}
 */
export function filterTracks(entries) {
  const kept = [];
  const dropped = [];
  const ids = new Set();
  const versions = new Set();

  for (const entry of entries ?? []) {
    const track = entry?.item ?? entry?.track ?? null;
    const drop = (reason) => dropped.push({ reason });
    const uri = String(track?.uri ?? '');
    const type = track?.type ?? (uri.startsWith('spotify:track:') ? 'track' : undefined);

    if (!track) { drop('missing'); continue; }
    if (entry.is_local || track.is_local || uri.startsWith('spotify:local:')) { drop('local'); continue; }
    if (type !== 'track') { drop('not_track'); continue; }
    if (!track.id || !uri) { drop('missing'); continue; }
    if (track.is_playable === false) { drop('unplayable'); continue; }
    if (!(Number(track.duration_ms) >= MIN_DURATION_MS)) { drop('too_short'); continue; }
    if (ids.has(track.id)) { drop('duplicate'); continue; }
    ids.add(track.id);
    const versionKey = `${cleanTitle(track.name)}|${foldText(track.artists?.[0]?.name)}`;
    if (versions.has(versionKey)) { drop('duplicate_version'); continue; }
    versions.add(versionKey);

    kept.push({ ...normalizeTrack(track), checked: false, lyrics: null, instrumentalStretches: [] });
  }
  return { kept, dropped };
}

/** Uniform random integer in [0, n), from crypto.getRandomValues. */
export function randomInt(n) {
  if (!(n >= 1)) throw new RangeError('n must be >= 1');
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % n;
}

/** Fisher-Yates shuffle. Returns a new array. */
export function shuffle(items, rand = randomInt) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function countBy(list, key) {
  const counts = {};
  for (const item of list) counts[item[key]] = (counts[item[key]] ?? 0) + 1;
  return counts;
}

/**
 * The order the game uses: songs with lyrics first, then songs not checked yet, then
 * songs without lyrics, and last the song whose lyrics round 0 shows. That is the
 * first song with lyrics in the shuffle, so it stays a random pick.
 * @param {object[]} order shuffled songs, some of them checked
 */
export function arrangeSongs(order) {
  const ready = order.filter(hasLyrics);
  const opening = ready.shift();
  return [
    ...ready,
    ...order.filter((song) => !song.checked),
    ...order.filter((song) => song.checked && !hasLyrics(song)),
    opening,
  ].filter(Boolean);
}

/**
 * Turns a playlist into a shuffled game order, with lyrics found for the first few
 * songs only, so even a big playlist is ready in seconds.
 * @param {string} playlistId
 * @param {{signal?: AbortSignal, onProgress?: (p: {stage: 'reading'|'lyrics', checked: number, total: number}) => void,
 *          readItems?: typeof readPlaylistItems, lookupLyrics?: typeof getLyrics}} [options]
 * @returns {Promise<{songs: object[], total: number, leftOut: number, reasons: object, checked: number, withLyrics: number}>}
 */
export async function prepareSongs(playlistId, {
  signal,
  onProgress = () => {},
  readItems = readPlaylistItems,
  lookupLyrics = getLyrics,
} = {}) {
  onProgress({ stage: 'reading', checked: 0, total: 0 });
  const entries = await readItems(playlistId, {
    signal,
    onPage: (count, total) => onProgress({ stage: 'reading', checked: count, total }),
  });

  const { kept, dropped } = filterTracks(entries);
  const total = entries.length;
  const reasons = countBy(dropped, 'reason');
  if (kept.length < MIN_SONGS) throw new PrepareError('too_few', { count: kept.length, reasons });

  const order = shuffle(kept);
  const target = Math.min(START_WITH_LYRICS, order.length);
  let withLyrics = 0;
  onProgress({ stage: 'lyrics', checked: 0, total: target });

  const inner = new AbortController();
  const onAbort = () => inner.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  // Songs whose lookup failed on the network go to the back of the queue for one
  // more try. A song that fails twice stays unchecked for the lookups during the game.
  const queue = [...order];
  const retried = new Set();
  let consecutiveFailures = 0;
  let networkFailures = 0;
  const done = () => withLyrics >= target;

  async function worker() {
    while (queue.length && !done()) {
      const song = queue.shift();
      try {
        const found = await lookupLyrics(song, { signal: inner.signal });
        consecutiveFailures = 0;
        storeLyrics(song, found);
        if (hasLyrics(song)) {
          withLyrics++;
          onProgress({ stage: 'lyrics', checked: Math.min(withLyrics, target), total: target });
          // Enough to start: stop the lookups still running. Those songs stay unchecked.
          if (done()) inner.abort();
        }
      } catch (err) {
        if (done() && inner.signal.aborted && !signal?.aborted) return;
        if (!(err instanceof LyricsNetworkError)) throw err;
        networkFailures++;
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_NETWORK_FAILURES) {
          inner.abort();
          throw new PrepareError('lyrics_down');
        }
        if (!retried.has(song)) {
          retried.add(song);
          queue.push(song);
        }
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(LYRICS_CONCURRENCY, order.length) }, worker));
  } catch (err) {
    inner.abort();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  if (!withLyrics) throw new PrepareError(networkFailures ? 'lyrics_down' : 'no_lyrics', { reasons });
  return {
    songs: arrangeSongs(order),
    total,
    leftOut: dropped.length,
    reasons,
    checked: order.filter((song) => song.checked).length,
    withLyrics,
  };
}
