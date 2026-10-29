// Game preparation: playlist entries -> filtered tracks -> lyrics -> locked shuffled order.
// Nothing here touches the DOM.

import { readPlaylistItems } from './playlists.js';
import { getLyrics, cleanTitle, foldText, LyricsNetworkError } from './lyrics.js';

export const MIN_SONGS = 3;
export const MIN_DURATION_MS = 60_000;
export const LYRICS_CONCURRENCY = 4;
export const MAX_CONSECUTIVE_NETWORK_FAILURES = 5;

export class PrepareError extends Error {
  /** @param {'too_few'|'lyrics_down'} code */
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
 * Applies filters 1-7 of the spec (section 8.3). Lyrics (filter 8) are checked later.
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

    kept.push(normalizeTrack(track));
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
 * Turns a playlist into a locked, shuffled list of songs that all have lyrics.
 * @param {string} playlistId
 * @param {{signal?: AbortSignal, onProgress?: (p: {stage: 'reading'|'lyrics', checked: number, total: number}) => void,
 *          readItems?: typeof readPlaylistItems, lookupLyrics?: typeof getLyrics}} [options]
 * @returns {Promise<{songs: object[], total: number, leftOut: number, reasons: object}>}
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
    onPage: (count, total) => onProgress({ stage: 'reading', checked: 0, total }),
  });

  const { kept, dropped } = filterTracks(entries);
  const total = entries.length;
  let checked = dropped.length;
  onProgress({ stage: 'lyrics', checked, total });

  const inner = new AbortController();
  const onAbort = () => inner.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  const results = new Array(kept.length).fill(null);
  // Songs whose lookup failed on the network go to the back of the queue for one
  // more try, so a brief LRCLIB hiccup does not cost them their place in the game.
  const queue = kept.map((_, index) => index);
  const retried = new Set();
  let consecutiveFailures = 0;

  async function worker() {
    while (queue.length) {
      const index = queue.shift();
      const track = kept[index];
      try {
        const found = await lookupLyrics(track, { signal: inner.signal });
        consecutiveFailures = 0;
        if (found?.found && found.lyrics) {
          results[index] = { ...track, lyrics: found.lyrics, instrumentalStretches: found.instrumentalStretches ?? [] };
        } else {
          dropped.push({ reason: 'no_lyrics' });
        }
      } catch (err) {
        if (!(err instanceof LyricsNetworkError)) throw err;
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_NETWORK_FAILURES) {
          inner.abort();
          throw new PrepareError('lyrics_down');
        }
        if (!retried.has(index)) {
          retried.add(index);
          queue.push(index);
          continue;
        }
        dropped.push({ reason: 'lyrics_error' });
      }
      checked++;
      onProgress({ stage: 'lyrics', checked, total });
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(LYRICS_CONCURRENCY, kept.length) }, worker));
  } catch (err) {
    inner.abort();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  const songs = results.filter(Boolean);
  const reasons = countBy(dropped, 'reason');
  if (songs.length < MIN_SONGS) throw new PrepareError('too_few', { count: songs.length, reasons });
  return { songs: shuffle(songs), total, leftOut: total - songs.length, reasons };
}
