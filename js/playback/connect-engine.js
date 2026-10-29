// Fallback engine: remote-controls the Spotify app on this phone through
// Spotify Connect. Needs the Spotify app installed and logged in to the same
// account. Position comes from GET /me/player, polled sparingly.

import { api, sleep } from '../spotify-api.js';
import { setDebug } from '../debug.js';
import {
  Emitter, EndDetector, PremiumRequiredError, TrackUnplayableError, NeedsSpotifyAppError,
  isPremiumError, isDeviceError,
} from './engine.js';

const POLL_PLAYING_MS = 3000;
const POLL_AFTER_COMMAND_MS = 300;
const DEVICE_POLL_MS = 2000;
const DEVICE_WAIT_MS = 60_000;

/**
 * Picks the phone's Spotify app. Prefers a smartphone (the active one first) so a
 * computer or speaker elsewhere in the house is never chosen by accident.
 */
export function chooseDevice(devices) {
  const usable = (devices ?? []).filter((d) => d?.id && !d.is_restricted && d.name !== 'KaraoKry');
  const phones = usable.filter((d) => String(d.type).toLowerCase() === 'smartphone');
  return phones.find((d) => d.is_active) ?? phones[0] ?? usable.find((d) => d.is_active) ?? null;
}

function normalizeState(data) {
  if (!data?.item) return null;
  return {
    uri: data.item.uri ?? null,
    altUri: data.item.linked_from?.uri ?? null,
    positionMs: data.progress_ms ?? 0,
    durationMs: data.item.duration_ms ?? 0,
    paused: !data.is_playing,
    deviceId: data.device?.id ?? null,
  };
}

export class ConnectEngine extends Emitter {
  name = 'connect';

  constructor() {
    super();
    this.deviceId = null;
    this.state = null;
    this.stateAt = 0;
    this.detector = new EndDetector();
    this.pollTimer = null;
    this.pollWhenVisible = false;
    this.settingsApplied = false;
    this.destroyed = false;
    this.onVisible = () => {
      if (!document.hidden && this.pollWhenVisible) {
        this.pollWhenVisible = false;
        this.schedulePoll(0);
      }
    };
    document.addEventListener('visibilitychange', this.onVisible);
  }

  async findDevice() {
    const data = await api('/me/player/devices');
    const device = chooseDevice(data?.devices);
    if (device) {
      this.deviceId = device.id;
      setDebug('deviceId', `${device.id} (${device.type})`);
    }
    return device;
  }

  async init() {
    if (this.deviceId) return;
    const device = await this.findDevice();
    if (!device) throw new NeedsSpotifyAppError();
  }

  /** Polls the device list every 2 s for up to 60 s. Resolves true once the Spotify app shows up. */
  async waitForDevice({ signal } = {}) {
    const until = Date.now() + DEVICE_WAIT_MS;
    while (Date.now() < until) {
      try {
        if (await this.findDevice()) return true;
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        if (isPremiumError(err)) throw new PremiumRequiredError();
      }
      await sleep(DEVICE_POLL_MS, signal);
    }
    return false;
  }

  unlock() {
    // Nothing to unlock: the Spotify app plays the audio.
  }

  newGame() {
    this.settingsApplied = false;
  }

  device() {
    return encodeURIComponent(this.deviceId);
  }

  /** Runs a player command, mapping Premium errors. */
  async command(path, options) {
    try {
      return await api(path, options);
    } catch (err) {
      if (isPremiumError(err)) throw new PremiumRequiredError();
      throw err;
    }
  }

  async playTrack(uri, positionMs = 0) {
    await this.init();
    this.detector.start(uri, this.state?.uri ?? null);
    const body = { uris: [uri], position_ms: Math.max(0, Math.round(positionMs)) };
    const play = () => this.command(`/me/player/play?device_id=${this.device()}`, { method: 'PUT', body });
    try {
      await play();
    } catch (err) {
      if (err?.status !== 404) {
        if (err?.status === 403) throw new TrackUnplayableError(err.message);
        throw err;
      }
      // The phone is not the active device yet: transfer playback, then try once more.
      try {
        await this.command('/me/player', { method: 'PUT', body: { device_ids: [this.deviceId], play: false } });
        await play();
      } catch (retryErr) {
        if (retryErr instanceof PremiumRequiredError) throw retryErr;
        if (retryErr?.status === 404 && isDeviceError(retryErr)) {
          this.deviceId = null;
          throw new NeedsSpotifyAppError();
        }
        if (retryErr?.status === 404 || retryErr?.status === 403) throw new TrackUnplayableError(retryErr.message);
        throw retryErr;
      }
    }

    this.state = { uri, positionMs: body.position_ms, durationMs: 0, paused: false, deviceId: this.deviceId, loading: true };
    this.stateAt = performance.now();
    this.schedulePoll(POLL_AFTER_COMMAND_MS);

    if (!this.settingsApplied) {
      this.settingsApplied = true;
      api(`/me/player/repeat?state=off&device_id=${this.device()}`, { method: 'PUT' }).catch(() => {});
      api(`/me/player/shuffle?state=false&device_id=${this.device()}`, { method: 'PUT' }).catch(() => {});
    }
  }

