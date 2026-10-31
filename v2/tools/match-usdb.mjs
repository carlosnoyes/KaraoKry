// Matches each playlist's fame-ranked Deezer candidates to English UltraStar songs on
// USDB, keeps the top 300 per playlist, and writes:
//   v2/catalog/playlists.json   the playlists, each an ordered list of USDB song ids
//   v2/catalog/songs.json       every song once, with its fame data (files are filled in
//                               by refresh-catalog.mjs after downloading)
//   <work>/download-ids.json    the songs to download, best-known first across playlists
//
//   node v2/tools/match-usdb.mjs
//
// Reads <work>/candidates.json (from rank-deezer.mjs) and USDB Syncer's song list.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { albumGenres, WORK } from './deezer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.join(here, '..', 'catalog');
const SYNCER_DB = path.join(process.env.LOCALAPPDATA ?? '', 'bohning', 'usdb_syncer', 'usdb_syncer.db');
const PER_PLAYLIST = 300;
// Words in the "- ..." or "(...)" part of a title that mark a version, not a different song.
const VERSION_WORDS = /remaster|version|edit|mix|live|mono|stereo|from|recorded|soundtrack|single|feat|ft\.|with|bonus|demo|acoustic|original|motion picture|film|movie|reprise/i;
// Song titles in soundtracks are often sung by a cast; USDB may list the film as the artist.
const SOUNDTRACK_PLAYLISTS = new Set(['disney', 'broadway', 'movie-hits']);

export function fold(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normTitle(title) {
  let t = String(title ?? '');
  t = t.replace(/\s*[([][^)\]]*[)\]]/g, (part) => (VERSION_WORDS.test(part) || /^\s*[([]/.test(part) ? '' : part));
  t = t.replace(/\s+-\s+(.*)$/, (part, rest) => (VERSION_WORDS.test(rest) || /^\d{4}/.test(rest) ? '' : part));
  t = fold(t).replace(/^the /, '');
  return t;
}

export function artistNames(artist) {
  return fold(String(artist ?? '').replace(/\s*[([][^)\]]*[)\]]/g, ''))
    .split(/\s+(?:feat|featuring|ft|and|x|with|vs|duet with)\s+|,/)
    .map((a) => a.trim().replace(/^the /, ''))
    .filter(Boolean);
}

function artistScore(deezerArtist, usdbArtist) {
  const a = artistNames(deezerArtist);
  const b = artistNames(usdbArtist);
  if (!a.length || !b.length) return 0;
  if (a[0] === b[0]) return 3;
  if (a.some((x) => b.includes(x))) return 2;
  const wa = fold(deezerArtist).replace(/^the /, '');
  const wb = fold(usdbArtist).replace(/^the /, '');
  if (wa.includes(wb) || wb.includes(wa)) return 2;
  return 0;
}

function loadUsdb() {
  const db = new DatabaseSync(SYNCER_DB, { readOnly: true });
  const rows = db.prepare(`select song_id, artist, title, language, edition, golden_notes, rating, views, year, genre
                           from usdb_song`).all();
  db.close();
  const byTitle = new Map();
  for (const row of rows) {
    if (!/english/i.test(row.language)) continue;
    const key = normTitle(row.title);
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(row);
  }
  return { byTitle, total: rows.length };
}

function bestMatch(candidate, concept, byTitle) {
  const options = byTitle.get(normTitle(candidate.title)) ?? [];
  let best = null;
  for (const song of options) {
    let score = artistScore(candidate.artist, song.artist);
    if (!score && SOUNDTRACK_PLAYLISTS.has(concept.id)) {
      // "Let It Go" by Idina Menzel on Deezer may be "Frozen - Let It Go" on USDB.
      const album = fold(candidate.album);
      const usdbArtist = fold(song.artist).replace(/^(walt )?disneys? /, '');
      if (usdbArtist.length > 3 && (album.includes(usdbArtist) || /disney|musical|cast|soundtrack/.test(fold(song.artist + ' ' + song.edition)))) score = 1;
    }
    if (!score) continue;
    if (concept.years && song.year && (song.year < concept.years[0] || song.year > concept.years[1])) continue;
    const rankKey = [score, song.rating, song.views];
    if (!best || compare(rankKey, best.key) > 0) best = { song, key: rankKey };
  }
  return best?.song ?? null;
}

