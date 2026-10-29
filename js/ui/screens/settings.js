// Screen 12: Settings.

import { go } from '../../router.js';
import { refs, plural } from '../dom.js';
import { APP_VERSION, REPO_URL, README_URL, SPOTIFY_CLIENT_ID } from '../../../config.js';
import {
  getAuth, isLoggedIn, getRedirectUri, getCustomClientId, isValidClientId, setCustomClientId,
  clearCustomClientId, getClientId, startLogin,
} from '../../auth.js';
import { logout, startFilming } from '../../app.js';
import { getGame } from '../../game.js';
import { playback } from '../../playback/manager.js';
import {
  isRecordingSupported, isRecordingEnabled, setRecordingEnabled, getMicChoice, setMicChoice, listMicrophones,
} from '../../recording.js';
import { getSavedLyricsSize, resetLyricsSize } from '../lyrics-view.js';
import { canVibrate, isVibrationOn, setVibrationOn, vibrate, PATTERNS } from '../haptics.js';
import { countCachedLyrics, clearLyricsCache } from '../../lyrics.js';
import { getDebugText } from '../../debug.js';
import { confirmDialog } from '../dialogs.js';
import { toast } from '../toast.js';

function maskId(id) {
  return id ? `${id.slice(0, 4)}…${id.slice(-4)}` : '';
}