  async pause() {
    if (!this.deviceId) return;
    this.applyLocal({ paused: true });
    await this.command(`/me/player/pause?device_id=${this.device()}`, { method: 'PUT' });
    this.schedulePoll(POLL_AFTER_COMMAND_MS);
  }

  async resume() {
    if (!this.deviceId) return;
    this.applyLocal({ paused: false });
    await this.command(`/me/player/play?device_id=${this.device()}`, { method: 'PUT' });
    this.schedulePoll(POLL_AFTER_COMMAND_MS);
  }

  async seek(positionMs) {
    if (!this.deviceId) return;
    const ms = Math.max(0, Math.round(positionMs));
    this.applyLocal({ positionMs: ms });
    await this.command(`/me/player/seek?position_ms=${ms}&device_id=${this.device()}`, { method: 'PUT' });
    this.schedulePoll(POLL_AFTER_COMMAND_MS);
  }

  applyLocal(patch) {
    if (!this.state) return;
    const now = performance.now();
    this.state = { ...this.state, positionMs: this.getPosition().positionMs, ...patch };
    this.stateAt = now;
    this.detector.note({ positionMs: this.state.positionMs, paused: this.state.paused }, now);
  }

  getPosition() {
    const s = this.state;
    if (!s) return { positionMs: 0, durationMs: 0, paused: true, uri: null, current: false };
    const elapsed = s.paused || s.loading ? 0 : performance.now() - this.stateAt;
    const positionMs = s.durationMs ? Math.min(s.durationMs, s.positionMs + elapsed) : s.positionMs + elapsed;
    return {
      positionMs,
      durationMs: s.durationMs,
      paused: s.paused,
      uri: s.uri,
      current: Boolean(this.detector.requested) && !this.detector.halted,
    };
  }

  schedulePoll(delayMs) {
    clearTimeout(this.pollTimer);
    if (this.destroyed) return;
    this.pollTimer = setTimeout(() => this.poll(), delayMs);
  }

  async poll() {
    if (this.destroyed || !this.detector.requested) return;
    if (document.hidden) {
      this.pollWhenVisible = true;
      return;
    }
    let state;
    try {
      state = normalizeState(await api('/me/player'));
    } catch (err) {
      if (err?.code === 'network') this.emit('error', { kind: 'network' });
      if (this.state && !this.state.paused) this.schedulePoll(POLL_PLAYING_MS);
      return;
    }
    this.handleState(state);

    // Keep polling only while playing. Poll again right after the song should end,
    // so Spotify's autoplay is caught quickly.
    if (this.state && !this.state.paused && !this.detector.ended && !this.detector.halted) {
      const remaining = this.state.durationMs ? this.state.durationMs - this.getPosition().positionMs : Infinity;
      this.schedulePoll(Math.max(POLL_AFTER_COMMAND_MS, Math.min(POLL_PLAYING_MS, remaining + 500)));
    }
  }

  handleState(state) {
    const now = performance.now();
    let result;
    // Another device taking over before the end counts as an interruption.
    const otherDevice = Boolean(state?.deviceId && this.deviceId && state.deviceId !== this.deviceId);
    if (otherDevice && this.detector.observed && !this.detector.ended && !this.detector.halted
      && !this.detector.wasNearEnd(now)) {
      this.detector.halted = true;
      result = { ours: false, event: 'interrupted', pauseOther: !state.paused };
    } else {
      result = this.detector.update(state, now);
    }

    if (result.ours && state && result.event !== 'ended') {
      this.state = state;
      this.stateAt = now;
      this.emit('state', this.getPosition());
    }
    if (result.pauseOther) api('/me/player/pause', { method: 'PUT' }).catch(() => {});
    if (result.event === 'ended') {
      if (this.state) {
        this.state = { ...this.state, paused: true, positionMs: this.state.durationMs, loading: false };
        this.stateAt = now;
      }
      this.emit('ended');
    } else if (result.event === 'interrupted') {
      if (this.state) this.state = { ...this.state, paused: true, loading: false };
      this.emit('interrupted');
    }
  }

  async destroy() {
    this.destroyed = true;
    clearTimeout(this.pollTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
    const wasPlaying = this.state && !this.state.paused && this.deviceId;
    this.detector.stop();
    this.removeAllListeners();
    if (wasPlaying) await api(`/me/player/pause?device_id=${this.device()}`, { method: 'PUT' }).catch(() => {});
    this.deviceId = null;
  }
}