/** Checks the genres Deezer gives the song's album against the concept's `genres` and `noRap`. */
async function genreFits(candidate, concept) {
  if (!concept.genres && !concept.noRap) return true;
  const genres = await albumGenres(candidate.albumId);
  if (concept.noRap && genres.some((g) => /rap|hip ?hop/i.test(g))) return false;
  return !concept.genres || genres.some((g) => concept.genres.includes(g));
}

function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

async function main() {
  const { concepts } = JSON.parse(await readFile(path.join(CATALOG, 'playlist-concepts.json'), 'utf8'));
  const candidates = JSON.parse(await readFile(path.join(WORK, 'candidates.json'), 'utf8'));
  const { byTitle, total } = loadUsdb();
  console.log(`USDB: ${total} songs, ${[...byTitle.values()].reduce((n, l) => n + l.length, 0)} in English`);

  const songs = new Map();
  const playlists = [];
  for (const concept of concepts) {
    const ranked = candidates.find((c) => c.id === concept.id)?.candidates ?? [];
    const picked = [];
    const seen = new Set();
    let checked = 0;
    for (const [index, candidate] of ranked.entries()) {
      if (picked.length >= PER_PLAYLIST) break;
      checked = index + 1;
      if (concept.songWords && !new RegExp(concept.songWords, 'i').test(`${candidate.title} ${candidate.album}`)) continue;
      const song = bestMatch(candidate, concept, byTitle);
      if (!song || seen.has(song.song_id)) continue;
      if (!(await genreFits(candidate, concept))) continue;
      seen.add(song.song_id);
      picked.push(song.song_id);
      const entry = songs.get(song.song_id) ?? {
        usdbId: song.song_id,
        artist: song.artist,
        title: song.title,
        year: song.year ?? null,
        usdbGenre: song.genre || null,
        usdbRating: song.rating,
        usdbViews: song.views,
        goldenNotes: Boolean(song.golden_notes),
        deezer: { id: candidate.deezerId, artist: candidate.artist, title: candidate.title, rank: candidate.rank },
        playlists: [],
        status: 'not downloaded',
        folder: null,
        files: null,
      };
      if (candidate.rank > entry.deezer.rank) {
        entry.deezer = { id: candidate.deezerId, artist: candidate.artist, title: candidate.title, rank: candidate.rank };
      }
      entry.playlists.push({ id: concept.id, fameRank: index + 1 });
      songs.set(song.song_id, entry);
    }
    console.log(`${concept.id}: ${picked.length} songs on USDB from the top ${checked} of ${ranked.length} ranked`);
    playlists.push({ id: concept.id, name: concept.name, candidatesChecked: checked, songs: picked });
  }

  // Download order: the best-known songs of every playlist first, then the next ones.
  const order = [];
  const queued = new Set();
  for (let i = 0; i < PER_PLAYLIST; i++) {
    for (const p of playlists) {
      const id = p.songs[i];
      if (id != null && !queued.has(id)) {
        queued.add(id);
        order.push(id);
      }
    }
  }

  const generated = new Date().toISOString();
  await writeFile(path.join(CATALOG, 'playlists.json'), `${JSON.stringify({ generated, perPlaylist: PER_PLAYLIST, playlists }, null, 1)}\n`);
  const songList = [...songs.values()].sort((a, b) => a.usdbId - b.usdbId);
  await writeFile(path.join(CATALOG, 'songs.json'), `${JSON.stringify({ generated, songs: songList }, null, 1)}\n`);
  await writeFile(path.join(WORK, 'download-ids.json'), JSON.stringify(order));
  console.log(`${songList.length} different songs; download list written`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
