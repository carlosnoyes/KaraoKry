import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sortPlaylists, laterPageUrls, readPlaylistItems, withMarket } from '../js/playlists.js';
import { setAuthHooks } from '../js/spotify-api.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('playlists with "karaokry" in the name come first, otherwise in Spotify\'s order', () => {
  const names = ['Road trip', 'KaraoKry party', 'Chill', 'my karaokry mix', 'Karaoke classics', 'KARAOKRY'];
  const sorted = sortPlaylists(names.map((name) => ({ name })));
  assert.deepEqual(sorted.map((p) => p.name), ['KaraoKry party', 'my karaokry mix', 'KARAOKRY', 'Road trip', 'Chill', 'Karaoke classics']);
});

test('later page links are made from the first next link', () => {
  const next = 'https://api.spotify.com/v1/playlists/p/items?offset=50&limit=50&additional_types=track';
  assert.deepEqual(laterPageUrls(next, 170), [
    'https://api.spotify.com/v1/playlists/p/items?offset=50&limit=50&additional_types=track',
    'https://api.spotify.com/v1/playlists/p/items?offset=100&limit=50&additional_types=track',
    'https://api.spotify.com/v1/playlists/p/items?offset=150&limit=50&additional_types=track',
  ]);
  assert.equal(laterPageUrls(null, 170), null);
  assert.equal(laterPageUrls(next, null), null);
  assert.equal(laterPageUrls('https://api.spotify.com/v1/playlists/p/items?cursor=abc', 170), null);
});

test('playlist pages ask for the user\'s country, so songs that can\'t play there are marked', () => {
  assert.equal(withMarket('/playlists/p/items?limit=50'), 'https://api.spotify.com/v1/playlists/p/items?limit=50&market=from_token');
  assert.equal(withMarket('https://api.spotify.com/v1/playlists/p/items?offset=50&market=US'),
    'https://api.spotify.com/v1/playlists/p/items?offset=50&market=US', 'a market in a paging link is kept');
});

test('a big playlist is read a few pages at a time, in order', async () => {
  setAuthHooks({ getToken: async () => 't', forceRefresh: async () => {} });
  const total = 230;
  let inFlight = 0;
  let most = 0;
  const markets = new Set();
  globalThis.fetch = async (url) => {
    markets.add(new URL(String(url)).searchParams.get('market'));
    const offset = Number(new URL(String(url)).searchParams.get('offset') ?? 0);
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    const items = Array.from({ length: Math.min(50, total - offset) }, (_, i) => ({ item: { id: `t${offset + i}` } }));
    const next = offset + 50 < total ? `https://api.spotify.com/v1/playlists/p/items?offset=${offset + 50}&limit=50` : null;
    return new Response(JSON.stringify({ items, total, next }), { status: 200 });
  };
  const pages = [];
  const entries = await readPlaylistItems('p', { onPage: (count) => pages.push(count) });
  assert.deepEqual(entries.map((e) => e.item.id), Array.from({ length: total }, (_, i) => `t${i}`));
  assert.ok(most > 1 && most <= 4, `${most} pages at once`);
  assert.equal(pages.at(-1), total);
  assert.deepEqual([...markets], ['from_token'], 'every page asks for the user\'s country');
});
