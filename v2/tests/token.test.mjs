import test from 'node:test';
import assert from 'node:assert/strict';
import { checkToken, makeToken, normalizeCode, sameSecret } from '../worker/src/token.js';

const SECRET = 'test-signing-key';
const NOW = 1_800_000_000;

test('a token works until it expires', async () => {
  const token = await makeToken(SECRET, NOW + 60);
  assert.equal(await checkToken(SECRET, token, NOW), true);
  assert.equal(await checkToken(SECRET, token, NOW + 60), false);
});

test('a token signed with another key, or changed, is refused', async () => {
  const token = await makeToken(SECRET, NOW + 60);
  assert.equal(await checkToken('another-key', token, NOW), false);
  const longer = token.replace(`v1.${NOW + 60}.`, `v1.${NOW + 6000}.`);
  assert.equal(await checkToken(SECRET, longer, NOW), false, 'a later expiry needs a new signature');
  assert.equal(await checkToken(SECRET, `${token.slice(0, -1)}A`, NOW), false);
  assert.equal(await checkToken(SECRET, null, NOW), false);
  assert.equal(await checkToken(undefined, token, NOW), false, 'no key set means no access');
});

test('access codes ignore case, spaces and dashes', async () => {
  assert.equal(normalizeCode(' ab12-cd34 '), 'AB12CD34');
  assert.equal(await sameSecret(normalizeCode('AB12-CD34'), normalizeCode('ab12 cd34')), true);
  assert.equal(await sameSecret(normalizeCode('AB12-CD34'), normalizeCode('AB12-CD35')), false);
  assert.equal(await sameSecret('', ''), false, 'an empty code never matches');
});
