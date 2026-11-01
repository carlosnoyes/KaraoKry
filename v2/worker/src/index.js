// KaraoKry's song server: a Cloudflare Worker in front of the private R2 bucket
// `karaokry-songs` (see v2/SONG-FORMAT.md for what is in it).
//
//   POST /api/session            {"code": "<access code>"} → {"token", "expiresAt"}
//   GET  /<bucket key>?t=<token> a file, e.g. /catalog/songs.json or /songs/usdb-56/audio.m4a,
//                                with Range support so audio starts at once and can seek
//   PUT  /admin/objects/<key>    upload a file (publish.mjs), with "Authorization: Bearer <ADMIN_KEY>"
//
// Secrets (wrangler secret): ACCESS_CODE for players, SIGNING_KEY for tokens, ADMIN_KEY for uploads.

import { checkToken, makeToken, normalizeCode, sameSecret } from './token.js';

// Bucket keys that may be served or uploaded.
const FILE_KEY = /^(catalog\/(songs|playlists)\.json|songs\/[a-z0-9-]+\/[a-z0-9.-]+)$/;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const nowSeconds = () => Math.floor(Date.now() / 1000);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (!origin || !(allowed.includes(origin) || LOCAL_ORIGIN.test(origin))) return { vary: 'Origin' };
  return {
    vary: 'Origin',
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Range',
    'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges, ETag',
    'access-control-max-age': '86400',
  };
}

async function startSession(request, env) {
  if (!env.ACCESS_CODE || !env.SIGNING_KEY) return json({ error: 'The song server is not set up yet.' }, 503);
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = env.LOGIN_LIMIT ? await env.LOGIN_LIMIT.limit({ key: ip }) : { success: true };
  if (!success) return json({ error: 'Too many tries. Wait a minute and try again.' }, 429);
  let code;
  try {
    ({ code } = await request.json());
  } catch {
    return json({ error: 'Send {"code": "..."}' }, 400);
  }
  if (!(await sameSecret(normalizeCode(env.ACCESS_CODE), normalizeCode(code)))) {
    return json({ error: 'That access code is not right.' }, 403);
  }
  const expiresAt = nowSeconds() + Number(env.TOKEN_HOURS ?? 12) * 3600;
  return json({ token: await makeToken(env.SIGNING_KEY, expiresAt), expiresAt: new Date(expiresAt * 1000).toISOString() });
}

async function serveFile(request, env, key) {
  const wantsRange = request.method === 'GET' && request.headers.has('range');
  let object;
  try {
    object = request.method === 'HEAD'
      ? await env.SONGS.head(key)
      : await env.SONGS.get(key, wantsRange ? { range: request.headers } : undefined);
  } catch {
    // R2 rejects ranges that fall outside the file.
    return new Response('Range not satisfiable', { status: 416 });
  }
  if (!object) return json({ error: 'not found' }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  // The catalog changes when songs are added; song files rarely do, and the catalog's
  // `version` for each song can be added to its URLs to fetch a fresh copy.
  headers.set('cache-control', key.startsWith('catalog/') ? 'private, no-cache' : 'private, max-age=604800');

  let status = 200;
  let length = object.size;
  if (wantsRange && object.range) {
    // R2 says which part it returned: a suffix ("the last n bytes"), or an offset and length.
    const range = object.range;
    const suffix = typeof range.suffix === 'number' ? Math.min(range.suffix, object.size) : null;
    const offset = suffix !== null ? object.size - suffix : Number(range.offset ?? 0);
    length = suffix ?? Math.min(Number(range.length ?? object.size - offset), object.size - offset);
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    status = 206;
  }
  headers.set('content-length', String(length));
  return new Response(request.method === 'HEAD' ? null : object.body, { status, headers });
}

async function admin(request, env, key) {
  const given = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_KEY || !(await sameSecret(env.ADMIN_KEY, given))) return json({ error: 'forbidden' }, 403);
  if (!FILE_KEY.test(key)) return json({ error: 'not a song or catalog key' }, 400);
  if (request.method === 'PUT') {
    const sha256 = request.headers.get('x-content-sha256') ?? undefined;
    try {
      const object = await env.SONGS.put(key, request.body, {
        httpMetadata: { contentType: request.headers.get('content-type') ?? undefined },
        // R2 refuses the upload if the bytes don't match this checksum.
        sha256,
        customMetadata: sha256 ? { sha256 } : undefined,
      });
      return json({ key, size: object.size });
    } catch (err) {
      return json({ error: `upload refused: ${err.message}` }, 400);
    }
  }
  if (request.method === 'DELETE') {
    await env.SONGS.delete(key);
    return json({ deleted: key });
  }
  if (request.method === 'GET') {
    const object = await env.SONGS.head(key);
    if (!object) return json({ error: 'not found' }, 404);
    return json({ key, size: object.size, sha256: object.customMetadata?.sha256 ?? null, contentType: object.httpMetadata?.contentType ?? null });
  }
  return json({ error: 'method not allowed' }, 405);
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = decodeURIComponent(url.pathname);
  if (path === '/') return json({ name: 'karaokry-songs', ok: true });
  if (path === '/api/session') return request.method === 'POST' ? startSession(request, env) : json({ error: 'use POST' }, 405);
  if (path.startsWith('/admin/objects/')) return admin(request, env, path.slice('/admin/objects/'.length));
  const key = path.slice(1);
  if ((request.method === 'GET' || request.method === 'HEAD') && FILE_KEY.test(key)) {
    if (!(await checkToken(env.SIGNING_KEY, url.searchParams.get('t'), nowSeconds()))) {
      return json({ error: 'Sign in again: the token is missing or expired.' }, 401);
    }
    return serveFile(request, env, key);
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let response;
    try {
      response = await route(request, env);
    } catch (err) {
      console.error(err);
      response = json({ error: 'server error' }, 500);
    }
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  },
};
