// Packages every downloaded song in KaraoKry's own format and uploads it to the private
// Cloudflare R2 bucket. See v2/SONG-FORMAT.md for what each file holds.
//
//   node v2/tools/publish.mjs            build the package in <work>/publish (nothing uploaded)
//   node v2/tools/publish.mjs --upload   build it, then upload whatever changed since last time
//
// Uploads go through the song server (v2/worker), signed with the ADMIN_KEY kept in
// C:\Users\Carlos\KaraoKry-songs\secrets\worker-secrets.json, and R2 checks every file's
// checksum. <work>/publish/uploaded.json remembers the checksum of every uploaded file, so
// re-running only sends new or changed files.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { convertUltraStar } from './ultrastar.mjs';
import { WORK } from './deezer.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.join(here, '..', 'catalog');
const SONGS = process.env.KK_SONGS ?? 'C:\\Users\\Carlos\\KaraoKry-songs\\songs';
const OUT = path.join(WORK, 'publish');
const SONG_SERVER = process.env.KK_SONG_SERVER ?? 'https://karaokry-songs.karaokry.workers.dev';
const SECRETS = process.env.KK_SECRETS ?? 'C:\\Users\\Carlos\\KaraoKry-songs\\secrets\\worker-secrets.json';
const FFMPEG_DIR = process.env.FFMPEG_DIR ?? 'C:\\Users\\Carlos\\Tools\\ffmpeg\\bin';
const FORMAT_VERSION = 1;
const SMALL_COVER_PX = 256;
// More than 4 uploads at once made this PC's connection drop or garble some of them.
const UPLOAD_PARALLEL = 4;
const UPLOAD_ATTEMPTS = 5;
const CONTENT_TYPES = {
  '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.txt': 'text/plain;charset=utf-8',
};
const LICENSE = {
  status: 'prototype-only',
  note: 'UltraStar song from USDB with audio found online. For internal play-testing only; replace with a licensed recording before any release.',
};

const tool = (name) => (existsSync(path.join(FFMPEG_DIR, `${name}.exe`)) ? path.join(FFMPEG_DIR, `${name}.exe`) : name);

/** Runs `work` over `items`, `limit` at a time. */
async function pool(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i], i);
    }
  }));
  return results;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (d) => hash.update(d)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

