import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newGame, actions, getGame, currentPair, isLastRound, loadSavedGame, deleteSavedGame, resumeGame,
  isValidSavedGame, save,
} from '../js/game.js';

const songs = ['A', 'B', 'C', 'D'].map((name) => ({
  id: name, uri: `spotify:track:${name}`, name, artists: ['X'], album: '', durationMs: 200_000, lyrics: `${name}\n2\n3\n4`,
  instrumentalStretches: [],
}));

function start() {
  return newGame({ userId: 'u1', clientId: 'c', playlist: { id: 'p', name: 'Party', imageUrl: null }, songs });
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
  const good = { schema: 1, songs: songs, round: 2, phase: 'paused' };
  assert.equal(isValidSavedGame(good), true);
  assert.equal(isValidSavedGame({ ...good, schema: 2 }), false);
  assert.equal(isValidSavedGame({ ...good, round: 4 }), false);
  assert.equal(isValidSavedGame({ ...good, phase: 'over' }), false);
  assert.equal(isValidSavedGame({ ...good, songs: songs.slice(0, 2) }), false);
  assert.equal(isValidSavedGame(null), false);
});
