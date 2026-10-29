import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareSongs, PrepareError } from '../js/prepare.js';
import { LyricsNetworkError } from '../js/lyrics.js';
import { newShapeEntries } from './fixtures/playlist-items.js';

const entry = (id, name, artist = 'Artist') => ({
  item: { type: 'track', id, uri: `spotify:track:${id}`, name, artists: [{ name: artist }], album: { name: 'A', images: [] }, duration_ms: 200_000 },
});

const found = (track) => ({ found: true, lyrics: `words for ${track.id}\n2\n3\n4`, instrumentalStretches: [] });
const notFound = () => ({ found: false });

test('keeps songs with lyrics, reports counts and progress, and shuffles', async () => {
  const entries = [...newShapeEntries(), entry('d1', 'Song D'), entry('e1', 'Song E'), entry('f1', 'Song F')];
  const progress = [];
  const result = await prepareSongs('pl', {
    readItems: async () => entries,
    lookupLyrics: async (track) => (track.id === 'c1' ? notFound() : found(track)),
    onProgress: (p) => progress.push(p),
  });
  assert.deepEqual(result.songs.map((s) => s.id).sort(), ['a1', 'b1', 'd1', 'e1', 'f1']);
  assert.equal(result.total, entries.length);
  assert.equal(result.leftOut, entries.length - 5);
  assert.equal(result.reasons.no_lyrics, 1);
  for (const song of result.songs) {
    assert.match(song.lyrics, /^words for /);
    assert.deepEqual(song.instrumentalStretches, []);
  }
  const last = progress.at(-1);
  assert.deepEqual(last, { stage: 'lyrics', checked: entries.length, total: entries.length });
});

test('fewer than 3 songs with lyrics is an error that carries the real number', async () => {
  await assert.rejects(
    prepareSongs('pl', {
      readItems: async () => [entry('a', 'A'), entry('b', 'B'), entry('c', 'C')],
      lookupLyrics: async (track) => (track.id === 'a' || track.id === 'b' ? found(track) : notFound()),
    }),
    (err) => err instanceof PrepareError && err.code === 'too_few' && err.count === 2,
  );
});

test('5 lyrics network failures in a row stop preparation', async () => {
  let lookups = 0;
  await assert.rejects(
    prepareSongs('pl', {
      readItems: async () => Array.from({ length: 20 }, (_, i) => entry(`t${i}`, `Song ${i}`)),
      lookupLyrics: async () => {
        lookups++;
        throw new LyricsNetworkError();
      },
    }),
    (err) => err instanceof PrepareError && err.code === 'lyrics_down',
  );
  assert.ok(lookups < 20, 'remaining lookups were cancelled');
});

test('a song whose lookup keeps failing is dropped after one more try', async () => {
  const attempts = {};
  const result = await prepareSongs('pl', {
    readItems: async () => [entry('a', 'A'), entry('b', 'B'), entry('c', 'C'), entry('d', 'D')],
    lookupLyrics: async (track) => {
      attempts[track.id] = (attempts[track.id] ?? 0) + 1;
      if (track.id === 'b') throw new LyricsNetworkError();
      return found(track);
    },
  });
  assert.equal(result.songs.length, 3);
  assert.equal(result.reasons.lyrics_error, 1);
  assert.equal(attempts.b, 2);
  assert.equal(attempts.a, 1);
});

test('a brief lyrics hiccup is recovered by the second try', async () => {
  let failuresLeft = 3;
  const result = await prepareSongs('pl', {
    readItems: async () => [entry('a', 'A'), entry('b', 'B'), entry('c', 'C'), entry('d', 'D')],
    lookupLyrics: async (track) => {
      if (failuresLeft > 0) {
        failuresLeft--;
        throw new LyricsNetworkError();
      }
      return found(track);
    },
  });
  assert.equal(result.songs.length, 4);
  assert.equal(result.reasons.lyrics_error, undefined);
});

test('Cancel aborts preparation', async () => {
  const controller = new AbortController();
  const pending = prepareSongs('pl', {
    signal: controller.signal,
    readItems: async () => [entry('a', 'A'), entry('b', 'B'), entry('c', 'C')],
    lookupLyrics: (track, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }),
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { name: 'AbortError' });
});
