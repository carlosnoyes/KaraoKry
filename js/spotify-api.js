// The only module that talks to Spotify over HTTP.
// - Adds the bearer token, refreshes once on 401 and retries once.
// - Honours Retry-After on 429 (up to 3 times), retries 5xx once after 1 s.
// - Maps every failure to a SpotifyError with a stable `code`.
//
// Token handling is injected with setAuthHooks() so this module does not import
// auth.js (auth.js uses requestToken() from here).

import { recordError } from './debug.js';

export const API_BASE = 'https://api.spotify.com/v1';
export const TOKEN_URL = 'https://accounts.spotify.com/api/token';

const MAX_RATE_RETRIES = 3;
const DEFAULT_RETRY_AFTER_S = 2;
// A Retry-After longer than this is not worth waiting for in a party game.
const MAX_RETRY_AFTER_S = 30;

export class SpotifyError extends Error {
  constructor(code, { status = 0, reason = '', message = '', retryAfter = 0 } = {}) {
    super(message || code);
    this.name = 'SpotifyError';
    this.code = code;
    this.status = status;
    this.reason = reason;
    this.retryAfter = retryAfter;
  }
}

let hooks = {
  getToken: async () => { throw new SpotifyError('auth_required'); },
  forceRefresh: async () => { throw new SpotifyError('auth_required'); },
};

export function setAuthHooks({ getToken, forceRefresh }) {
  hooks = { getToken, forceRefresh };
}

export function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function buildUrl(path, query) {
  const url = new URL(path.startsWith('https://') ? path : `${API_BASE}${path}`);
  if (url.origin !== new URL(API_BASE).origin) throw new SpotifyError('bad_url');
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

function codeForStatus(status) {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'http';
}

function parseRetryAfter(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_RETRY_AFTER_S;
}

async function readJson(res) {
  if (res.status === 204) return null;
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function toError(res) {
  const data = await readJson(res);
  const err = data?.error;
  return new SpotifyError(codeForStatus(res.status), {
    status: res.status,
    reason: typeof err === 'object' ? err?.reason ?? '' : '',
    message: typeof err === 'object' ? err?.message ?? '' : typeof err === 'string' ? err : '',
    retryAfter: res.status === 429 ? parseRetryAfter(res.headers.get('Retry-After')) : 0,
  });
}

/**
 * Call the Spotify Web API.
 * @param {string} path  "/me/playlists?limit=50" or a full https://api.spotify.com/... URL (paging `next`)
 * @param {{method?: string, query?: object, body?: any, signal?: AbortSignal}} [options]
 * @returns {Promise<any>} parsed JSON, or null for empty responses
 */
export async function api(path, { method = 'GET', query, body, signal } = {}) {
  const url = buildUrl(path, query);
  const where = `${method} ${url.pathname.replace(/^\/v1/, '')}`;
  let refreshed = false;
  let rateRetries = 0;
  let serverRetries = 0;

  for (;;) {
    if (signal?.aborted) throw abortError();
    let token;
    try {
      token = await hooks.getToken();
    } catch (err) {
      recordError(where, err);
      throw err;
    }

    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw abortError();
      const netErr = new SpotifyError('network', { message: 'Network request failed' });
      recordError(where, netErr);
      throw netErr;
    }

    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await hooks.forceRefresh();
      continue;
    }
    if (res.status === 429 && rateRetries < MAX_RATE_RETRIES) {
      const wait = parseRetryAfter(res.headers.get('Retry-After'));
      if (wait <= MAX_RETRY_AFTER_S) {
        rateRetries++;
        await sleep(wait * 1000, signal);
        continue;
      }
    }
    if (res.status >= 500 && serverRetries < 1) {
      serverRetries++;
      await sleep(1000, signal);
      continue;
    }
    if (res.ok) return readJson(res);

    const err = await toError(res);
    recordError(where, err);
    throw err;
  }
}

/**
 * POST to the Spotify Accounts token endpoint (code exchange and refresh).
 * Throws SpotifyError whose code is Spotify's OAuth error, e.g. "invalid_grant".
 */
export async function requestToken(params, { signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
        signal,
      });
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw abortError();
      const netErr = new SpotifyError('network', { message: 'Network request failed' });
      recordError('POST /api/token', netErr);
      throw netErr;
    }
    if (res.status >= 500 && attempt === 0) {
      await sleep(1000, signal);
      continue;
    }
    const data = (await readJson(res)) ?? {};
    if (res.ok && data.access_token) return data;
    const err = new SpotifyError(typeof data.error === 'string' ? data.error : codeForStatus(res.status), {
      status: res.status,
      message: data.error_description ?? '',
    });
    recordError('POST /api/token', err);
    throw err;
  }
}
