// Reading the user's playlists and a playlist's items from Spotify.
// Parses both the 2026 field names (items / item) and the old ones (tracks / track).

import { api, SpotifyError } from './spotify-api.js';
import { foldText } from './lyrics.js';

const MAX_PAGES = 200;
const PAGE_CONCURRENCY = 4;
const PINNED_WORD = 'karaokry';

export class PlaylistUnreadableError extends Error {
  constructor() {
    super('Playlist cannot be read');
    this.name = 'PlaylistUnreadableError';
  }
}

export async function getMe(options) {
  const me = await api('/me', options);
  return { id: me?.id ?? null, displayName: me?.display_name || me?.id || 'Spotify user' };
}

function imageBySize(images, pick) {
  const list = (Array.isArray(images) ? images : []).filter((img) => img?.url);
  if (!list.length) return null;
  if (list.every((img) => !img.width)) return pick === 'largest' ? list[0].url : list[list.length - 1].url;
  const sorted = [...list].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return pick === 'largest' ? sorted[0].url : sorted[sorted.length - 1].url;
}

/** Thumbnail: the smallest image that is still at least 100 px wide, or the smallest one. */
function thumbnail(images) {
  const list = (Array.isArray(images) ? images : []).filter((img) => img?.url);
  if (!list.length) return null;
  const sized = list.filter((img) => img.width >= 100).sort((a, b) => a.width - b.width);
  return sized[0]?.url ?? imageBySize(list, 'smallest');
}

export function normalizePlaylist(playlist, userId) {
  const total = playlist?.items?.total ?? playlist?.tracks?.total ?? 0;
  const ownerId = playlist?.owner?.id ?? null;
  const collaborative = Boolean(playlist?.collaborative);
  return {
    id: playlist.id,
    name: playlist.name || 'Untitled playlist',
    imageUrl: imageBySize(playlist.images, 'largest'),
    thumbUrl: thumbnail(playlist.images),
    ownerId,
    ownerName: playlist?.owner?.display_name ?? null,
    collaborative,
    total: Number(total) || 0,
    usable: (userId != null && ownerId === userId) || collaborative,
  };
}

export async function listPlaylists(userId, { signal } = {}) {
  const out = [];
  const seen = new Set();
  let next = '/me/playlists?limit=50';
  for (let page = 0; next && page < MAX_PAGES; page++) {
    if (seen.has(next)) break;
    seen.add(next);
    const data = await api(next, { signal });
    for (const playlist of data?.items ?? []) {
      if (playlist?.id) out.push(normalizePlaylist(playlist, userId));
    }
    next = data?.next ?? null;
  }
  return sortPlaylists(out);
}

/** Playlists with "karaokry" in their name come first. Otherwise Spotify's order is kept. */
export function sortPlaylists(playlists) {
  const pinned = (playlist) => foldText(playlist.name).includes(PINNED_WORD);
  return [...playlists.filter(pinned), ...playlists.filter((playlist) => !pinned(playlist))];
}

/**
 * Finds the list of entries in a playlist-items response, whichever shape it has.
 * @returns {{entries: any[], next: string|null, total: number|null} | null}
 */
export function extractEntries(page) {
  if (Array.isArray(page?.items)) {
    return { entries: page.items, next: page.next ?? null, total: page.total ?? null };
  }
  for (const key of ['items', 'tracks']) {
    const inner = page?.[key];
    if (inner && Array.isArray(inner.items)) {
      return { entries: inner.items, next: inner.next ?? null, total: inner.total ?? null };
    }
  }
  return null;
}

/**
 * Paging links for the pages after the first one, made from the first page's `next`
 * link by changing its offset. Null when the link has no offset to change.
 */
export function laterPageUrls(next, total) {
  if (!next || !Number.isFinite(total)) return null;
  let url;
  try {
    url = new URL(next, 'https://api.spotify.com/v1/');
  } catch {
    return null;
  }
  const offset = Number(url.searchParams.get('offset'));
  const limit = Number(url.searchParams.get('limit'));
  if (!(offset > 0) || !(limit > 0)) return null;
  const urls = [];
  for (let at = offset; at < total && urls.length < MAX_PAGES; at += limit) {
    url.searchParams.set('offset', String(at));
    urls.push(url.href);
  }
  return urls;
}

async function readPage(path, signal) {
  let data;
  try {
    data = await api(path, { signal });
  } catch (err) {
    if (err instanceof SpotifyError && err.status === 403) throw new PlaylistUnreadableError();
    throw err;
  }
  const parsed = extractEntries(data);
  if (!parsed) throw new PlaylistUnreadableError();
  return parsed;
}

/**
 * Reads every entry of a playlist. After the first page, the other pages are read a
 * few at a time, so a big playlist takes seconds rather than a long wait.
 * Throws PlaylistUnreadableError on 403 or an unexpected shape.
 */
export async function readPlaylistItems(playlistId, { signal, onPage } = {}) {
  const first = await readPage(`/playlists/${encodeURIComponent(playlistId)}/items?limit=50&additional_types=track`, signal);
  const total = first.total ?? first.entries.length;
  let count = first.entries.length;
  onPage?.(count, total);

  const urls = laterPageUrls(first.next, first.total);
  if (urls) {
    const pages = new Array(urls.length);
    const inner = new AbortController();
    const onAbort = () => inner.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let nextPage = 0;
    const worker = async () => {
      while (nextPage < urls.length) {
        const index = nextPage++;
        const page = await readPage(urls[index], inner.signal);
        pages[index] = page.entries;
        count += page.entries.length;
        onPage?.(count, total);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, urls.length) }, worker));
    } catch (err) {
      inner.abort();
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    return [first.entries, ...pages].flat();
  }

  // No offset in the paging link: follow the links one by one.
  const entries = [...first.entries];
  const seen = new Set();
  let next = first.next;
  for (let page = 1; next && page < MAX_PAGES; page++) {
    if (seen.has(next)) break;
    seen.add(next);
    const parsed = await readPage(next, signal);
    entries.push(...parsed.entries);
    onPage?.(entries.length, parsed.total ?? entries.length);
    next = parsed.next;
  }
  return entries;
}
