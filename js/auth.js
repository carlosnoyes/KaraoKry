// Spotify login with Authorization Code + PKCE, entirely in the browser.
// Stores tokens in localStorage under kk.auth. Never logs tokens.

import { SPOTIFY_CLIENT_ID } from '../config.js';
import { requestToken, SpotifyError } from './spotify-api.js';
import { lsGet, lsSet, lsRemove } from './storage.js';

export const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const AUTH_KEY = 'kk.auth';
const PKCE_KEY = 'kk.pkce';
const CLIENT_KEY = 'kk.clientId';
const REFRESH_MARGIN_MS = 60_000;
const VERIFIER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

export class AuthRequiredError extends Error {
  /** @param {'required'|'expired'} reason */
  constructor(reason = 'required') {
    super(reason === 'expired' ? 'Spotify login expired' : 'Spotify login required');
    this.name = 'AuthRequiredError';
    this.reason = reason;
  }
}

const listeners = new Set();
let memoryAuth = null;
let refreshPromise = null;

/**
 * Subscribe to 'login' | 'logout' | 'expired' (this window) and
 * 'remote-login' | 'remote-logout' (another window). Returns an unsubscribe function.
 */
export function onAuthEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(type) {
  for (const fn of listeners) fn(type);
}

// ---- Client ID -------------------------------------------------------------

export function isValidClientId(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value.trim());
}

export function getCustomClientId() {
  const value = lsGet(CLIENT_KEY);
  return isValidClientId(value) ? value.trim() : null;
}

export function setCustomClientId(value) {
  if (!isValidClientId(value)) throw new Error('invalid_client_id');
  lsSet(CLIENT_KEY, value.trim().toLowerCase());
}

export function clearCustomClientId() {
  lsRemove(CLIENT_KEY);
}

export function getClientId() {
  return getCustomClientId() ?? (isValidClientId(SPOTIFY_CLIENT_ID) ? SPOTIFY_CLIENT_ID : '');
}

/** The redirect URI is the folder the app is served from, e.g. https://user.github.io/KaraoKry/ */
export function getRedirectUri() {
  const url = new URL('./', location.href);
  return url.origin + url.pathname;
}

export function isStandalone() {
  try {
    return globalThis.matchMedia?.('(display-mode: standalone)').matches || globalThis.navigator?.standalone === true;
  } catch {
    return false;
  }
}

// ---- PKCE helpers ------------------------------------------------------------

export function randomVerifier(length = 64) {
  // Rejection sampling keeps every character equally likely (256 is not a multiple of 66).
  const limit = 256 - (256 % VERIFIER_CHARS.length);
  const out = [];
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < limit && out.length < length) out.push(VERIFIER_CHARS[byte % VERIFIER_CHARS.length]);
    }
  }
  return out.join('');
}

export function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// ---- Token storage -----------------------------------------------------------

export function getAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return memoryAuth;
  }
}

function writeAuth(value) {
  memoryAuth = value;
  try {
    if (value) localStorage.setItem(AUTH_KEY, JSON.stringify(value));
    else localStorage.removeItem(AUTH_KEY);
  } catch {
    // storage blocked: memoryAuth keeps this session working
  }
}

export function isLoggedIn() {
  return Boolean(getAuth()?.refreshToken);
}

export function setUser({ id, displayName }) {
  const auth = getAuth();
  if (auth) writeAuth({ ...auth, userId: id, displayName });
}

// ---- Login ---------------------------------------------------------------------

/** Redirects to Spotify's login page. Throws Error('no_client_id') when none is configured. */
export async function startLogin() {
  const clientId = getClientId();
  if (!clientId) throw new Error('no_client_id');
  const verifier = randomVerifier();
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const redirectUri = getRedirectUri();
  lsSet(PKCE_KEY, { verifier, state, clientId, redirectUri, standalone: isStandalone() });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
  });
  location.replace(`${AUTHORIZE_URL}?${params}`);
}

/**
 * Finishes a login when the page was opened by Spotify's redirect.
 * @returns {Promise<{status: 'none'|'ok'|'cancelled'|'state_mismatch'|'error', elsewhere?: boolean, detail?: string}>}
 */
export async function completeLoginFromUrl() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (!code && !error) return { status: 'none' };

  // Remove the one-time values from the address bar straight away.
  for (const key of ['code', 'state', 'error']) url.searchParams.delete(key);
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);

  const pkce = lsGet(PKCE_KEY);
  if (error) {
    lsRemove(PKCE_KEY);
    return { status: error === 'access_denied' ? 'cancelled' : 'error', detail: error };
  }
  if (!pkce || pkce.state !== state) return { status: 'state_mismatch' };

  try {
    const data = await requestToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pkce.redirectUri,
      client_id: pkce.clientId,
      code_verifier: pkce.verifier,
    });
    writeAuth({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      authorizedAt: Date.now(),
      clientId: pkce.clientId,
      userId: null,
      displayName: null,
    });
    lsRemove(PKCE_KEY);
    emit('login');
    return { status: 'ok', elsewhere: Boolean(pkce.standalone) && !isStandalone() };
  } catch (err) {
    lsRemove(PKCE_KEY);
    return { status: 'error', detail: err?.code ?? 'unknown' };
  }
}

// ---- Tokens ---------------------------------------------------------------------

/** Returns an access token that is valid for at least another minute. */
export async function getValidToken() {
  const auth = getAuth();
  if (!auth?.accessToken) throw new AuthRequiredError();
  if (auth.expiresAt - Date.now() > REFRESH_MARGIN_MS) return auth.accessToken;
  return refreshAccessToken();
}

/** Refreshes the access token. Concurrent callers share one request. */
export function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function doRefresh() {
  const auth = getAuth();
  if (!auth?.refreshToken) throw new AuthRequiredError();
  try {
    const data = await requestToken({
      grant_type: 'refresh_token',
      refresh_token: auth.refreshToken,
      client_id: auth.clientId || getClientId(),
    });
    const latest = getAuth() ?? auth;
    writeAuth({
      ...latest,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || latest.refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      // authorizedAt is kept: refreshing does not extend the 6-month limit.
    });
    return data.access_token;
  } catch (err) {
    if (err instanceof SpotifyError && (err.code === 'invalid_grant' || err.code === 'invalid_client')) {
      // Another KaraoKry window may have rotated the refresh token meanwhile.
      const latest = getAuth();
      if (latest && latest.refreshToken !== auth.refreshToken && latest.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
        return latest.accessToken;
      }
      writeAuth(null);
      emit('expired');
      throw new AuthRequiredError('expired');
    }
    throw err;
  }
}

// ---- Logout and cross-window sync ---------------------------------------------

export function logout() {
  writeAuth(null);
  lsRemove(PKCE_KEY);
  emit('logout');
}

/** Picks up logins and logouts that happen in another tab or window ('remote-login' / 'remote-logout'). */
export function initAuthSync() {
  window.addEventListener('storage', (event) => {
    if (event.key !== AUTH_KEY && event.key !== null) return;
    const hadAuth = Boolean(event.oldValue);
    const hasAuth = Boolean(event.key === null ? getAuth() : event.newValue);
    if (!hadAuth && hasAuth) emit('remote-login');
    else if (hadAuth && !hasAuth) emit('remote-logout');
  });
}
