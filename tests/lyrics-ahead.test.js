import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initLyricsAhead, AHEAD } from '../js/lyrics-ahead.js';
import { newGame, getGame, actions, clearGame, currentPair } from '../js/game.js';
import { LyricsNetworkError } from '../js/lyrics.js';

const lookups = [];
let answer = () => ({ found: false });
initLyricsAhead({
  retryAfterMs: 40,
  lookupLyrics: async (song, { signal }) => {
    lookups.push(song.id);
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return answer(song);
  },
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lyricsFor = (song) => ({ found: true, lyrics: `${song.id}\n2\n3\n4`, instrumentalStretches: [] });

function start(count, checkedFirst = 2) {
  lookups.length = 0;
  const songs = Array.from({ length: count }, (_, i) => ({
    id: `s${i}`, uri: `spotify:track:s${i}`, name: `S${i}`, artists: [], durationMs: 200_000,
    checked: i < checkedFirst || i === count - 1,
    lyrics: i < checkedFirst || i === count - 1 ? `s${i}\n2\n3\n4` : null,
    instrumentalStretches: [],
  }));
  return newGame({ userId: 'u', clientId: 'c', playlist: { id: 'p', name: 'P' }, songs });
}

function playRound() {
  actions.ready();
  actions.startPlaying();
  actions.skip();
}

test('checks the next songs in the background, and no further', async () => {
  answer = lyricsFor;
  start(40);
  await wait(100);
  const byNumber = (ids) => [...ids].sort((a, b) => a.slice(1) - b.slice(1));
  assert.deepEqual(byNumber(lookups), Array.from({ length: AHEAD - 1 }, (_, i) => `s${i + 2}`), 'songs 2 to 10 were checked');
  assert.ok(getGame().songs.slice(0, AHEAD + 1).every((s) => s.checked && s.lyrics));
  playRound();
  await wait(50);
  assert.deepEqual(lookups.slice(AHEAD - 1), ['s11'], 'one more song once a round is over');
  clearGame();
});

test('songs found without lyrics go to the back, so the ones with lyrics play first', async () => {
  answer = (song) => (song.id === 's3' || song.id === 's5' ? { found: false } : lyricsFor(song));
  start(30);
  await wait(150);
  const names = getGame().songs.map((s) => s.id);
  assert.deepEqual(names.slice(0, 4), ['s0', 's1', 's2', 's4']);
  assert.deepEqual(names.slice(-3), ['s3', 's5', 's29']);
  assert.ok(getGame().songs.slice(0, AHEAD + 1).every((s) => s.lyrics), 'the next rounds all have lyrics');
  clearGame();
});

test('network trouble pauses the lookups, and they carry on later', async () => {
  let down = true;
  answer = (song) => {
    if (down) throw new LyricsNetworkError();
    return lyricsFor(song);
  };
  start(20);
  await wait(20);
  const whileDown = lookups.length;
  assert.ok(whileDown >= 1 && whileDown <= 2, `${whileDown} lookups while down`);
  // The game goes on: round 1 shows song 0's lyrics, and later rounds borrow if needed.
  playRound();
  assert.equal(currentPair().lyrics.id, 's0');
  down = false;
  await wait(150);
  assert.ok(lookups.length > whileDown);
  assert.ok(getGame().songs.slice(1, AHEAD + 2).every((s) => s.checked));
  clearGame();
});

test('a song LRCLIB keeps failing on is left unchecked, and the songs after it are still checked', async () => {
  answer = (song) => {
    if (song.id === 's2') throw new LyricsNetworkError('HTTP 503');
    return lyricsFor(song);
  };
  start(20);
  await wait(250);
  assert.equal(lookups.filter((id) => id === 's2').length, 2);
  const songs = getGame().songs;
  assert.equal(songs.find((s) => s.id === 's2').checked, false);
  assert.ok(songs.slice(3, AHEAD + 1).every((s) => s.checked), 'the rest of the next songs were checked');
  clearGame();
});

test('stops when the game ends', async () => {
  answer = lyricsFor;
  start(40, 1);
  actions.end();
  await wait(50);
  assert.ok(lookups.length <= 2, `${lookups.length} lookups after the end`);
  clearGame();
});
