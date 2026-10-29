import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chooseSearchResult, getLyrics, isCacheFresh, LyricsNetworkError, clearLyricsCache } from '../js/lyrics.js';

const LYRICS = 'one\ntwo\nthree\nfour';
const SYNCED = '[00:20.00]one\n[00:24.00]two\n[00:28.00]three\n[00:32.00]four';
const track = { id: 't1', name: 'Song - Remastered', artists: ['Band'], album: 'Album', durationMs: 200_000 };

const record = (fields) => ({ id: 1, trackName: 'Song', artistName: 'Band', duration: 200, instrumental: false,
  plainLyrics: LYRICS, syncedLyrics: null, ...fields });

test('search results: within 3 s first, then synced, then closest', () => {
  const best = chooseSearchResult([
    record({ id: 1, duration: 202.5 }),
    record({ id: 2, duration: 201, syncedLyrics: SYNCED }),
    record({ id: 3, duration: 200 }),
  ], track);
  assert.equal(best.id, 2);
});

test('search results: up to 10 s only when the cleaned titles match', () => {
  assert.equal(chooseSearchResult([record({ id: 4, duration: 208, trackName: 'Song (Live)' })], track).id, 4);
  assert.equal(chooseSearchResult([record({ id: 5, duration: 208, trackName: 'Other Song' })], track), null);
  assert.equal(chooseSearchResult([record({ id: 6, duration: 215 })], track), null);
});

test('search results: instrumental and empty records are skipped', () => {
  assert.equal(chooseSearchResult([
    record({ id: 7, instrumental: true }),
    record({ id: 8, plainLyrics: '', syncedLyrics: '' }),
    record({ id: 9, plainLyrics: 'too\nshort' }),
  ], track), null);
  assert.equal(chooseSearchResult(null, track), null);
});

test('cache freshness: 30 days when found, 7 days when not found', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  assert.equal(isCacheFresh({ v: 1, found: true, fetchedAt: now - 29 * day }, now), true);
  assert.equal(isCacheFresh({ v: 1, found: true, fetchedAt: now - 31 * day }, now), false);
  assert.equal(isCacheFresh({ v: 1, found: false, fetchedAt: now - 6 * day }, now), true);
  assert.equal(isCacheFresh({ v: 1, found: false, fetchedAt: now - 8 * day }, now), false);
  assert.equal(isCacheFresh({ found: true, fetchedAt: now }, now), false);
  assert.equal(isCacheFresh(null, now), false);
});

// ---- getLyrics with a fake fetch ------------------------------------------------------------

const realFetch = globalThis.fetch;
let calls;

function respond(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(async () => {
  calls = [];
  await clearLyricsCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('exact match: cleaned lyrics, stretches, the Lrclib-Client header, and a cache hit next time', async () => {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers });
    return respond(200, record({ syncedLyrics: SYNCED, plainLyrics: '[Verse]\none\ntwo\nthree\nfour' }));
  };
  const first = await getLyrics(track);
  assert.equal(first.found, true);
  assert.equal(first.lyrics, LYRICS);
  assert.deepEqual(first.instrumentalStretches, [{ start: 0, end: 20 }, { start: 39, end: 200 }]);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/get');
  assert.equal(url.searchParams.get('track_name'), 'Song - Remastered');
  assert.equal(url.searchParams.get('artist_name'), 'Band');
  assert.equal(url.searchParams.get('album_name'), 'Album');
  assert.equal(url.searchParams.get('duration'), '200');
  assert.match(calls[0].headers['Lrclib-Client'], /^KaraoKry v1 \(https:\/\/github\.com\//);

  const second = await getLyrics(track);
  assert.equal(second.lyrics, LYRICS);
  assert.equal(calls.length, 1, 'served from the cache');
});

test('404 on the exact match falls back to search with the cleaned title', async () => {
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return String(url).includes('/api/get') ? respond(404, { message: 'not found' }) : respond(200, [record({ id: 42 })]);
  };
  const result = await getLyrics(track);
  assert.equal(result.found, true);
  assert.equal(result.lrclibId, 42);
  const search = new URL(calls[1]);
  assert.equal(search.pathname, '/api/search');
  assert.equal(search.searchParams.get('track_name'), 'Song');
});

test('an instrumental exact match is "not found" and is cached', async () => {
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return respond(200, record({ instrumental: true, plainLyrics: null }));
  };
  assert.equal((await getLyrics(track)).found, false);
  assert.equal((await getLyrics(track)).found, false);
  assert.equal(calls.length, 1);
});

test('network errors are retried once, then reported as LyricsNetworkError', async () => {
  globalThis.fetch = async () => {
    calls.push(1);
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(getLyrics(track), LyricsNetworkError);
  assert.equal(calls.length, 2);
});

test('a 5xx is retried once and can then succeed', async () => {
  globalThis.fetch = async () => {
    calls.push(1);
    return calls.length === 1 ? respond(503) : respond(200, record({}));
  };
  assert.equal((await getLyrics(track)).found, true);
  assert.equal(calls.length, 2);
});

test('when the exact match keeps failing with a server error, the search is tried', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return String(url).includes('/api/get') ? respond(503) : respond(200, [record({})]);
  };
  assert.equal((await getLyrics({ ...track, id: 't-503' })).found, true);
  assert.deepEqual(urls.map((u) => new URL(u).pathname), ['/api/get', '/api/get', '/api/search']);
});

test('"too many requests" is retried once, then reported as unavailable and not cached', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return respond(429);
  };
  const busy = { ...track, id: 't-429' };
  await assert.rejects(getLyrics(busy), (err) => err instanceof LyricsNetworkError && err.status === 429);
  assert.deepEqual(urls.map((u) => new URL(u).pathname), ['/api/get', '/api/get'], 'no search while rate limited');
  globalThis.fetch = async () => respond(200, record({}));
  assert.equal((await getLyrics(busy)).found, true, 'the next lookup asks again');
});

test('aborting stops the lookup', async () => {
  const controller = new AbortController();
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  const pending = getLyrics(track, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
