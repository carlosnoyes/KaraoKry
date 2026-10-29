import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseLyrics } from '../js/game.js';

const withLyrics = (name) => ({ id: name, name, lyrics: `${name}\n2\n3\n4` });
const without = (name) => ({ id: name, name, lyrics: null });

/** Plays a whole game and returns "played/lyrics" for every round. */
function pairs(songs) {
  const sung = [];
  return songs.map((played, round) => {
    const lyrics = chooseLyrics(songs, round, sung);
    sung.push(lyrics?.id ?? null);
    return `${played.name}/${lyrics?.name ?? ''}`;
  });
}

test('when every song has lyrics, round 0 shows the last song and every other round the one before', () => {
  for (let n = 3; n <= 10; n++) {
    const songs = Array.from({ length: n }, (_, i) => withLyrics(`s${i}`));
    const sung = [];
    for (let round = 0; round < n; round++) {
      const lyrics = chooseLyrics(songs, round, sung);
      assert.equal(lyrics, songs[(round - 1 + n) % n], `N=${n}, round ${round}`);
      sung.push(lyrics.id);
    }
  }
});

test('locked order A-E pairs as A/E, B/A, C/B, D/C, E/D (tune/lyrics)', () => {
  assert.deepEqual(pairs(['A', 'B', 'C', 'D', 'E'].map(withLyrics)), ['A/E', 'B/A', 'C/B', 'D/C', 'E/D']);
});

test('a song is never paired with itself, and songs still to come are never shown', () => {
  for (let n = 3; n <= 10; n++) {
    for (let mask = 0; mask < 2 ** (n - 1); mask++) {
      // Any mix of songs with and without lyrics; the last one always has some.
      const songs = Array.from({ length: n }, (_, i) => ((mask >> i) & 1 || i === n - 1 ? withLyrics(`s${i}`) : without(`s${i}`)));
      const sung = [];
      songs.forEach((played, round) => {
        const lyrics = chooseLyrics(songs, round, sung);
        sung.push(lyrics?.id ?? null);
        if (!lyrics) return;
        assert.notEqual(lyrics, played);
        assert.ok(lyrics.lyrics);
        const index = songs.indexOf(lyrics);
        const anyPlayedWithLyrics = songs.slice(0, round).some((song) => song.lyrics);
        if (round > 0 && anyPlayedWithLyrics) assert.ok(index < round, `N=${n}, mask ${mask}, round ${round}`);
      });
    }
  }
});

test('songs without lyrics are still played, and the round after borrows', () => {
  assert.deepEqual(pairs([withLyrics('A'), without('X'), withLyrics('B'), withLyrics('Z')]), ['A/Z', 'X/A', 'B/A', 'Z/B']);
});
