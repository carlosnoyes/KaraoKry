// Primary engine: plays inside KaraoKry with Spotify's Web Playback SDK.
// Audio comes out of the phone's current output (the singer's headphones).
// Pause, resume, seek and position use the SDK itself, with no Web API calls.

import { api, sleep } from '../spotify-api.js';
import { getValidToken, refreshAccessToken } from '../auth.js';
import { setDebug, recordError } from '../debug.js';
import {
  Emitter, EndDetector, EngineUnavailableError, PremiumRequiredError, TrackUnplayableError,
  isPremiumError, isDeviceError,
} from './engine.js';

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
const SDK_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 10_000;
const POLL_MS = 500;
const DEVICE_RETRIES = 3;

let sdkPromise = null;

/** Loads the SDK script once. Rejects with EngineUnavailableError when blocked or slow. */
export function loadSdk() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    if (window.Spotify?.Player) return resolve(window.Spotify);
    const timer = setTimeout(() => reject(new EngineUnavailableError('SDK load timed out')), SDK_TIMEOUT_MS);
    window.onSpotifyWebPlaybackSDKReady = () => {
      clearTimeout(timer);
      resolve(window.Spotify);
    };
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onerror = () => {
      clearTimeout(timer);
      script.remove();
      reject(new EngineUnavailableError('SDK script failed to load'));
    };
    document.head.append(script);
  });
  sdkPromise.catch(() => {
    sdkPromise = null;
  });
  return sdkPromise;
}

function normalizeState(s) {
  if (!s) return null;
  const track = s.track_window?.current_track;
  return {
    uri: track?.uri ?? null,
    altUri: track?.linked_from?.uri ?? null,
    positionMs: s.position ?? 0,
    durationMs: s.duration || track?.duration_ms || 0,
    paused: Boolean(s.paused),
    loading: Boolean(s.loading),
  };
}

export class SdkEngine extends Emitter {
  name = 'sdk';

  constructor() {
    super();
    this.player = null;
    this.deviceId = null;
    this.readyPromise = null;
    this.pendingReady = null;
    this.state = null;
    this.stateAt = 0;
    this.detector = new EndDetector();
    this.pollTimer = null;
    this.settingsApplied = false;
    this.authRetried = false;
    this.reconnecting = false;
    this.everPlayed = false;
    this.destroyed = false;
  }

  /** Creates the player synchronously when the SDK script is already loaded. */
  createPlayer() {
    if (this.player || this.destroyed || !window.Spotify?.Player) return Boolean(this.player);
    const player = new window.Spotify.Player({
      name: 'KaraoKry',
      getOAuthToken: (cb) => {
        getValidToken().then(cb, () => cb(''));
      },
      volume: 1.0,
    });

    player.addListener('ready', ({ device_id: deviceId }) => {
      this.deviceId = deviceId;
      setDebug('deviceId', deviceId);
      this.pendingReady?.resolve();
      this.pendingReady = null;
      if (this.reconnecting) {
        this.reconnecting = false;
        this.emit('error', { kind: 'reconnected' });
      }
    });
    player.addListener('not_ready', ({ device_id: deviceId }) => {
      // Ignore the old player going offline after reconnect() has asked for a new one.
      if (deviceId !== this.deviceId) return;
      this.deviceId = null;
      this.reconnecting = true;
      this.emit('error', { kind: 'not_ready' });
      player.connect().catch(() => {});
    });
    player.addListener('initialization_error', ({ message }) => {
      recordError('SDK initialization_error', { message });
      this.failReady(new EngineUnavailableError(message));
      this.emit('error', { kind: 'init', message });
    });
    player.addListener('authentication_error', ({ message }) => {
      recordError('SDK authentication_error', { message });
      if (this.authRetried) {
        this.failReady(new EngineUnavailableError(message));
        this.emit('error', { kind: 'auth', message });
        return;
      }
      this.authRetried = true;
      refreshAccessToken()
        .then(() => {
          player.disconnect();
          return player.connect();
        })
        .catch(() => {
          this.failReady(new EngineUnavailableError(message));
          this.emit('error', { kind: 'auth', message });
        });
    });
    player.addListener('account_error', ({ message }) => {
      recordError('SDK account_error', { message });
      this.failReady(new PremiumRequiredError());
      this.emit('error', { kind: 'premium', message });
    });
    player.addListener('playback_error', ({ message }) => {
      recordError('SDK playback_error', { message });
      this.emit('error', { kind: 'playback', message });
    });
    player.addListener('autoplay_failed', () => {
      this.emit('error', { kind: 'autoplay' });
    });
    player.addListener('player_state_changed', (state) => this.handleState(normalizeState(state)));

    this.player = player;
    return true;
  }

  failReady(err) {
    this.pendingReady?.reject(err);
    this.pendingReady = null;
  }

