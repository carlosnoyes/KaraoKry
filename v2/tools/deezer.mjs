// A small client for Deezer's public API (no account needed). Every answer is cached in
// <work>/deezer, so re-running the tools is quick and gentle on Deezer.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const WORK = process.env.KK_WORK ?? 'C:\\Users\\Carlos\\KaraoKry-songs\\.work';
const CACHE = path.join(WORK, 'deezer');
// Deezer allows 50 requests per 5 seconds.
const REQUEST_GAP_MS = 130;

let lastRequest = 0;
let cacheReady = null;

export async function deezer(pathAndQuery) {
  cacheReady ??= mkdir(CACHE, { recursive: true });
  await cacheReady;
  const key = createHash('sha1').update(pathAndQuery).digest('hex');
  const file = path.join(CACHE, `${key}.json`);
  if (existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequest + REQUEST_GAP_MS - Date.now();
    lastRequest = Math.max(Date.now(), lastRequest + REQUEST_GAP_MS);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    let data;
    try {
      const res = await fetch(`https://api.deezer.com${pathAndQuery}`);
      data = await res.json();
    } catch (err) {
      if (attempt < 4) continue;
      throw err;
    }
    if (data?.error) {
      // Code 4 is "quota exceeded": wait and try again.
      if (data.error.code === 4 && attempt < 8) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      throw new Error(`Deezer ${pathAndQuery}: ${JSON.stringify(data.error)}`);
    }
    await writeFile(file, JSON.stringify(data));
    return data;
  }
}

/** The genres Deezer files an album under, such as "Rock", "Country" or "Rap/Hip Hop". */
export async function albumGenres(albumId) {
  if (!albumId) return [];
  try {
    const album = await deezer(`/album/${albumId}`);
    return (album.genres?.data ?? []).map((g) => g.name);
  } catch {
    return [];
  }
}