/** Measuring audio is slow, so results are cached per file, keyed by its size and time. */
async function loadCache() {
  try {
    return JSON.parse(await readFile(path.join(OUT, 'measure-cache.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function cached(cache, file, kind, measure) {
  const s = await stat(file);
  const key = `${kind}|${file}|${s.size}|${Math.round(s.mtimeMs)}`;
  cache[key] ??= await measure();
  return cache[key];
}

async function probeAudio(file) {
  const { stdout } = await run(tool('ffprobe'), ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
    'stream=codec_name,sample_rate,channels,bit_rate:format=duration,bit_rate', '-of', 'json', file]);
  const info = JSON.parse(stdout);
  const stream = info.streams?.[0] ?? {};
  return {
    codec: stream.codec_name ?? null,
    sampleRate: Number(stream.sample_rate) || null,
    channels: stream.channels ?? null,
    bitrate: Number(stream.bit_rate ?? info.format?.bit_rate) || null,
    durationMs: Math.round(Number(info.format?.duration) * 1000) || null,
  };
}

/** EBU R128 loudness, so the app can play every song at the same volume. */
async function measureLoudness(file) {
  const { stderr } = await run(tool('ffmpeg'), ['-hide_banner', '-nostats', '-i', file, '-af',
    'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { maxBuffer: 1 << 24 });
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const value = (re) => {
    const m = summary.match(re);
    return m ? Number(m[1]) : null;
  };
  return {
    integratedLufs: value(/I:\s+(-?[\d.]+) LUFS/),
    rangeLu: value(/LRA:\s+(-?[\d.]+) LU/),
    truePeakDbfs: value(/True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/),
  };
}

async function probeImage(file) {
  const { stdout } = await run(tool('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file]);
  const s = JSON.parse(stdout).streams?.[0] ?? {};
  return { width: s.width ?? null, height: s.height ?? null };
}

async function makeSmallCover(source, target) {
  if (existsSync(target) && (await stat(target)).mtimeMs >= (await stat(source)).mtimeMs) return;
  await run(tool('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-vf',
    `scale='min(${SMALL_COVER_PX},iw)':-2`, '-q:v', '4', target]);
}

/** USDB titles carry tags like "[DUET]" or "(Album Version)" that the game shouldn't show. */
export function cleanTitle(title) {
  return String(title)
    .replace(/\s*\[duet+\]\s*$/i, '')
    .replace(/\s*[([][^)\]]*\b(version|edit|remaster(ed)?|single|mono|stereo)\b[^)\]]*[)\]]\s*$/i, '')
    .trim();
}

async function fileEntry(key, file, checksum) {
  return { key, bytes: (await stat(file)).size, sha256: checksum ?? (await sha256(file)) };
}

async function packageSong(song, cache) {
  const id = `usdb-${song.usdbId}`;
  const dir = path.join(SONGS, song.folder);
  const outDir = path.join(OUT, 'songs', id);
  await mkdir(outDir, { recursive: true });
  const src = {
    audio: path.join(dir, song.files.audio),
    cover: path.join(dir, song.files.cover),
    ultrastar: path.join(dir, song.files.txt),
  };
  const text = await readFile(src.ultrastar, 'utf8');
  const { headers, lyrics, facts } = convertUltraStar(text);
  const [audio, loudness, cover] = await Promise.all([
    cached(cache, src.audio, 'audio', () => probeAudio(src.audio)),
    cached(cache, src.audio, 'loudness', () => measureLoudness(src.audio)),
    cached(cache, src.cover, 'image', () => probeImage(src.cover)),
  ]);
  const smallCover = path.join(outDir, 'cover-small.jpg');
  await makeSmallCover(src.cover, smallCover);

  const key = (name) => `songs/${id}/${name}`;
  const lyricsFile = path.join(outDir, 'lyrics.json');
  await writeFile(lyricsFile, JSON.stringify({ format: 'karaokry-lyrics', formatVersion: FORMAT_VERSION, id, ...lyrics }));
  const files = {
    audio: { ...(await fileEntry(key('audio.m4a'), src.audio, await cached(cache, src.audio, 'sha256', () => sha256(src.audio)))), ...audio, loudness, vocals: 'included' },
    lyrics: await fileEntry(key('lyrics.json'), lyricsFile),
    cover: { ...(await fileEntry(key('cover.jpg'), src.cover)), ...cover },
    coverSmall: { ...(await fileEntry(key('cover-small.jpg'), smallCover)), ...(await probeImage(smallCover)) },
    ultrastar: await fileEntry(key('ultrastar.txt'), src.ultrastar),
  };

  const meta = {
    format: 'karaokry-song',
    formatVersion: FORMAT_VERSION,
    id,
    title: cleanTitle(headers.TITLE ?? song.title),
    artist: headers.ARTIST ?? song.artist,
    year: Number(headers.YEAR) || song.year || null,
    language: headers.LANGUAGE ?? null,
    genre: headers.GENRE ?? song.usdbGenre ?? null,
    durationMs: audio.durationMs,
    ...facts,
    files,
    playlists: song.playlists,
    fame: { source: 'deezer', deezerId: song.deezer.id, deezerRank: song.deezer.rank },
    source: {
      kind: 'usdb',
      usdbId: song.usdbId,
      url: `https://usdb.animux.de/index.php?link=detail&id=${song.usdbId}`,
      title: headers.TITLE ?? song.title,
      creator: headers.CREATOR ?? null,
      edition: headers.EDITION ?? null,
      tags: headers.TAGS ?? null,
      rating: song.usdbRating,
      views: song.usdbViews,
    },
    license: LICENSE,
  };
  const metaFile = path.join(outDir, 'meta.json');
  await writeFile(metaFile, `${JSON.stringify(meta, null, 1)}\n`);
  meta.files.meta = await fileEntry(key('meta.json'), metaFile);

  const uploads = [
    { key: files.audio.key, file: src.audio, sha256: files.audio.sha256 },
    { key: files.cover.key, file: src.cover, sha256: files.cover.sha256 },
    { key: files.ultrastar.key, file: src.ultrastar, sha256: files.ultrastar.sha256 },
    { key: files.lyrics.key, file: lyricsFile, sha256: files.lyrics.sha256 },
    { key: files.coverSmall.key, file: smallCover, sha256: files.coverSmall.sha256 },
    { key: meta.files.meta.key, file: metaFile, sha256: meta.files.meta.sha256 },
  ];
  return { meta, uploads };
}

/**
 * The short entry the app reads to list songs; everything else is in each song's meta.json.
 * File keys follow from the id (songs/<id>/<file>). `version` changes whenever any of the
 * song's files change, because meta.json holds every file's checksum.
 */
function catalogEntry(meta) {
  return {
    id: meta.id,
    title: meta.title,
    artist: meta.artist,
    year: meta.year,
    genre: meta.genre,
    durationMs: meta.durationMs,
    duet: meta.duet,
    // Where a short preview should start: the file's own preview point, else its medley, else the first words.
    previewStartMs: meta.previewStartMs ?? meta.medley?.startMs ?? meta.lyricsStartMs,
    loudnessLufs: meta.files.audio.loudness.integratedLufs,
    fame: meta.fame.deezerRank,
    playlists: meta.playlists,
    audioBytes: meta.files.audio.bytes,
    version: meta.files.meta.sha256.slice(0, 16),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends one file to the song server, which stores it in R2 only if its checksum matches.
 * Each upload gets a new connection: reused connections were often dropped mid-upload.
 */
async function putFile(entry, adminKey) {
  const body = await readFile(entry.file);
  const url = new URL(`${SONG_SERVER}/admin/objects/${entry.key}`);
  const client = url.protocol === 'http:' ? http : https;
  await new Promise((resolve, reject) => {
    const request = client.request(url, {
      method: 'PUT',
      agent: false,
      headers: {
        authorization: `Bearer ${adminKey}`,
        'content-type': CONTENT_TYPES[path.extname(entry.key)],
        'content-length': body.length,
        'x-content-sha256': entry.sha256,
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (d) => {
        text += d;
      });
      response.on('end', () => (response.statusCode < 300 ? resolve() : reject(new Error(`${response.statusCode} ${text}`))));
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function upload(entries) {
  const { ADMIN_KEY: adminKey } = JSON.parse(await readFile(SECRETS, 'utf8'));
  const uploadedFile = path.join(OUT, 'uploaded.json');
  let uploaded = {};
  try {
    uploaded = JSON.parse(await readFile(uploadedFile, 'utf8'));
  } catch {
    // first upload
  }
  const pending = entries.filter((e) => uploaded[e.key] !== e.sha256);
  // The catalog goes last, so it only ever lists songs that are already up.
  const files = pending.filter((e) => !e.key.startsWith('catalog/'));
  const catalog = pending.filter((e) => e.key.startsWith('catalog/'));
  console.log(`${entries.length} files, ${pending.length} new or changed`);

  let done = 0;
  let retries = 0;
  let saving = Promise.resolve();
  const send = async (entry) => {
    for (let attempt = 1; ; attempt++) {
      try {
        await putFile(entry, adminKey);
        break;
      } catch (err) {
        if (attempt === UPLOAD_ATTEMPTS) throw new Error(`Upload of ${entry.key} failed after ${attempt} tries: ${err.message}`);
        retries++;
        await sleep(1000 * attempt);
      }
    }
    uploaded[entry.key] = entry.sha256;
    saving = saving.then(() => writeFile(uploadedFile, JSON.stringify(uploaded, null, 1)));
    if (++done % 200 === 0) console.log(`uploaded ${done}/${pending.length} files (${retries} retries)`);
  };
  await pool(files, UPLOAD_PARALLEL, send);
  await pool(catalog, UPLOAD_PARALLEL, send);
  await saving;
  console.log(`upload finished: ${pending.length} files, ${retries} retries`);
}

async function main() {
  const doUpload = process.argv.includes('--upload');
  const { songs } = JSON.parse(await readFile(path.join(CATALOG, 'songs.json'), 'utf8'));
  const { playlists } = JSON.parse(await readFile(path.join(CATALOG, 'playlists.json'), 'utf8'));
  const ready = songs.filter((s) => s.status === 'downloaded' && s.files?.audio && s.files?.txt && s.files?.cover);
  await mkdir(path.join(OUT, 'catalog'), { recursive: true });
  const cache = await loadCache();
  let done = 0;
  const packaged = await pool(ready, 8, async (song) => {
    const result = await packageSong(song, cache);
    if (++done % 100 === 0) console.log(`packaged ${done}/${ready.length}`);
    return result;
  });
  await writeFile(path.join(OUT, 'measure-cache.json'), JSON.stringify(cache));

  const generated = new Date().toISOString();
  const metas = packaged.map((p) => p.meta).sort((a, b) => a.source.usdbId - b.source.usdbId);
  const byUsdb = new Map(metas.map((m) => [m.source.usdbId, m.id]));
  const catalogSongs = {
    format: 'karaokry-catalog',
    formatVersion: FORMAT_VERSION,
    generated,
    songCount: metas.length,
    songs: metas.map(catalogEntry),
  };
  const catalogPlaylists = {
    format: 'karaokry-playlists',
    formatVersion: FORMAT_VERSION,
    generated,
    playlists: playlists.map((p) => ({
      id: p.id,
      name: p.name,
      // Best known first; only songs that are in the bucket.
      songs: p.songs.map((usdbId) => byUsdb.get(usdbId)).filter(Boolean),
    })),
  };
  const songsFile = path.join(OUT, 'catalog', 'songs.json');
  const playlistsFile = path.join(OUT, 'catalog', 'playlists.json');
  await writeFile(songsFile, JSON.stringify(catalogSongs));
  await writeFile(playlistsFile, JSON.stringify(catalogPlaylists));

  const entries = packaged.flatMap((p) => p.uploads);
  entries.push({ key: 'catalog/songs.json', file: songsFile, sha256: await sha256(songsFile) });
  entries.push({ key: 'catalog/playlists.json', file: playlistsFile, sha256: await sha256(playlistsFile) });
  const totalBytes = (await Promise.all(entries.map((e) => stat(e.file)))).reduce((n, s) => n + s.size, 0);
  console.log(`${metas.length} songs packaged in ${OUT}: ${entries.length} files, ${(totalBytes / 1e9).toFixed(2)} GB`);
  for (const p of catalogPlaylists.playlists) console.log(`  ${p.name}: ${p.songs.length}`);

  if (doUpload) await upload(entries);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
