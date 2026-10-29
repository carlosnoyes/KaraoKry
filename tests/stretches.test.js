import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc, findInstrumentalStretches, isVocalLine } from '../js/lyrics.js';

// 20 s intro, a 9 s gap after line three (28 s + 7 s cap = 35 s, next vocal at 44 s),
// and a 25 s solo after line five (48 s + 7 s = 55 s, next vocal at 80 s, with a "♪" line inside).
const LRC = [
  '[00:20.00]Line one',
  '[00:24.00]Line two',
  '[00:28.00]Line three',
  '[00:44.00]Line four',
  '[00:48.00]Line five',
  '[01:00.00]♪',
  '[01:20.00]Line six',
  '[01:24.00]Line seven',
  '[01:28.00]Line eight',
].join('\n');

test('a 20 s intro, a 9 s gap and a 25 s solo yield exactly the intro and the solo', () => {
  const stretches = findInstrumentalStretches(parseLrc(LRC), 100);
  assert.deepEqual(stretches, [
    { start: 0, end: 20 },
    { start: 55, end: 80 },
  ]);
});

test('a long outro counts too, and a stretch must be longer than 15 s', () => {
  const lines = parseLrc('[00:15.00]a\n[00:20.00]b\n[00:30.00]c');
  // intro 15 s (not longer than 15), outro from 37 s to 60 s = 23 s
  assert.deepEqual(findInstrumentalStretches(lines, 60), [{ start: 37, end: 60 }]);
});

test('no vocal lines means no stretches', () => {
  assert.deepEqual(findInstrumentalStretches(parseLrc('[00:10.00]♪\n[00:40.00]...'), 120), []);
  assert.deepEqual(findInstrumentalStretches([], 120), []);
});

test('vocal lines need letters or digits', () => {
  assert.equal(isVocalLine('♪ ♪'), false);
  assert.equal(isVocalLine('...'), false);
  assert.equal(isVocalLine(''), false);
  assert.equal(isVocalLine('Hola'), true);
  assert.equal(isVocalLine('사랑해'), true);
  assert.equal(isVocalLine('1, 2, 3'), true);
});
