// Updates v2/catalog/songs.json with what is on disk: each song's folder (relative to the
// songs folder) and its notes, audio and cover files. Run it after downloading.
//
//   node v2/tools/refresh-catalog.mjs
//
// Song folders come from USDB Syncer's database; download outcomes from
// <work>/download-results.json.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.join(here, '..', 'catalog');
const SONGS_ROOT = process.env.KK_SONGS ?? 'C:\\Users\\Carlos\\KaraoKry-songs\\songs';
const WORK = process.env.KK_WORK ?? 'C:\\Users\\Carlos\\KaraoKry-songs\\.work';
const SYNCER_DB = path.join(process.env.LOCALAPPDATA ?? '', 'bohning', 'usdb_syncer', 'usdb_syncer.db');
const AUDIO = /\.(m4a|mp3|ogg|opus|wav|aac)$/i;

function songFolders() {
  const db = new DatabaseSync(SYNCER_DB, { readOnly: true });
  const rows = db.prepare(`select s.song_id, s.path from sync_meta s
                           join active_sync_meta a on a.sync_meta_id = s.sync_meta_id`).all();
  db.close();
  return new Map(rows.map((r) => [r.song_id, path.dirname(path.resolve(r.path))]));
}

async function main() {
  const file = path.join(CATALOG, 'songs.json');
  const catalog = JSON.parse(await readFile(file, 'utf8'));
  const resultsFile = path.join(WORK, 'download-results.json');
  const results = existsSync(resultsFile) ? JSON.parse(await readFile(resultsFile, 'utf8')) : {};
  const folders = songFolders();
  const root = path.resolve(SONGS_ROOT);

  const counts = {};
  for (const song of catalog.songs) {
    const folder = folders.get(song.usdbId);
    song.folder = null;
    song.files = null;
    if (folder && folder.startsWith(root) && existsSync(folder)) {
      const names = await readdir(folder);
      const txt = names.find((n) => n.toLowerCase().endsWith('.txt')) ?? null;
      const audio = names.find((n) => AUDIO.test(n)) ?? null;
      const cover = names.find((n) => /\[CO\]\.(jpe?g|png)$/i.test(n)) ?? null;
      song.folder = path.relative(root, folder).split(path.sep).join('/');
      song.files = { txt, audio, cover };
      song.status = txt && audio ? 'downloaded' : 'incomplete';
    } else {
      song.status = results[String(song.usdbId)] && results[String(song.usdbId)] !== 'downloaded'
        ? results[String(song.usdbId)]
        : 'not downloaded';
    }
    counts[song.status] = (counts[song.status] ?? 0) + 1;
  }
  catalog.songsRoot = 'C:/Users/Carlos/KaraoKry-songs/songs (on Carlos\'s PC; not in git)';
  catalog.refreshed = new Date().toISOString();
  await writeFile(file, `${JSON.stringify(catalog, null, 1)}\n`);
  console.log(JSON.stringify(counts));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
