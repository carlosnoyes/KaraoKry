// Lyrics from LRCLIB (https://lrclib.net/docs): lookup with cache, title and
// lyrics cleaning, LRC parsing and instrumental-stretch detection.
// The only module that calls LRCLIB.

import { REPO_URL } from '../config.js';
import { kvGet, kvSet, kvCount, kvDeletePrefix } from './storage.js';

const BASE_URL = 'https://lrclib.net/api';
const CLIENT_HEADER = `KaraoKry v1 (${REPO_URL})`;
const TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const FOUND_TTL_MS = 30 * DAY_MS;
const NOT_FOUND_TTL_MS = 7 * DAY_MS;
const CACHE_PREFIX = 'lyrics:';
const CACHE_VERSION = 1;

export const MIN_LYRIC_LINES = 4;
export const MIN_STRETCH_S = 15;
export const MAX_VOCAL_LINE_S = 7;

/** Thrown when LRCLIB cannot be reached (network error, timeout or 5xx after a retry). */
export class LyricsNetworkError extends Error {
  constructor(message = 'Lyrics service unreachable') {
    super(message);
    this.name = 'LyricsNetworkError';
  }
}

// ---- Text helpers ----------------------------------------------------------------

/** Lower-case, accent-free, single-spaced text for comparisons. */
export function foldText(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const VERSION_WORDS = /\b(?:re-?master\w*|live|edit|version|mono|stereo|(?:re)?mix(?:ed)?|acoustic|demo|bonus|from)\b/i;
const FEAT_WORDS = /\b(?:feat|ft|featuring|with)\b/i;
const BRACKETED = /\s*[([]([^)\]]*)[)\]]/g;
const DASH_SPLIT = /\s+[-–—]\s+/;

/** Removes "(feat. X)" style brackets and trailing " - Remastered 2011" style parts. Keeps case. */
export function stripTitleExtras(title) {
  const original = String(title ?? '').trim();
  let text = original.replace(BRACKETED, (match, inner) =>
    FEAT_WORDS.test(inner) || VERSION_WORDS.test(inner) ? '' : match,
  );
  const parts = text.split(DASH_SPLIT);
  while (parts.length > 1 && VERSION_WORDS.test(parts[parts.length - 1])) parts.pop();
  text = parts.join(' - ').replace(/\s+/g, ' ').trim();
  return text || original;
}

/** Title in comparison form: extras removed, lower-case, no accents. */
export function cleanTitle(title) {
  return foldText(stripTitleExtras(title));
}

const TIME_TAG = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g;
const WORD_TIME_TAG = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;
const LEADING_TIME_TAG = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/;

function splitLines(text) {
  return String(text ?? '').split(/\r\n|\r|\n/);
}

export function stripTimestamps(lrc) {
  return splitLines(lrc)
    .map((line) => line.replace(TIME_TAG, '').replace(WORD_TIME_TAG, ''))
    .join('\n');
}

/**
 * Cleans lyrics for display. Uses plainLyrics, or rebuilds plain text from syncedLyrics.
 * @returns {string|null} cleaned text with "\n" line breaks and single blank lines between
 *   verses, or null when fewer than 4 lines of words remain.
 */
export function cleanLyrics(plainLyrics, syncedLyrics) {
  const source = plainLyrics && plainLyrics.trim() ? plainLyrics : stripTimestamps(syncedLyrics);
  const out = [];
  for (const raw of splitLines(source)) {
    const line = raw.trim();
    if (/^\[[^\]]*\]$/.test(line)) continue; // section tags such as [Chorus]
    if (line === '') {
      if (out.length && out[out.length - 1] !== '') out.push('');
    } else {
      out.push(line);
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  const wordLines = out.filter((line) => line !== '').length;
  return wordLines >= MIN_LYRIC_LINES ? out.join('\n') : null;
}

/** Parses LRC text into [{ t: seconds, text }] sorted by time. Lines may carry several stamps. */
export function parseLrc(lrc) {
  const lines = [];
  for (const raw of splitLines(lrc)) {
    let rest = raw.trim();
    const stamps = [];
    let match;
    while ((match = LEADING_TIME_TAG.exec(rest))) {
      stamps.push(Number(match[1]) * 60 + Number(match[2].replace(':', '.')));
      rest = rest.slice(match[0].length);
    }
    if (!stamps.length) continue;
    const text = rest.replace(WORD_TIME_TAG, '').trim();
    for (const t of stamps) if (Number.isFinite(t)) lines.push({ t, text });
  }
  return lines.sort((a, b) => a.t - b.t);
}

/** A vocal line has at least one letter or digit (not just "♪" or "..."). */
export function isVocalLine(text) {
  return /[\p{L}\p{N}]/u.test(text ?? '');
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Finds parts of a song with no singing for longer than `minGapS` seconds.
 * @param {{t: number, text: string}[]} lines  parsed LRC lines, sorted by t
 * @param {number} durationS  track length in seconds
 * @returns {{start: number, end: number}[]}
 */
export function findInstrumentalStretches(lines, durationS, minGapS = MIN_STRETCH_S) {
  const vocals = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isVocalLine(lines[i].text)) continue;
    const start = lines[i].t;
    let nextStart = Infinity;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].t > start) {
        nextStart = lines[j].t;
        break;
      }
    }
    vocals.push({ start, end: Math.min(nextStart, start + MAX_VOCAL_LINE_S) });
  }
  if (!vocals.length) return [];

  const gaps = [{ start: 0, end: vocals[0].start }];
  for (let i = 1; i < vocals.length; i++) gaps.push({ start: vocals[i - 1].end, end: vocals[i].start });
  gaps.push({ start: vocals[vocals.length - 1].end, end: durationS });

  return gaps
    .map((gap) => ({ start: Math.max(0, gap.start), end: Math.min(durationS, gap.end) }))
    .filter((gap) => gap.end - gap.start > minGapS)
    .map((gap) => ({ start: round1(gap.start), end: round1(gap.end) }));
}

