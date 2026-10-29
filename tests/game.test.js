import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newGame, actions, getGame, currentPair, isLastRound, loadSavedGame, deleteSavedGame, resumeGame,
  isValidSavedGame, save, songsToCheck,
} from '../js/game.js';

const song = (name, lyrics = `${name}\n2\n3\n4`, checked = true) => ({
  id: name, uri: `spotify:track:${name}`, name, artists: ['X'], album: '', durationMs: 200_000, lyrics,
  instrumentalStretches: [], checked,
});
const songs = ['A', 'B', 'C', 'D'].map((name) => song(name));

function start(list = songs) {
  return newGame({
    userId: 'u1', clientId: 'c', playlist: { id: 'p', name: 'Party', imageUrl: null }, songs: list.map((s) => ({ ...s })),
  });
}

test('a round: pass -> countdown -> playing -> reveal -> pass', () => {
  start();
  assert.equal(getGame().phase, 'pass');
  assert.equal(currentPair().played.name, 'A');
  assert.equal(currentPair().lyrics.name, 'D');
  assert.ok(actions.ready());
  assert.equal(getGame().phase, 'countdown');
  assert.ok(actions.startPlaying());
  assert.equal(getGame().roundsPlayed, 1);
  assert.ok(actions.gotIt({ positionMs: 42_000, wasPlaying: true, lyricsScrollRatio: 0.5 }));
  assert.equal(getGame().phase, 'reveal');
  assert.equal(getGame().positionMs, 42_000);
  assert.equal(actions.next(), false);
  assert.equal(getGame().phase, 'pass');
  assert.equal(getGame().round, 1);
  assert.equal(getGame().positionMs, 0);
  assert.equal(currentPair().lyrics.name, 'A');
});

test('Go back resumes when the music was playing, and stays paused otherwise', () => {
  start();
  actions.ready();
  actions.startPlaying();
  actions.gotIt({ positionMs: 1000, wasPlaying: true });
  actions.goBack();
  assert.equal(getGame().phase, 'playing');
  actions.pause(2000);
  actions.gotIt({ positionMs: 2000, wasPlaying: false });
  actions.goBack();
  assert.equal(getGame().phase, 'paused');
});

test('a finished song can be replayed or revealed', () => {
  start();
  actions.ready();
  actions.startPlaying();
  assert.ok(actions.songEnded(200_000));
  assert.ok(actions.resume());
  assert.ok(actions.songEnded(200_000));
  assert.ok(actions.reveal());
  assert.equal(getGame().wasPlaying, false);
});

test('impossible moves are refused', () => {
  start();
  assert.equal(actions.startPlaying(), false, 'no playing straight from pass');
  assert.equal(actions.goBack(), false);
  assert.equal(actions.reveal(), false);
  assert.equal(getGame().phase, 'pass');
});

test('skipping counts the round; the last round ends the game', () => {
  start();
  for (let i = 0; i < songs.length; i++) {
    actions.ready();
    actions.startPlaying();
    assert.equal(isLastRound(), i === songs.length - 1);
    const over = actions.skip();
    assert.equal(over, i === songs.length - 1);
  }
  assert.equal(getGame().phase, 'over');
  assert.equal(getGame().roundsPlayed, songs.length);
});

test('ending early counts only the rounds that started', () => {
  start();
  actions.ready();
  actions.startPlaying();
  actions.gotIt({ positionMs: 0, wasPlaying: false });
  actions.next();
  actions.end();
  assert.equal(getGame().phase, 'over');
  assert.equal(getGame().roundsPlayed, 1);

  start();
  actions.ready();
  actions.startPlaying();
  actions.end();
  assert.equal(getGame().roundsPlayed, 1);
});

test('saved games round-trip, and a mid-song game comes back paused', async () => {
  start();
  actions.ready();
  actions.startPlaying();
  actions.setPosition(73_500);
  actions.setLyricsScroll(0.42);
  await save();
  const saved = await loadSavedGame();
  assert.equal(saved.phase, 'playing');
  assert.equal(saved.positionMs, 73_500);
  assert.equal(saved.lyricsScrollRatio, 0.42);
  assert.equal(saved.userId, 'u1');
  assert.deepEqual(saved.songs.map((s) => s.name), ['A', 'B', 'C', 'D']);

  const resumed = resumeGame(saved);
  assert.equal(resumed.phase, 'paused');
  assert.equal(resumed.positionMs, 73_500);

  await deleteSavedGame();
  assert.equal(await loadSavedGame(), null);
});

test('a finished game is never saved', async () => {
  start();
  actions.end();
  await save();
  await deleteSavedGame();
  await save();
  assert.equal(await loadSavedGame(), null);
});

