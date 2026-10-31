// Builds a fame-ranked list of candidate songs for every playlist concept, using Deezer's
// public API (no account needed). For each concept it finds Deezer playlists with the
// concept's search words (keeping only those whose title fits the concept), reads their
// tracks, and ranks the tracks by Deezer's `rank`, a popularity score roughly like
// Spotify play counts. A song found in several of the playlists gets a small boost.
//
//   node v2/tools/rank-deezer.mjs [concept-id]
//
// Writes <work>/candidates.json. <work> defaults to C:\Users\Carlos\KaraoKry-songs\.work
// (KK_WORK overrides it).

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deezer, WORK } from './deezer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PLAYLISTS_PER_QUERY = 6;
const MIN_PLAYLIST_TRACKS = 25;
const MAX_TRACKS_PER_PLAYLIST = 400;
// Kept generous: many candidates have no English UltraStar version and drop out later.
const CANDIDATES_PER_CONCEPT = 1500;

// Playlists in other languages, covers, instrumentals and stories for children are skipped:
// the game needs the original English songs.
const SKIP_PLAYLIST = new RegExp([
  'piano', 'instrumental', 'lullab', 'acoustic cover', 'covers', 'karaoke', 'histoire', 'livre', 'audio ?book',
  'stories', 'story', 'enfant', 'kinder', 'kids', 'fran[cç]ais', 'french', 'france', 'princesse', 'princesas',
  'portugu', 'brasil', 'brazil', 'deutsch', 'germany',
  'espa[nñ]ol', 'latino', 'italian', 'italia', 'clássicos', 'nederland', 'polska', 'sertanejo', 'sleep', 'study',
  'remix', 'workout', 'gym',
].join('|'), 'i');
// Christmas songs belong only in the playlist made for them.
const HOLIDAY = /no[eë]l|christmas|xmas|navidad|weihnacht|holiday/i;

/** Deezer's editors make the most on-topic playlists; otherwise the most followed wins. */
function playlistScore(p) {
  const editorial = /deezer|editor/i.test(p.user?.name ?? '') ? 1 : 0;
  return editorial * 1e9 + (p.fans ?? 0);
}

/** Popularity, nudged up for songs that several of the concept's playlists agree on. */
function score(track) {
  return track.rank * (0.7 + 0.1 * Math.min(track.playlists, 3));
}

async function playlistTracks(id) {
  const tracks = [];
  for (let index = 0; index < MAX_TRACKS_PER_PLAYLIST; index += 100) {
    const page = await deezer(`/playlist/${id}/tracks?limit=100&index=${index}`);
    tracks.push(...(page.data ?? []));
    if (!page.next) break;
  }
  return tracks;
}

async function candidatesFor(concept) {
  const fits = concept.playlistTitle ? new RegExp(concept.playlistTitle, 'i') : null;
  const skip = concept.skipPlaylist ? new RegExp(concept.skipPlaylist, 'i') : null;
  const playlists = new Map();
  for (const query of concept.queries) {
    const found = await deezer(`/search/playlist?q=${encodeURIComponent(query)}&limit=25`);
    const details = [];
    for (const p of (found.data ?? []).slice(0, 15)) {
      if (p.nb_tracks < MIN_PLAYLIST_TRACKS || SKIP_PLAYLIST.test(p.title)) continue;
      if (!concept.holiday && HOLIDAY.test(p.title)) continue;
      if ((fits && !fits.test(p.title)) || skip?.test(p.title)) continue;
      try {
        details.push(await deezer(`/playlist/${p.id}?limit=1`));
      } catch {
        // a private or removed playlist: skip it
      }
    }
    const usable = details
      .filter((p) => !SKIP_PLAYLIST.test(p.description ?? ''))
      .sort((a, b) => playlistScore(b) - playlistScore(a))
      .slice(0, PLAYLISTS_PER_QUERY);
    for (const p of usable) playlists.set(p.id, { id: p.id, title: p.title, nb_tracks: p.nb_tracks, fans: p.fans, user: p.creator ?? p.user });
  }

  const tracks = new Map();
  for (const p of playlists.values()) {
    for (const t of await playlistTracks(p.id)) {
      if (!t?.id) continue;
      const entry = tracks.get(t.id) ?? {
        deezerId: t.id,
        title: t.title,
        artist: t.artist?.name ?? '',
        album: t.album?.title ?? '',
        albumId: t.album?.id ?? null,
        durationSec: t.duration ?? null,
        rank: t.rank ?? 0,
        isrc: t.isrc ?? null,
        playlists: 0,
      };
      entry.playlists += 1;
      tracks.set(t.id, entry);
    }
  }

  const ranked = [...tracks.values()].sort((a, b) => score(b) - score(a)).slice(0, CANDIDATES_PER_CONCEPT);
  return {
    id: concept.id,
    name: concept.name,
    sourcePlaylists: [...playlists.values()].map((p) => ({ id: p.id, title: p.title, by: p.user?.name ?? '', tracks: p.nb_tracks, fans: p.fans })),
    candidates: ranked,
  };
}

async function main() {
  const { concepts } = JSON.parse(await readFile(path.join(here, '..', 'catalog', 'playlist-concepts.json'), 'utf8'));
  const only = process.argv[2];
  const out = [];
  for (const concept of concepts) {
    if (only && concept.id !== only) continue;
    const result = await candidatesFor(concept);
    console.log(`${concept.id}: ${result.sourcePlaylists.length} playlists, ${result.candidates.length} candidates`);
    out.push(result);
  }
  await writeFile(path.join(WORK, only ? `candidates-${only}.json` : 'candidates.json'), JSON.stringify(out, null, 1));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
