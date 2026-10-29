import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomVerifier, challengeFor, base64url, isValidClientId, SCOPES } from '../js/auth.js';

test('the PKCE verifier is 64 characters from the allowed set', () => {
  for (let i = 0; i < 50; i++) {
    const verifier = randomVerifier();
    assert.equal(verifier.length, 64);
    assert.match(verifier, /^[A-Za-z0-9\-._~]{64}$/);
  }
  assert.notEqual(randomVerifier(), randomVerifier());
});

test('the code challenge matches the RFC 7636 example', async () => {
  assert.equal(
    await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

test('base64url has no padding and URL-safe characters', () => {
  assert.equal(base64url(new Uint8Array([251, 255, 191])), '-_-_');
  assert.equal(base64url(new Uint8Array([1])), 'AQ');
});

test('Client IDs are 32 hexadecimal characters', () => {
  assert.equal(isValidClientId('0123456789abcdef0123456789ABCDEF'), true);
  assert.equal(isValidClientId(' 0123456789abcdef0123456789abcdef '), true);
  assert.equal(isValidClientId('0123456789abcdef0123456789abcde'), false);
  assert.equal(isValidClientId('0123456789abcdef0123456789abcdeg'), false);
  assert.equal(isValidClientId(null), false);
});

test('exactly the scopes from the spec are requested', () => {
  assert.deepEqual(SCOPES.split(' ').sort(), [
    'playlist-read-collaborative',
    'playlist-read-private',
    'streaming',
    'user-modify-playback-state',
    'user-read-email',
    'user-read-playback-state',
    'user-read-private',
  ]);
});
