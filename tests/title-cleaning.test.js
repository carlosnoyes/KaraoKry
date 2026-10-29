import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, stripTitleExtras, foldText } from '../js/lyrics.js';

test('spec examples all clean to "song"', () => {
  assert.equal(cleanTitle('Song - Remastered 2011'), 'song');
  assert.equal(cleanTitle('Song (feat. X)'), 'song');
  assert.equal(cleanTitle('Song - Live at Wembley'), 'song');
});

test('more version and featuring variants', () => {
  assert.equal(cleanTitle('Song - 2011 Remaster'), 'song');
  assert.equal(cleanTitle('Song [ft. Someone]'), 'song');
  assert.equal(cleanTitle('Song (with Someone Else)'), 'song');
  assert.equal(cleanTitle('Love Me Do - Mono Version'), 'love me do');
  assert.equal(cleanTitle('Let It Go - From "Frozen"'), 'let it go');
  assert.equal(cleanTitle('Song – Radio Edit'), 'song');
  assert.equal(cleanTitle('Song - Acoustic - Live'), 'song');
  assert.equal(cleanTitle('Song (Remastered 2009)'), 'song');
});

test('accents are removed and case is folded when comparing', () => {
  assert.equal(cleanTitle('Canción Bonita'), 'cancion bonita');
  assert.equal(foldText('  Ünïcödé   Text '), 'unicode text');
});

test('ordinary dashes and brackets stay', () => {
  assert.equal(cleanTitle('Ob-La-Di, Ob-La-Da'), 'ob-la-di, ob-la-da');
  assert.equal(cleanTitle('Hello - Goodbye'), 'hello - goodbye');
  assert.equal(cleanTitle('Song - Olive'), 'song - olive');
  assert.equal(cleanTitle('(I Can\'t Get No) Satisfaction'), '(i can\'t get no) satisfaction');
});

test('stripTitleExtras keeps the original case for searching', () => {
  assert.equal(stripTitleExtras('Hey Jude - Remastered 2015'), 'Hey Jude');
  assert.equal(stripTitleExtras('(feat. Nobody)'), '(feat. Nobody)');
});
