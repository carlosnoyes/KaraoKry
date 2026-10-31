import test from 'node:test';
import assert from 'node:assert/strict';
import { convertUltraStar } from '../tools/ultrastar.mjs';
import { cleanTitle } from '../tools/publish.mjs';

// BPM 300 makes one beat 50 ms; GAP puts beat 0 at 1000 ms.
const SOLO = [
  '#TITLE:Test Song',
  '#ARTIST:Tester',
  '#BPM:300',
  '#GAP:1000',
  '#PREVIEWSTART:12.5',
  ': 0 4 0 Hel',
  ': 4 4 2 lo ',
  '* 10 8 4 world',
  '- 20',
  'F 22 2 0 hey ',
  ': 24 2 0 ~',
  'E',
  '',
].join('\r\n');

test('converts beats to milliseconds from the start of the audio', () => {
  const { lyrics, facts } = convertUltraStar(SOLO);
  assert.equal(lyrics.lines.length, 2);
  const [first, second] = lyrics.lines;
  assert.deepEqual([first.start, first.end, first.breakAt], [1000, 1900, 2000]);
  assert.equal(first.text, 'Hello world');
  assert.deepEqual(first.notes[2], { start: 1500, end: 1900, text: 'world', pitch: 64, kind: 'golden' });
  assert.equal(second.notes[1].text, '', 'a held "~" note shows no text');
  assert.equal(second.breakAt, null);
  assert.equal(facts.previewStartMs, 12500);
  assert.equal(facts.playStartMs, null, 'a missing header stays null, not 0');
  assert.deepEqual([facts.hasGolden, facts.hasFreestyle, facts.duet], [true, true, false]);
});

test('puts duet parts on one timeline with each line marked by singer', () => {
  const duet = ['#BPM:300', '#GAP:0', '#P1:Ann', '#P2:Bob', 'P1', ': 0 2 0 one', '- 4', ': 20 2 0 three', 'P2', ': 10 2 0 two', 'E'].join('\n');
  const { lyrics, facts } = convertUltraStar(duet);
  assert.deepEqual(lyrics.lines.map((l) => [l.singer, l.text]), [['P1', 'one'], ['P2', 'two'], ['P1', 'three']]);
  assert.deepEqual(facts.singers, [{ id: 'P1', name: 'Ann' }, { id: 'P2', name: 'Bob' }]);
  assert.equal(facts.duet, true);
});

test('drops USDB title tags the game should not show', () => {
  assert.equal(cleanTitle('Ain’t No Mountain High Enough [DUET]'), 'Ain’t No Mountain High Enough');
  assert.equal(cleanTitle('Dreadlock Holiday (Album Version)'), 'Dreadlock Holiday');
  assert.equal(cleanTitle('Running Up That Hill (A Deal With God)'), 'Running Up That Hill (A Deal With God)');
});
