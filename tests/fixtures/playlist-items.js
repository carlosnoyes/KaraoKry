// Playlist item fixtures in both response shapes:
// new (2026): entries carry `item`; old: entries carry `track`.

const album = (name) => ({
  name,
  images: [
    { url: `https://img/${name}-640`, width: 640, height: 640 },
    { url: `https://img/${name}-300`, width: 300, height: 300 },
    { url: `https://img/${name}-64`, width: 64, height: 64 },
  ],
});

const track = (id, name, artist, durationMs, extra = {}) => ({
  type: 'track',
  id,
  uri: `spotify:track:${id}`,
  name,
  artists: [{ name: artist }],
  album: album(`${id}-album`),
  duration_ms: durationMs,
  explicit: false,
  ...extra,
});

/** [track or null, entry-level extras, expected drop reason or null] */
export const CASES = [
  [track('a1', 'Song A', 'Artist A', 200_000), {}, null],
  [null, {}, 'missing'],
  [{ ...track('local1', 'My Demo', 'Me', 180_000), id: null, uri: 'spotify:local:Me:My+Demo:My+Demo:180' }, { is_local: true }, 'local'],
  [{ type: 'episode', id: 'ep1', uri: 'spotify:episode:ep1', name: 'Podcast', duration_ms: 3_600_000 }, {}, 'not_track'],
  [track('u1', 'Unplayable', 'Artist U', 200_000, { is_playable: false }), {}, 'unplayable'],
  [track('s1', 'Short One', 'Artist S', 45_000), {}, 'too_short'],
  [track('a1', 'Song A', 'Artist A', 200_000), {}, 'duplicate'],
  [track('a2', 'Song A - Remastered 2011', 'Artist A', 201_000), {}, 'duplicate_version'],
  [track('b1', 'Song B (feat. Somebody)', 'Artist B', 180_000), {}, null],
  [track('c1', 'Canción C', 'Artista C', 240_000, { explicit: true }), {}, null],
];

export function newShapeEntries() {
  return CASES.map(([t, extra]) => ({ added_at: '2026-01-01T00:00:00Z', is_local: false, ...extra, item: t }));
}

export function oldShapeEntries() {
  return CASES.map(([t, extra]) => ({ added_at: '2026-01-01T00:00:00Z', is_local: false, ...extra, track: t }));
}

export const EXPECTED_KEPT_IDS = ['a1', 'b1', 'c1'];
export const EXPECTED_REASONS = CASES.map(([, , reason]) => reason).filter(Boolean);