test('saved game validation', () => {
  const good = { schema: 2, songs, sung: ['D', 'A', 'B'], round: 2, phase: 'paused' };
  assert.equal(isValidSavedGame(good), true);
  assert.equal(isValidSavedGame({ ...good, schema: 3 }), false);
  assert.equal(isValidSavedGame({ ...good, sung: undefined }), false);
  assert.equal(isValidSavedGame({ ...good, round: 4 }), false);
  assert.equal(isValidSavedGame({ ...good, phase: 'over' }), false);
  assert.equal(isValidSavedGame({ ...good, songs: songs.slice(0, 2) }), false);
  assert.equal(isValidSavedGame({ ...good, songs: [...songs.slice(0, 3), song('E', null)] }), false, 'the last song needs lyrics');
  assert.equal(isValidSavedGame({ ...good, songs: [song('E', null), ...songs.slice(1)] }), true, 'other songs may have none');
  assert.equal(isValidSavedGame(null), false);
});

test('a game saved by version 1.1 resumes with the same pairing', async () => {
  const old = {
    schema: 1, id: 'g', userId: 'u1', playlist: { id: 'p', name: 'Party' }, round: 2, phase: 'pass', positionMs: 0,
    songs: songs.map(({ checked, ...rest }) => rest), roundsPlayed: 2,
  };
  assert.equal(isValidSavedGame(old), true);
  resumeGame(old);
  assert.equal(getGame().schema, 2);
  assert.deepEqual(getGame().sung, ['D', 'A', 'B']);
  assert.ok(getGame().songs.every((s) => s.checked));
  assert.equal(currentPair().played.name, 'C');
  assert.equal(currentPair().lyrics.name, 'B');
  actions.ready();
  actions.startPlaying();
  actions.skip();
  assert.equal(currentPair().lyrics.name, 'C');
  await deleteSavedGame();
});

test('a round whose previous song has no lyrics borrows from a song already played', () => {
  const pairs = (list) => {
    start(list);
    const shown = [];
    for (let i = 0; i < list.length; i++) {
      shown.push(`${currentPair().played.name}/${currentPair().lyrics.name}`);
      actions.ready();
      actions.startPlaying();
      actions.skip();
    }
    return shown;
  };
  // X and Y have no lyrics: the rounds after them borrow from A and B, never from
  // songs still to come (C, Z).
  assert.deepEqual(pairs([song('A'), song('X', null), song('B'), song('Y', null), song('C'), song('Z')]),
    ['A/Z', 'X/A', 'B/A', 'Y/B', 'C/B', 'Z/C']);
  // The one shown least often wins, then the one shown longest ago.
  assert.deepEqual(pairs([song('A'), song('B'), song('X', null), song('Y', null), song('W', null), song('Z')]),
    ['A/Z', 'B/A', 'X/B', 'Y/A', 'W/B', 'Z/A']);
  // With no played song to borrow from, the last song's lyrics are shown again, but
  // never while the last song itself plays: that round gets made-up words.
  assert.deepEqual(pairs([song('X', null), song('Y', null), song('Z')]), ['X/Z', 'Y/Z', 'Z/']);
  assert.match(currentPair().lyrics.lyrics, /make up your own words/i);
});

test('a lyrics result is stored, and a song still to come with none moves to the back', () => {
  start([song('A'), song('B', null, false), song('C', null, false), song('D', null, false), song('E')]);
  assert.deepEqual(songsToCheck(getGame(), 10).map((s) => s.name), ['B', 'C', 'D']);
  assert.equal(actions.lyricsChecked('B', { found: false }), true);
  assert.deepEqual(getGame().songs.map((s) => s.name), ['A', 'C', 'D', 'B', 'E']);
  assert.equal(actions.lyricsChecked('C', { found: true, lyrics: 'c\nc\nc\nc', instrumentalStretches: [{ start: 0, end: 20 }] }), true);
  const c = getGame().songs[1];
  assert.equal(c.checked, true);
  assert.equal(c.lyrics, 'c\nc\nc\nc');
  assert.deepEqual(c.instrumentalStretches, [{ start: 0, end: 20 }]);
  assert.deepEqual(songsToCheck(getGame(), 10).map((s) => s.name), ['D']);
  assert.deepEqual(songsToCheck(getGame(), 1).map((s) => s.name), [], 'only looks ahead as far as asked');
  assert.equal(actions.lyricsChecked('nope', { found: false }), false);
});

test('songs already played or playing never move', () => {
  start([song('A', null, false), song('B', null, false), song('C', null, false), song('D')]);
  actions.lyricsChecked('A', { found: false });
  assert.deepEqual(getGame().songs.map((s) => s.name), ['A', 'B', 'C', 'D'], 'A is the current round');
  actions.lyricsChecked('B', { found: false });
  assert.deepEqual(getGame().songs.map((s) => s.name), ['A', 'C', 'B', 'D']);
});
