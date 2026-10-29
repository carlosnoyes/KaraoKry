import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanLyrics, stripTimestamps, parseLrc } from '../js/lyrics.js';

test('section tags in square brackets are removed', () => {
  const plain = '[Verse 1]\nLine one\nLine two\n[Chorus]\nLine three\nLine four';
  assert.equal(cleanLyrics(plain, null), 'Line one\nLine two\nLine three\nLine four');
});

test('runs of blank lines collapse into one verse break; edges are trimmed', () => {
  const plain = '\n\n  a  \r\n\r\n\r\n\r\nb\n\n\nc\nd\n\n\n';
  assert.equal(cleanLyrics(plain, ''), 'a\n\nb\n\nc\nd');
});

test('plain text is rebuilt from synced lyrics when plainLyrics is empty', () => {
  const synced = '[ar: Someone]\n[00:01.00]One\n[00:02.50] Two\n[00:04.00]\n[00:05.00]Three\n[00:06.000]Four <00:06.50>more';
  assert.equal(cleanLyrics('', synced), 'One\nTwo\n\nThree\nFour more');
  assert.equal(cleanLyrics(null, synced), 'One\nTwo\n\nThree\nFour more');
});

test('fewer than 4 lines of words means no lyrics', () => {
  assert.equal(cleanLyrics('one\n\ntwo\nthree', null), null);
  assert.equal(cleanLyrics('', ''), null);
  assert.equal(cleanLyrics(null, null), null);
  assert.equal(cleanLyrics('[Instrumental]', null), null);
});

test('stripTimestamps removes line and word stamps', () => {
  assert.equal(stripTimestamps('[00:01.00]Hello <00:01.50>world\n[01:02]Bye'), 'Hello world\nBye');
});

test('parseLrc handles several stamps per line, missing fractions, and sorts by time', () => {
  const lines = parseLrc('[ti: Title]\n[00:30.00][01:30.00]Chorus\n[00:10]Verse\n[00:20.5]Line\nno stamp here');
  assert.deepEqual(lines, [
    { t: 10, text: 'Verse' },
    { t: 20.5, text: 'Line' },
    { t: 30, text: 'Chorus' },
    { t: 90, text: 'Chorus' },
  ]);
});