export default {
  id: 'settings',

  init(el) {
    this.r = refs(el);
    const r = this.r;
    r.back.addEventListener('click', () => this.back());
    r.logout.addEventListener('click', () => this.logout());
    r.resetSize.addEventListener('click', () => {
      resetLyricsSize();
      this.refresh();
      toast('Lyrics size reset');
    });
    r.playback.addEventListener('change', (event) => {
      if (event.target.name !== 'playback') return;
      playback.setMode(event.target.value);
      this.refreshDebug();
    });
    r.vibration.addEventListener('change', () => {
      setVibrationOn(r.vibration.checked);
      if (r.vibration.checked) vibrate(PATTERNS.tick);
    });
    r.record.addEventListener('change', () => {
      setRecordingEnabled(r.record.checked);
      const game = getGame();
      // Switching it on mid-game: start the camera now, inside this tap.
      if (r.record.checked && game && game.phase !== 'over') startFilming();
      this.refreshRecording();
    });
    r.mic.addEventListener('change', () => setMicChoice(r.mic.value));
    r.howto.addEventListener('click', () => go('how-to'));
    r.saveClientId.addEventListener('click', () => this.saveClientId());
    r.resetClientId.addEventListener('click', () => this.resetClientId());
    r.clientId.addEventListener('input', () => {
      r.clientIdError.hidden = true;
    });
    r.clearCache.addEventListener('click', () => this.clearCache());
    r.copyDebug.addEventListener('click', () => this.copyDebug());
    r.advanced.addEventListener('toggle', () => {
      if (r.advanced.open) this.refreshAdvanced();
    });
  },

  show(params = {}, fromId) {
    if (!params.restore) this.fromId = fromId && !['loading', 'how-to', 'settings'].includes(fromId) ? fromId : null;
    if (params.advanced) this.r.advanced.open = true;
    this.refresh();
  },

  back() {
    go(this.fromId ?? (isLoggedIn() ? 'picker' : 'welcome'), { restore: true });
  },

  refresh() {
    const r = this.r;
    const loggedIn = isLoggedIn();
    r.account.textContent = loggedIn ? `Logged in as ${getAuth()?.displayName ?? 'a Spotify user'}` : 'Not logged in';
    r.logout.hidden = !loggedIn;

    const size = getSavedLyricsSize();
    r.lyricsSize.textContent = size ? `Lyrics size: ${size} px` : 'Lyrics size: Default';
    r.resetSize.disabled = !size;

    const mode = playback.getMode();
    for (const input of r.playback.querySelectorAll('input[name="playback"]')) input.checked = input.value === mode;

    const vibrationSupported = canVibrate();
    r.vibration.checked = vibrationSupported && isVibrationOn();
    r.vibration.disabled = !vibrationSupported;
    r.vibrationNote.textContent = vibrationSupported ? 'Android only' : 'Not available on this device';

    this.refreshRecording();

    r.version.textContent = `v${APP_VERSION}`;
    r.repo.href = REPO_URL;
    r.readme.href = README_URL;
    if (r.advanced.open) this.refreshAdvanced();
  },

  async refreshRecording() {
    const r = this.r;
    const supported = isRecordingSupported();
    r.record.checked = supported && isRecordingEnabled();
    r.record.disabled = !supported;
    r.recordUnsupported.hidden = supported;
    r.micField.hidden = !r.record.checked;
    if (!r.record.checked) return;

    // Microphone names are only visible after the camera permission was granted.
    const mics = (await listMicrophones()).filter((m) => m.deviceId && m.label
      && m.deviceId !== 'default' && m.deviceId !== 'communications');
    const choice = getMicChoice();
    const fixed = [...r.mic.querySelectorAll('option')].slice(0, 2);
    const options = mics.map((m) => {
      const option = document.createElement('option');
      option.value = m.deviceId;
      option.textContent = m.label;
      return option;
    });
    r.mic.replaceChildren(...fixed, ...options);
    r.mic.value = [...r.mic.options].some((o) => o.value === choice) ? choice : 'auto';
  },

  refreshAdvanced() {
    const r = this.r;
    const custom = getCustomClientId();
    r.clientId.value = custom ?? '';
    r.clientIdError.hidden = true;
    r.resetClientId.disabled = !custom;
    if (custom) r.clientIdInfo.textContent = `Using your own Spotify app (${maskId(custom)}).`;
    else if (isValidClientId(SPOTIFY_CLIENT_ID)) r.clientIdInfo.textContent = `Using the default Spotify app (${maskId(SPOTIFY_CLIENT_ID)}).`;
    else r.clientIdInfo.textContent = 'No Spotify app is set up yet. Paste a Client ID to use KaraoKry.';
    r.redirectUri.textContent = getRedirectUri();
    countCachedLyrics().then((count) => {
      r.cacheCount.textContent = `${plural(count, 'song')} cached`;
      r.clearCache.disabled = count === 0;
    });
    this.refreshDebug();
  },

  refreshDebug() {
    this.r.debug.textContent = getDebugText({
      'Playback mode': playback.getMode(),
      'Client ID': maskId(getClientId()) || 'none',
      'Logged in': isLoggedIn() ? 'yes' : 'no',
      'Installed app': matchMedia('(display-mode: standalone)').matches ? 'yes' : 'no',
    });
  },

  async logout() {
    const ok = await confirmDialog({
      title: 'Log out?',
      body: 'This also deletes the saved game, if there is one.',
      confirmLabel: 'Log out',
      danger: true,
    });
    if (ok) await logout();
  },

  async saveClientId() {
    const value = this.r.clientId.value.trim();
    if (!isValidClientId(value)) {
      this.r.clientIdError.textContent = "That doesn't look like a Client ID. It should be 32 characters, using 0-9 and a-f.";
      this.r.clientIdError.hidden = false;
      return;
    }
    setCustomClientId(value);
    await this.restartLogin();
  },

  async resetClientId() {
    clearCustomClientId();
    this.refreshAdvanced();
    const auth = getAuth();
    if (auth && auth.clientId !== getClientId()) await this.restartLogin();
    else toast('Using the default Spotify app');
  },

  /** A different Client ID means a fresh login with it. */
  async restartLogin() {
    if (isLoggedIn()) await logout();
    if (!getClientId()) {
      go('welcome');
      return;
    }
    try {
      await startLogin();
    } catch {
      toast("Couldn't open the Spotify login. Try again.");
    }
  },

  async clearCache() {
    const count = await countCachedLyrics();
    const ok = await confirmDialog({
      title: 'Clear the lyrics cache?',
      body: `${plural(count, 'song')} ${count === 1 ? 'is' : 'are'} cached. Their lyrics will be looked up again next time.`,
      confirmLabel: 'Clear cache',
      danger: true,
    });
    if (!ok) return;
    await clearLyricsCache();
    this.refreshAdvanced();
    toast('Lyrics cache cleared');
  },

  async copyDebug() {
    this.refreshDebug();
    try {
      await navigator.clipboard.writeText(this.r.debug.textContent);
      toast('Copied');
    } catch {
      const range = document.createRange();
      range.selectNodeContents(this.r.debug);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      toast("Couldn't copy. The text is selected, so you can copy it yourself.");
    }
  },
};
