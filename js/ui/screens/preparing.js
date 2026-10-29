// Screen 6: Preparing. Reads the playlist, shuffles and locks the order, and finds
// lyrics for the first few songs (the rest are found during the game). Shows only
// counts, never titles.

import { go } from '../../router.js';
import { refs, plural, showImage } from '../dom.js';
import { prepareSongs, PrepareError } from '../../prepare.js';
import { PlaylistUnreadableError } from '../../playlists.js';
import { AuthRequiredError, getAuth, getClientId } from '../../auth.js';
import { SpotifyError } from '../../spotify-api.js';
import { newGame, clearGame, deleteSavedGame } from '../../game.js';
import { enterGame, loginExpired } from '../../app.js';
import { setDebug, recordError } from '../../debug.js';

const QUIPS = [
  'Tuning the off-key machine...',
  'Mixing up the lyrics...',
  'Hiding the answers...',
  'Warming up the mic...',
];

function errorMessage(err) {
  if (err instanceof PlaylistUnreadableError) {
    return { text: "Spotify won't let KaraoKry read this playlist. Copy its songs into a playlist you own.", retry: false };
  }
  if (err instanceof PrepareError && err.code === 'too_few') {
    const text = err.count === 0
      ? "None of the songs in this playlist can be played. Add more songs or pick another playlist."
      : `Only ${plural(err.count, 'song')} in this playlist can be played. Add more songs or pick another playlist.`;
    return { text, retry: false };
  }
  if (err instanceof PrepareError && err.code === 'no_lyrics') {
    return { text: "None of the songs in this playlist have lyrics we can find. Add more songs or pick another playlist.", retry: false };
  }
  if (err instanceof PrepareError && err.code === 'lyrics_down') {
    return { text: "Couldn't reach the lyrics service. Check your connection and try again.", retry: true };
  }
  if (err instanceof SpotifyError && err.code === 'network') {
    return { text: "Couldn't reach Spotify. Check your connection and try again.", retry: true };
  }
  if (err instanceof SpotifyError && err.code === 'rate_limited') {
    return { text: 'Spotify is busy right now. Try again in a minute.', retry: true };
  }
  if (err instanceof SpotifyError && err.code === 'server') {
    return { text: 'Spotify had a hiccup. Try again.', retry: true };
  }
  return { text: 'Something went wrong while getting the songs ready. Try again.', retry: true };
}

export default {
  id: 'preparing',

  init(el) {
    this.r = refs(el);
    this.controller = null;
    this.quipTimer = null;
    this.state = 'idle';
    this.r.cancel.addEventListener('click', () => this.cancel());
    this.r.start.addEventListener('click', () => {
      enterGame();
      go('pass');
    });
    this.r.doneBack.addEventListener('click', () => this.discardAndLeave());
    this.r.failedBack.addEventListener('click', () => go('picker'));
    this.r.retry.addEventListener('click', () => this.start(this.playlist));
  },

  show({ playlist } = {}) {
    if (!playlist) {
      go('picker');
      return;
    }
    this.start(playlist);
  },

  hide() {
    this.stopQuips();
    if (this.state === 'working') this.controller?.abort();
  },

  view(name) {
    this.state = name;
    this.r.working.hidden = name !== 'working';
    this.r.done.hidden = name !== 'done';
    this.r.failed.hidden = name !== 'failed';
  },

  start(playlist) {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.playlist = playlist;

    this.view('working');
    showImage(this.r.cover, this.r.coverPlaceholder, playlist.imageUrl);
    this.r.name.textContent = playlist.name;
    this.setProgress(0, 0, 'Reading the playlist...');
    this.startQuips();

    prepareSongs(playlist.id, {
      signal: controller.signal,
      onProgress: ({ stage, checked, total }) => {
        if (controller.signal.aborted) return;
        if (stage === 'lyrics') this.setProgress(checked, total, 'Finding the first lyrics...');
        else if (total > 50) this.setProgress(checked, total, `Reading the playlist... ${checked} of ${plural(total, 'song')}`);
        else this.setProgress(checked, total, 'Reading the playlist...');
      },
    }).then((result) => {
      if (controller.signal.aborted) return;
      this.finish(result);
    }).catch((err) => {
      if (controller.signal.aborted || err?.name === 'AbortError') return;
      this.fail(err);
    });
  },

  setProgress(checked, total, text) {
    const percent = total ? Math.round((checked / total) * 100) : 0;
    this.r.bar.style.width = `${percent}%`;
    this.r.progress.setAttribute('aria-valuenow', String(percent));
    this.r.count.textContent = text;
  },

  finish(result) {
    this.stopQuips();
    const auth = getAuth();
    newGame({
      userId: auth?.userId ?? null,
      clientId: auth?.clientId ?? getClientId(),
      playlist: { id: this.playlist.id, name: this.playlist.name, imageUrl: this.playlist.imageUrl ?? null },
      songs: result.songs,
    });
    setDebug('lastPrepare', `${result.songs.length} of ${result.total} kept; lyrics checked for ${result.checked} at the start, `
      + `${result.withLyrics} found; left out: ${JSON.stringify(result.reasons)}`);
    this.r.readyCount.textContent = `${plural(result.songs.length, 'song')} ready`;
    this.r.leftOut.textContent = result.leftOut
      ? `${plural(result.leftOut, 'song')} left out (podcasts, duplicates, songs under a minute, or not playable).`
      : '';
    this.r.leftOut.hidden = !result.leftOut;
    this.view('done');
  },

  fail(err) {
    this.stopQuips();
    if (err instanceof AuthRequiredError) {
      this.view('idle');
      loginExpired();
      return;
    }
    recordError('prepare', err);
    if (err instanceof PrepareError && err.reasons) setDebug('lastPrepare', `${err.code}; left out: ${JSON.stringify(err.reasons)}`);
    const { text, retry } = errorMessage(err);
    this.r.errorText.textContent = text;
    this.r.retry.hidden = !retry;
    this.view('failed');
  },

  cancel() {
    this.controller?.abort();
    this.view('idle');
    go('picker');
  },

  async discardAndLeave() {
    clearGame();
    await deleteSavedGame();
    this.view('idle');
    go('picker');
  },

  back() {
    if (this.state === 'working') this.cancel();
    else if (this.state === 'done') this.discardAndLeave();
    else go('picker');
  },

  startQuips() {
    this.stopQuips();
    let i = 0;
    this.r.quip.textContent = QUIPS[0];
    this.quipTimer = setInterval(() => {
      i = (i + 1) % QUIPS.length;
      this.r.quip.textContent = QUIPS[i];
    }, 3000);
  },

  stopQuips() {
    clearInterval(this.quipTimer);
    this.quipTimer = null;
  },
};
