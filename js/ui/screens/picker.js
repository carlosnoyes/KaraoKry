// Screen 5: Playlist picker. Lists the user's own playlists, searches them, and
// explains why followed playlists can't be used.

import { go } from '../../router.js';
import { refs, plural, ICONS } from '../dom.js';
import { getPlaylists, loginExpired } from '../../app.js';
import { foldText } from '../../lyrics.js';
import { AuthRequiredError } from '../../auth.js';
import { SpotifyError } from '../../spotify-api.js';
import { canInstall, onInstallChange, promptInstall } from '../../pwa.js';
import { infoDialog } from '../dialogs.js';
import { MIN_SONGS } from '../../prepare.js';

const FOLLOWED_HELP = "Spotify doesn't let hobby apps read playlists you don't own. To play this one, open it in Spotify and add its songs to a playlist you made (look for 'Add to other playlist' in the playlist's menu). It will then show up here.";

function playlistItem(playlist, { meta, disabled, onClick }) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pl-item';
  if (disabled) button.setAttribute('aria-disabled', 'true');

  let art;
  if (playlist.thumbUrl) {
    art = document.createElement('img');
    art.className = 'pl-item__art';
    art.alt = '';
    art.loading = 'lazy';
    art.decoding = 'async';
    art.width = 56;
    art.height = 56;
    art.src = playlist.thumbUrl;
    art.addEventListener('error', () => {
      const placeholder = document.createElement('span');
      placeholder.className = 'pl-item__art';
      placeholder.innerHTML = ICONS.note;
      art.replaceWith(placeholder);
    }, { once: true });
  } else {
    art = document.createElement('span');
    art.className = 'pl-item__art';
    art.innerHTML = ICONS.note;
  }

  const text = document.createElement('span');
  text.className = 'pl-item__text';
  const name = document.createElement('span');
  name.className = 'pl-item__name';
  name.textContent = playlist.name;
  const info = document.createElement('span');
  info.className = 'pl-item__meta';
  info.textContent = meta;
  text.append(name, info);

  button.append(art, text);
  button.addEventListener('click', onClick);
  li.append(button);
  return li;
}

export default {
  id: 'picker',
  root: true,

  init(el) {
    this.r = refs(el);
    this.playlists = null;
    this.loadToken = 0;
    this.r.search.addEventListener('input', () => this.render());
    this.r.refresh.addEventListener('click', () => this.load({ force: true }));
    this.r.settings.addEventListener('click', () => go('settings'));
    this.r.install.addEventListener('click', () => promptInstall());
    onInstallChange((available) => {
      this.r.install.hidden = !available;
    });
  },

  show() {
    this.r.install.hidden = !canInstall();
    this.load({ force: false });
  },

  async load({ force }) {
    const token = ++this.loadToken;
    if (!this.playlists || force) this.setStatus('Loading your playlists...', { spinner: true });
    try {
      const playlists = await getPlaylists({ force });
      if (token !== this.loadToken) return;
      this.playlists = playlists;
      this.render();
    } catch (err) {
      if (token !== this.loadToken) return;
      if (err instanceof AuthRequiredError) {
        loginExpired();
        return;
      }
      const offline = err instanceof SpotifyError && err.code === 'network';
      this.setStatus(offline
        ? "Couldn't load your playlists. Check your connection."
        : "Couldn't load your playlists. Spotify had a hiccup.", { retry: true });
    }
  },

  setStatus(message, { spinner = false, retry = false } = {}) {
    const status = this.r.status;
    status.replaceChildren();
    if (spinner) {
      const s = document.createElement('span');
      s.className = 'spinner';
      s.setAttribute('aria-hidden', 'true');
      status.append(s, document.createElement('br'));
    }
    status.append(document.createTextNode(message));
    if (retry) {
      const wrap = document.createElement('div');
      wrap.className = 'stack';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn--secondary';
      button.textContent = 'Try again';
      button.addEventListener('click', () => this.load({ force: true }));
      wrap.append(button);
      status.append(wrap);
    }
    if (spinner || retry) {
      this.r.usable.replaceChildren();
      this.r.followedWrap.hidden = true;
    }
  },

  render() {
    if (!this.playlists) return;
    const query = foldText(this.r.search.value);
    const matches = (p) => !query || foldText(p.name).includes(query);
    const usable = this.playlists.filter((p) => p.usable && matches(p));
    const followed = this.playlists.filter((p) => !p.usable && matches(p));

    this.r.usable.replaceChildren(...usable.map((p) => {
      const tooShort = p.total < MIN_SONGS;
      return playlistItem(p, {
        meta: tooShort ? `${plural(p.total, 'song')} · Too short` : plural(p.total, 'song'),
        disabled: tooShort,
        onClick: () => {
          if (!tooShort) go('preparing', { playlist: p });
        },
      });
    }));

    this.r.followed.replaceChildren(...followed.map((p) => playlistItem(p, {
      meta: p.ownerName ? `by ${p.ownerName}` : plural(p.total, 'song'),
      disabled: true,
      onClick: () => infoDialog({ title: "This playlist can't be used", body: FOLLOWED_HELP }),
    })));
    this.r.followedWrap.hidden = followed.length === 0;
    this.r.followedCount.textContent = `(${followed.length})`;

    if (!this.playlists.length) {
      this.setStatus('No playlists yet. Make one in Spotify, then tap Refresh.');
    } else if (query && !usable.length && !followed.length) {
      this.setStatus(`No playlists match “${this.r.search.value.trim()}”.`);
    } else if (!usable.length && !query) {
      this.setStatus("None of these playlists are yours. Copy some songs into a playlist you made, then tap Refresh.");
    } else {
      this.r.status.replaceChildren();
    }
  },
};
