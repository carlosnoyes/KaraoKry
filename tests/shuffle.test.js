import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shuffle, randomInt } from '../js/prepare.js';

test('shuffle returns a permutation of the input and leaves the input alone', () => {
  for (const n of [0, 1, 2, 3, 10, 100]) {
    const input = Array.from({ length: n }, (_, i) => i);
    const copy = [...input];
    const out = shuffle(input);
    assert.notEqual(out, input);
    assert.deepEqual(input, copy);
    assert.deepEqual([...out].sort((a, b) => a - b), input);
  }
});

test('over 10,000 shuffles of 4 items, each position frequency is within 5% of even', () => {
  const runs = 10_000;
  const items = ['a', 'b', 'c', 'd'];
  const counts = Object.fromEntries(items.map((item) => [item, [0, 0, 0, 0]]));
  for (let run = 0; run < runs; run++) {
    shuffle(items).forEach((item, position) => counts[item][position]++);
  }
  // Even is 25%; allow 20%-30% (5 percentage points) so the test never flakes.
  for (const item of items) {
    for (const count of counts[item]) {
      const share = count / runs;
      assert.ok(share > 0.2 && share < 0.3, `${item}: ${(share * 100).toFixed(1)}%`);
    }
  }
});

test('randomInt stays in range and reaches every value', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const value = randomInt(7);
    assert.ok(Number.isInteger(value) && value >= 0 && value < 7);
    seen.add(value);
  }
  assert.equal(seen.size, 7);
  assert.equal(randomInt(1), 0);
  assert.throws(() => randomInt(0), RangeError);
});