  init() {
    if (this.destroyed) return Promise.reject(new EngineUnavailableError('Engine destroyed'));
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      await loadSdk();
      this.createPlayer();
      if (this.deviceId) return;
      let timer;
      const ready = new Promise((resolve, reject) => {
        const deferred = { resolve, reject };
        this.pendingReady = deferred;
        timer = setTimeout(() => {
          if (this.pendingReady === deferred) this.failReady(new EngineUnavailableError('SDK never became ready'));
        }, READY_TIMEOUT_MS);
      });
      // Stops the timer once settled. Also avoids an unhandled rejection if connect() fails first.
      ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
      const connected = await this.player.connect();
      if (!connected) {
        this.pendingReady = null;
        throw new EngineUnavailableError('SDK connect() returned false');
      }
      await ready;
    })();
    this.readyPromise.catch(() => {
      this.readyPromise = null;
    });
    return this.readyPromise;
  }

  /**
   * Connects the player again for a new device. Spotify forgets a player that has been
   * quiet for a while, or whose page the phone put to sleep (an iPhone switching apps),
   * and playing on it then fails with "Device not found".
   */
  async reconnect() {
    setDebug('deviceId', 'reconnecting');
    this.readyPromise = null;
    this.deviceId = null;
    this.player?.disconnect();
    await this.init();
  }

  /** Must run synchronously inside a tap: lets the browser start audio later. */
  unlock() {
    this.createPlayer();
    try {
      this.player?.activateElement?.();
    } catch {
      // activateElement is best effort
    }
  }

  /** Called when a new game starts, so repeat and shuffle are switched off again. */
  newGame() {
    this.settingsApplied = false;
  }

  async playTrack(uri, positionMs = 0) {
    await this.init();
    if (!this.deviceId) await this.reconnect();
    this.detector.start(uri, this.state?.uri ?? null);
    const body = { uris: [uri], position_ms: Math.max(0, Math.round(positionMs)) };

    for (let attempt = 0; ; attempt++) {
      try {
        await api(`/me/player/play?device_id=${encodeURIComponent(this.deviceId)}`, { method: 'PUT', body });
        break;
      } catch (err) {
        if (isPremiumError(err)) throw new PremiumRequiredError();
        if (err?.status === 404 && attempt < DEVICE_RETRIES) {
          // Just after connecting, Spotify may not know the player yet, so wait. If it still
          // doesn't, it has forgotten the player: connect again for a new device.
          if (attempt === DEVICE_RETRIES - 1 && isDeviceError(err)) await this.reconnect();
          else await sleep(1000);
          continue;
        }
        if (err?.status === 404) {
          throw isDeviceError(err) ? new EngineUnavailableError('Device not found') : new TrackUnplayableError(err.message);
        }
        if (err?.status === 403) throw new TrackUnplayableError(err.message);
        throw err;
      }
    }

    // Show the requested start position until the first state arrives.
    this.state = { uri, positionMs: body.position_ms, durationMs: 0, paused: false, loading: true };
    this.stateAt = performance.now();
    this.startPolling();

    if (!this.settingsApplied) {
      this.settingsApplied = true;
      const id = encodeURIComponent(this.deviceId);
      api(`/me/player/repeat?state=off&device_id=${id}`, { method: 'PUT' }).catch(() => {});
      api(`/me/player/shuffle?state=false&device_id=${id}`, { method: 'PUT' }).catch(() => {});
    }
  }

  async pause() {
    if (!this.player) return;
    this.applyLocal({ paused: true });
    await this.player.pause();
  }

  async resume() {
    if (!this.player) return;
    this.applyLocal({ paused: false });
    await this.player.resume();
  }

  async seek(positionMs) {
    if (!this.player) return;
    this.applyLocal({ positionMs: Math.max(0, Math.round(positionMs)) });
    await this.player.seek(Math.max(0, Math.round(positionMs)));
  }

  applyLocal(patch) {
    if (!this.state) return;
    const now = performance.now();
    const positionMs = this.getPosition().positionMs;
    this.state = { ...this.state, positionMs, ...patch };
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

  handleState(state) {
    if (this.destroyed) return;
    const now = performance.now();
    const result = this.detector.update(state, now);
    if (result.ours && state && result.event !== 'ended') {
      this.state = state;
      this.stateAt = now;
      if (!state.paused && !state.loading) {
        this.everPlayed = true;
        this.authRetried = false;
      }
      this.emit('state', this.getPosition());
    }
    if (result.pauseOther) this.player?.pause().catch(() => {});
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

  startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(async () => {
      if (!this.player || document.hidden) return;
      try {
        this.handleState(normalizeState(await this.player.getCurrentState()));
      } catch {
        // ignore a failed read; the next tick tries again
      }
    }, POLL_MS);
  }

  async destroy() {
    this.destroyed = true;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.detector.stop();
    this.removeAllListeners();
    const player = this.player;
    this.player = null;
    this.deviceId = null;
    if (player) {
      try {
        await player.pause();
      } catch {
        // ignore
      }
      player.disconnect();
    }
  }
}
