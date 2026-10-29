import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EndDetector } from '../js/playback/engine.js';

const SONG = 'spotify:track:song';
const OTHER = 'spotify:track:other';
const PREVIOUS = 'spotify:track:previous';
const DURATION = 180_000;

const playing = (uri, positionMs) => ({ uri, positionMs, durationMs: DURATION, paused: false });
const paused = (uri, positionMs) => ({ uri, positionMs, durationMs: DURATION, paused: true });

test('the song ends: near the end, then paused at 0', () => {
  const d = new EndDetector();
  d.start(SONG, null, 0);
  assert.deepEqual(d.update(playing(SONG, 1000), 100), { ours: true, event: null, pauseOther: false });
  d.update(playing(SONG, DURATION - 2500), 1000);
  assert.deepEqual(d.update(paused(SONG, 0), 3000), { ours: true, event: 'ended', pauseOther: false });
  // Later states for the same song are ignored.
  assert.equal(d.update(paused(SONG, 0), 3500).event, null);
});

test("Spotify's autoplay after the end: ended, and the other track must be paused", () => {
  const d = new EndDetector();
  d.start(SONG, null, 0);
  d.update(playing(SONG, DURATION - 1500), 1000);
  assert.deepEqual(d.update(playing(OTHER, 500), 2500), { ours: false, event: 'ended', pauseOther: true });
  // Another song starting after the end is paused again, without a second "ended".
  assert.deepEqual(d.update(playing(OTHER, 4000), 6000), { ours: false, event: null, pauseOther: true });
});

test('a different track before the end is an interruption, reported once', () => {
  const d = new EndDetector();
  d.start(SONG, null, 0);
  d.update(playing(SONG, 30_000), 1000);
  assert.deepEqual(d.update(playing(OTHER, 0), 2000), { ours: false, event: 'interrupted', pauseOther: true });
  assert.equal(d.update(playing(OTHER, 1000), 3000).event, null);
});

test('stale states from before the play call are ignored', () => {
  const d = new EndDetector();
  d.start(SONG, PREVIOUS, 0);
  assert.equal(d.update(playing(PREVIOUS, 50_000), 200).ours, false);
  assert.equal(d.update(playing(PREVIOUS, 50_000), 5000).ours, false);
  assert.equal(d.update(playing(SONG, 0), 5500).ours, true);
});

test('a substituted version of the track is accepted once it cannot be stale', () => {
  const d = new EndDetector();
  d.start(SONG, null, 0);
  assert.equal(d.update(playing(OTHER, 0), 500).ours, false, 'too early to tell');
  assert.equal(d.update(playing(OTHER, 1200), 2000).ours, true);
  assert.equal(d.observed, OTHER);
});

test('a relinked track reporting the requested URI as linked_from is ours at once', () => {
  const d = new EndDetector();
  d.start(SONG, null, 0);
  assert.equal(d.update({ ...playing(OTHER, 0), altUri: SONG }, 100).ours, true);
});

test('seeking back from near the end and pausing is not an end', () => {
  const d = new EndDetector();
  d.start(SONG, null, 0);
  d.update(playing(SONG, DURATION - 1500), 1000);
  d.note({ positionMs: 0, paused: true }, 1100);
  assert.equal(d.update(paused(SONG, 0), 2000).event, null);
});

test('losing the device while playing is an interruption; while paused it is not', () => {
  const a = new EndDetector();
  a.start(SONG, null, 0);
  a.update(playing(SONG, 10_000), 100);
  assert.equal(a.update(null, 600).event, 'interrupted');

  const b = new EndDetector();
  b.start(SONG, null, 0);
  b.update(paused(SONG, 10_000), 100);
  assert.equal(b.update(null, 600).event, null);
});

test('nothing happens before start() or after stop()', () => {
  const d = new EndDetector();
  assert.equal(d.update(playing(SONG, 0), 0).ours, false);
  d.start(SONG, null, 0);
  d.stop();
  assert.equal(d.update(playing(SONG, 0), 100).ours, false);
});
