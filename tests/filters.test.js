import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterTracks, normalizeTrack } from '../js/prepare.js';
import { extractEntries, normalizePlaylist } from '../js/playlists.js';
import { newShapeEntries, oldShapeEntries, EXPECTED_KEPT_IDS, EXPECTED_REASONS } from './fixtures/playlist-items.js';

for (const [label, entries] of [['new (items/item)', newShapeEntries()], ['old (tracks/track)', oldShapeEntries()]]) {
  test(`filters drop the right tracks, ${label} shape`, () => {
    const { kept, dropped } = filterTracks(entries);
    assert.deepEqual(kept.map((t) => t.id), EXPECTED_KEPT_IDS);
    assert.deepEqual(dropped.map((d) => d.reason), EXPECTED_REASONS);
  });
}

test('kept tracks carry exactly the fields the game needs', () => {
  const { kept } = filterTracks(newShapeEntries());
  assert.deepEqual(kept[2], {
    id: 'c1',
    uri: 'spotify:track:c1',
    name: 'Canción C',
    artists: ['Artista C'],
    album: 'c1-album',
    imageUrl: 'https://img/c1-album-640',
    imageUrlSmall: 'https://img/c1-album-64',
    durationMs: 240_000,
    explicit: true,
  });
});

test('album art: the largest image up to 640 px, and the smallest', () => {
  const t = normalizeTrack({
    id: 'x', uri: 'spotify:track:x', name: 'X', artists: [], duration_ms: 100_000,
    album: { name: 'A', images: [{ url: 'big', width: 1000 }, { url: 'mid', width: 640 }, { url: 'small', width: 64 }] },
  });
  assert.equal(t.imageUrl, 'mid');
  assert.equal(t.imageUrlSmall, 'small');
  const none = normalizeTrack({ id: 'y', uri: 'spotify:track:y', name: 'Y', duration_ms: 100_000, album: { images: [] } });
  assert.equal(none.imageUrl, null);
  assert.deepEqual(none.artists, []);
});

test('extractEntries reads both paging shapes and rejects anything else', () => {
  assert.deepEqual(extractEntries({ items: [1, 2], next: 'n', total: 2 }), { entries: [1, 2], next: 'n', total: 2 });
  assert.deepEqual(extractEntries({ tracks: { items: [3], next: null, total: 1 } }), { entries: [3], next: null, total: 1 });
  assert.deepEqual(extractEntries({ items: { items: [4], next: null, total: 1 } }), { entries: [4], next: null, total: 1 });
  assert.equal(extractEntries({ name: 'no items here' }), null);
  assert.equal(extractEntries(null), null);
});

test('normalizePlaylist: song count from items.total or tracks.total, usable when owned or collaborative', () => {
  const owned = normalizePlaylist({ id: 'p1', name: 'Mine', owner: { id: 'me' }, items: { total: 12 }, images: null }, 'me');
  assert.equal(owned.total, 12);
  assert.equal(owned.usable, true);
  assert.equal(owned.imageUrl, null);

  const collab = normalizePlaylist({ id: 'p2', name: 'Ours', owner: { id: 'friend' }, collaborative: true, tracks: { total: 5 } }, 'me');
  assert.equal(collab.total, 5);
  assert.equal(collab.usable, true);

  const followed = normalizePlaylist({
    id: 'p3', name: 'Theirs', owner: { id: 'spotify', display_name: 'Spotify' },
    images: [{ url: 'a', width: 640 }, { url: 'b', width: 300 }, { url: 'c', width: 60 }],
  }, 'me');
  assert.equal(followed.usable, false);
  assert.equal(followed.imageUrl, 'a');
  assert.equal(followed.thumbUrl, 'b');
  assert.equal(followed.total, 0);
});
