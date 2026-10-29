import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareSongs, arrangeSongs, PrepareError, START_WITH_LYRICS } from '../js/prepare.js';
import { LyricsNetworkError } from '../js/lyrics.js';
import { chooseLyrics } from '../js/game.js';
import { newShapeEntries } from './fixtures/playlist-items.js';

const entry = (id, name = `Song ${id}`, artist = 'Artist') => ({
  item: { type: 'track', id, uri: `spotify:track:${id}`, name, artists: [{ name: artist }], album: { name: 'A', images: [] }, duration_ms: 200_000 },
});
const many = (n) => Array.from({ length: n }, (_, i) => entry(`t${i}`));

const found = (track) => ({ found: true, lyrics: `words for ${track.id}\n2\n3\n4`, instrumentalStretches: [] });
const notFound = () => ({ found: false });

test('keeps every playable song, with or without lyrics, and reports progress', async () => {
  const entries = [...newShapeEntries(), entry('d1'), entry('e1'), entry('f1')];
  const progress = [];
  const result = await prepareSongs('pl', {
    readItems: async (id, { onPage }) => {
      onPage(entries.length, entries.length);
      return entries;
    },
    lookupLyrics: async (track) => (track.id === 'c1' ? notFound() : found(track)),
    onProgress: (p) => progress.push(p),
  });
  assert.deepEqual(result.songs.map((s) => s.id).sort(), ['a1', 'b1', 'c1', 'd1', 'e1', 'f1']);
  assert.equal(result.total, entries.length);
  assert.equal(result.leftOut, entries.length - 6);
  assert.equal(result.reasons.no_lyrics, undefined);
  assert.ok(result.withLyrics >= START_WITH_LYRICS);
  assert.deepEqual(progress[1], { stage: 'reading', checked: entries.length, total: entries.length });
  assert.deepEqual(progress.at(-1), { stage: 'lyrics', checked: START_WITH_LYRICS, total: START_WITH_LYRICS });
  for (const song of result.songs.filter((s) => s.checked && s.lyrics)) assert.match(song.lyrics, /^words for /);
});

test('a big playlist only looks up a few songs before the game starts', async () => {
  let lookups = 0;
  const result = await prepareSongs('pl', {
    readItems: async () => many(1000),
    lookupLyrics: async (track, { signal }) => {
      lookups++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return found(track);
    },
  });
  assert.equal(result.songs.length, 1000);
  assert.ok(lookups <= START_WITH_LYRICS + 3, `${lookups} lookups`);
  assert.equal(result.songs.filter((s) => s.lyrics).length, START_WITH_LYRICS);
  assert.equal(result.songs.filter((s) => !s.checked).length, 1000 - START_WITH_LYRICS);
});

test('the order puts songs with lyrics first and keeps one with lyrics for the end', async () => {
  const result = await prepareSongs('pl', {
    readItems: async () => many(30),
    // Every other song has no lyrics.
    lookupLyrics: async (track) => (Number(track.id.slice(1)) % 2 ? notFound() : found(track)),
  });
  const { songs } = result;
  const first = songs.slice(0, START_WITH_LYRICS - 1);
  assert.ok(first.every((s) => s.lyrics), 'the first songs have lyrics');
  assert.ok(songs.at(-1).lyrics, 'the last song has lyrics');
  assert.equal(chooseLyrics(songs, 0), songs.at(-1), 'round 0 shows the last song');
  const noLyrics = songs.filter((s) => s.checked && !s.lyrics);
  assert.ok(noLyrics.length > 0);
  for (const song of noLyrics) assert.ok(songs.indexOf(song) >= songs.length - 1 - noLyrics.length, 'songs without lyrics wait at the back');
});

test('arrangeSongs: lyrics first, then unchecked, then without lyrics, then the opening lyrics', () => {
  const s = (id, checked, lyrics = null) => ({ id, checked, lyrics });
  const order = [s('u1', false), s('n1', true), s('l1', true, 'x'), s('u2', false), s('l2', true, 'x'), s('n2', true)];
  assert.deepEqual(arrangeSongs(order).map((x) => x.id), ['l2', 'u1', 'u2', 'n1', 'n2', 'l1']);
});

test('fewer than 3 playable songs is an error that carries the real number', async () => {
  await assert.rejects(
    prepareSongs('pl', { readItems: async () => [entry('a'), entry('b')], lookupLyrics: async (track) => found(track) }),
    (err) => err instanceof PrepareError && err.code === 'too_few' && err.count === 2,
  );
});

test('a playlist where no song has lyrics is an error', async () => {
  await assert.rejects(
    prepareSongs('pl', { readItems: async () => many(12), lookupLyrics: async () => notFound() }),
    (err) => err instanceof PrepareError && err.code === 'no_lyrics',
  );
});

test('one song with lyrics is enough to start', async () => {
  const result = await prepareSongs('pl', {
    readItems: async () => many(5),
    lookupLyrics: async (track) => (track.id === 't3' ? found(track) : notFound()),
  });
  assert.equal(result.songs.length, 5);
  assert.equal(result.songs.at(-1).id, 't3');
});

test('5 lyrics network failures in a row stop preparation', async () => {
  let lookups = 0;
  await assert.rejects(
    prepareSongs('pl', {
      readItems: async () => many(20),
      lookupLyrics: async () => {
        lookups++;
        throw new LyricsNetworkError();
      },
    }),
    (err) => err instanceof PrepareError && err.code === 'lyrics_down',
  );
  assert.ok(lookups < 20, 'remaining lookups were cancelled');
});

test('a song whose lookup keeps failing stays unchecked, for the lookups during the game', async () => {
  const attempts = {};
  const result = await prepareSongs('pl', {
    readItems: async () => [entry('a'), entry('b'), entry('c'), entry('d')],
    lookupLyrics: async (track) => {
      attempts[track.id] = (attempts[track.id] ?? 0) + 1;
      if (track.id === 'b') throw new LyricsNetworkError();
      return found(track);
    },
  });
  assert.equal(result.songs.length, 4);
  assert.equal(attempts.b, 2);
  assert.equal(attempts.a, 1);
  assert.equal(result.songs.find((s) => s.id === 'b').checked, false);
});

test('a brief lyrics hiccup is recovered by the second try', async () => {
  let failuresLeft = 3;
  const result = await prepareSongs('pl', {
    readItems: async () => [entry('a'), entry('b'), entry('c'), entry('d')],
    lookupLyrics: async (track) => {
      if (failuresLeft > 0) {
        failuresLeft--;
        throw new LyricsNetworkError();
      }
      return found(track);
    },
  });
  assert.equal(result.withLyrics, 4);
  assert.ok(result.songs.every((s) => s.checked));
});

test('Cancel aborts preparation', async () => {
  const controller = new AbortController();
  const pending = prepareSongs('pl', {
    signal: controller.signal,
    readItems: async () => [entry('a'), entry('b'), entry('c')],
    lookupLyrics: (track, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }),
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { name: 'AbortError' });
});
