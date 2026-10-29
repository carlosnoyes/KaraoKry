import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, requestToken, setAuthHooks, SpotifyError } from '../js/spotify-api.js';

const realFetch = globalThis.fetch;
let tokens;
let refreshes;
let calls;

function respond(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

function fakeFetch(...responses) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
}

beforeEach(() => {
  tokens = ['token-1', 'token-2'];
  refreshes = 0;
  calls = [];
  setAuthHooks({
    getToken: async () => tokens[0],
    forceRefresh: async () => {
      refreshes++;
      tokens.shift();
    },
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('adds the bearer token, sends JSON bodies, and parses JSON', async () => {
  fakeFetch(respond(200, { id: 'me' }));
  assert.deepEqual(await api('/me/player/play', { method: 'PUT', body: { uris: ['x'] } }), { id: 'me' });
  assert.equal(calls[0].url, 'https://api.spotify.com/v1/me/player/play');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer token-1');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.body, '{"uris":["x"]}');
});

test('full paging URLs from `next` are used as they are', async () => {
  fakeFetch(respond(200, { items: [] }));
  await api('https://api.spotify.com/v1/me/playlists?offset=50&limit=50');
  assert.equal(calls[0].url, 'https://api.spotify.com/v1/me/playlists?offset=50&limit=50');
});

test('URLs outside the Web API are refused', async () => {
  await assert.rejects(api('https://evil.example/v1/me'), { code: 'bad_url' });
});

test('204 and empty bodies return null', async () => {
  fakeFetch(respond(204), new Response('', { status: 200 }));
  assert.equal(await api('/me/player'), null);
  assert.equal(await api('/me/player/pause', { method: 'PUT' }), null);
});

test('a 401 refreshes once and retries once', async () => {
  fakeFetch(respond(401, { error: { status: 401, message: 'expired' } }), respond(200, { ok: true }));
  assert.deepEqual(await api('/me'), { ok: true });
  assert.equal(refreshes, 1);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer token-2');
});

test('a second 401 is reported, not retried forever', async () => {
  fakeFetch(respond(401, {}), respond(401, { error: { status: 401, message: 'nope' } }));
  await assert.rejects(api('/me'), { code: 'unauthorized', status: 401 });
  assert.equal(refreshes, 1);
});

test('429 honours Retry-After up to 3 times', async () => {
  const limited = () => respond(429, { error: { status: 429, reason: 'QUOTA_EXCEEDED' } }, { 'Retry-After': '0' });
  fakeFetch(limited(), limited(), respond(200, { ok: 1 }));
  assert.deepEqual(await api('/me'), { ok: 1 });
  assert.equal(calls.length, 3);

  calls = [];
  fakeFetch(limited(), limited(), limited(), limited());
  await assert.rejects(api('/me'), { code: 'rate_limited', reason: 'QUOTA_EXCEEDED' });
  assert.equal(calls.length, 4);
});

test('a very long Retry-After is reported straight away', async () => {
  fakeFetch(respond(429, {}, { 'Retry-After': '3600' }));
  await assert.rejects(api('/me'), (err) => err.code === 'rate_limited' && err.retryAfter === 3600);
  assert.equal(calls.length, 1);
});

test('5xx is retried once after a second, then reported', async () => {
  fakeFetch(respond(502), respond(503, { error: { status: 503, message: 'down' } }));
  await assert.rejects(api('/me'), { code: 'server', status: 503 });
  assert.equal(calls.length, 2);
});

test('network failures and Premium errors are mapped', async () => {
  fakeFetch(new TypeError('Failed to fetch'));
  await assert.rejects(api('/me'), { code: 'network' });

  fakeFetch(respond(403, { error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } }));
  await assert.rejects(api('/me/player/play', { method: 'PUT' }), (err) =>
    err instanceof SpotifyError && err.status === 403 && err.reason === 'PREMIUM_REQUIRED');
});

test('token endpoint errors carry the OAuth error code', async () => {
  fakeFetch(respond(400, { error: 'invalid_grant', error_description: 'Refresh token expired' }));
  await assert.rejects(requestToken({ grant_type: 'refresh_token' }), { code: 'invalid_grant', status: 400 });

  fakeFetch(respond(200, { access_token: 'a', token_type: 'Bearer', expires_in: 3600 }));
  assert.equal((await requestToken({ grant_type: 'refresh_token' })).access_token, 'a');
  assert.equal(calls.at(-1).init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(String(calls.at(-1).init.body), 'grant_type=refresh_token');
});