// ---- LRCLIB ----------------------------------------------------------------------

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

/** GET an LRCLIB endpoint. Returns parsed JSON, or null for 404 and other 4xx answers. */
async function lrclibGet(path, params, signal) {
  const url = `${BASE_URL}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { headers: { 'Lrclib-Client': CLIENT_HEADER }, signal: controller.signal });
    } catch (err) {
      if (signal?.aborted) throw abortError();
      if (attempt === 0) {
        await wait(1000, signal);
        continue;
      }
      throw new LyricsNetworkError(err?.name === 'AbortError' ? 'Timed out' : 'Network error');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (res.status >= 500) {
      if (attempt === 0) {
        await wait(1000, signal);
        continue;
      }
      throw new LyricsNetworkError(`HTTP ${res.status}`);
    }
    if (!res.ok) return null;
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
}

/** Picks the best LRCLIB search result for a Spotify track, or null. */
export function chooseSearchResult(results, track) {
  const durationS = track.durationMs / 1000;
  const title = cleanTitle(track.name);
  const ranked = [];
  for (const record of Array.isArray(results) ? results : []) {
    if (!record || record.instrumental) continue;
    if (!cleanLyrics(record.plainLyrics, record.syncedLyrics)) continue;
    const diff = Math.abs(Number(record.duration) - durationS);
    if (!Number.isFinite(diff)) continue;
    let tier;
    if (diff <= 3) tier = 0;
    else if (diff <= 10 && cleanTitle(record.trackName ?? record.name) === title) tier = 1;
    else continue;
    ranked.push({ record, tier, unsynced: record.syncedLyrics ? 0 : 1, diff });
  }
  ranked.sort((a, b) => a.tier - b.tier || a.unsynced - b.unsynced || a.diff - b.diff);
  return ranked[0]?.record ?? null;
}

function buildEntry(record, track) {
  const lyrics = cleanLyrics(record.plainLyrics, record.syncedLyrics);
  if (!lyrics) return null;
  const synced = record.syncedLyrics ? parseLrc(record.syncedLyrics) : [];
  return {
    v: CACHE_VERSION,
    found: true,
    lrclibId: record.id ?? null,
    lyrics,
    synced,
    instrumentalStretches: synced.length ? findInstrumentalStretches(synced, track.durationMs / 1000) : [],
    fetchedAt: Date.now(),
  };
}

function notFound() {
  return { v: CACHE_VERSION, found: false, fetchedAt: Date.now() };
}

async function lookup(track, signal) {
  const artist = track.artists?.[0] ?? '';
  const exact = await lrclibGet('/get', {
    track_name: track.name,
    artist_name: artist,
    album_name: track.album ?? '',
    duration: Math.round(track.durationMs / 1000),
  }, signal);
  if (exact && typeof exact === 'object' && !Array.isArray(exact)) {
    if (exact.instrumental) return notFound();
    const entry = buildEntry(exact, track);
    if (entry) return entry;
  }
  const results = await lrclibGet('/search', {
    track_name: stripTitleExtras(track.name),
    artist_name: artist,
  }, signal);
  const best = chooseSearchResult(results, track);
  return (best && buildEntry(best, track)) || notFound();
}

export function isCacheFresh(entry, now = Date.now()) {
  if (!entry || entry.v !== CACHE_VERSION || typeof entry.fetchedAt !== 'number') return false;
  const age = now - entry.fetchedAt;
  return age >= 0 && age < (entry.found ? FOUND_TTL_MS : NOT_FOUND_TTL_MS);
}

/**
 * Lyrics for a track, from the cache when fresh, otherwise from LRCLIB.
 * @param {{id: string, name: string, artists: string[], album: string, durationMs: number}} track
 * @returns {Promise<{found: boolean, lyrics?: string, instrumentalStretches?: {start:number,end:number}[]}>}
 * @throws {LyricsNetworkError} when LRCLIB cannot be reached
 */
export async function getLyrics(track, { signal } = {}) {
  const key = `${CACHE_PREFIX}${track.id}`;
  let cached = null;
  try {
    cached = await kvGet(key);
  } catch {
    cached = null;
  }
  if (isCacheFresh(cached)) return cached;
  const entry = await lookup(track, signal);
  try {
    await kvSet(key, entry);
  } catch {
    // caching is optional
  }
  return entry;
}

export function countCachedLyrics() {
  return kvCount(CACHE_PREFIX);
}

export function clearLyricsCache() {
  return kvDeletePrefix(CACHE_PREFIX);
}
