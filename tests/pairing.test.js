import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lyricsIndexFor, pairFor } from '../js/game.js';

test('for N from 3 to 10, round 0 shows song N-1 and every other round shows song i-1', () => {
  for (let n = 3; n <= 10; n++) {
    assert.equal(lyricsIndexFor(0, n), n - 1, `N=${n}, round 0`);
    for (let i = 1; i < n; i++) assert.equal(lyricsIndexFor(i, n), i - 1, `N=${n}, round ${i}`);
  }
});

test('locked order A-E pairs as A/E, B/A, C/B, D/C, E/D (tune/lyrics)', () => {
  const songs = ['A', 'B', 'C', 'D', 'E'];
  const pairs = songs.map((_, i) => {
    const { played, lyrics } = pairFor(songs, i);
    return `${played}/${lyrics}`;
  });
  assert.deepEqual(pairs, ['A/E', 'B/A', 'C/B', 'D/C', 'E/D']);
});

test('every song is played once and sung once, and never paired with itself', () => {
  for (let n = 3; n <= 10; n++) {
    const songs = Array.from({ length: n }, (_, i) => i);
    const played = songs.map((_, i) => pairFor(songs, i).played);
    const sung = songs.map((_, i) => pairFor(songs, i).lyrics);
    assert.deepEqual([...played].sort((a, b) => a - b), songs);
    assert.deepEqual([...sung].sort((a, b) => a - b), songs);
    songs.forEach((_, i) => assert.notEqual(played[i], sung[i]));
  }
});
