// The PlaybackEngine interface, its error types, and the end-of-song detector
// shared by both engines.
//
// Both engines implement exactly this shape:
// {
//   name,                       // 'sdk' or 'connect'
//   async init(),               // get a device ready; throws EngineUnavailableError if impossible
//   unlock(),                   // call synchronously inside a user tap, before any play
//   async playTrack(uri, positionMs = 0),
//   async pause(),
//   async resume(),
//   async seek(positionMs),
//   getPosition(),              // cheap local estimate: { positionMs, durationMs, paused, uri, current }
//   on(eventName, handler),     // 'state', 'ended', 'interrupted', 'error'
//   async destroy()
// }
//
// 'error' events carry { kind, message? } where kind is one of:
//   'premium'     Spotify Premium is needed (do not fall back)
//   'auth'        the login is no longer valid
//   'init'        the engine could not start
//   'playback'    the engine failed to play
//   'autoplay'    the browser blocked audio until the next tap
//   'not_ready'   the device went offline; the engine is reconnecting
//   'reconnected' the device is back after 'not_ready'
//   'network'     a request failed because of the connection

export class EngineUnavailableError extends Error {
  constructor(message = 'Playback engine unavailable') {
    super(message);
    this.name = 'EngineUnavailableError';
  }
}

export class PremiumRequiredError extends Error {
  constructor() {
    super('Spotify Premium required');
    this.name = 'PremiumRequiredError';
  }
}

export class TrackUnplayableError extends Error {
  constructor(message = 'Track cannot be played') {
    super(message);
    this.name = 'TrackUnplayableError';
  }
}

/** Connect engine only: the Spotify app is not running on this phone. */
export class NeedsSpotifyAppError extends Error {
  constructor() {
    super('Spotify app not available');
    this.name = 'NeedsSpotifyAppError';
  }
}

export function isPremiumError(err) {
  return err?.status === 403 && err?.reason === 'PREMIUM_REQUIRED';
}

export function isDeviceError(err) {
  return err?.reason === 'NO_ACTIVE_DEVICE' || (err?.status === 404 && /device/i.test(err?.message ?? ''));
}

export class Emitter {
  #handlers = new Map();

  on(event, fn) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(fn);
    return () => this.#handlers.get(event)?.delete(fn);
  }

  emit(event, data) {
    for (const fn of [...(this.#handlers.get(event) ?? [])]) {
      try {
        fn(data);
      } catch (err) {
        console.error(err);
      }
    }
  }

  removeAllListeners() {
    this.#handlers.clear();
  }
}

const NOTHING = Object.freeze({ ours: false, event: null, pauseOther: false });

/**
 * Watches normalized playback states ({ uri, altUri?, positionMs, durationMs, paused })
 * and works out whether the round's song ended, was replaced by Spotify's autoplay,
 * or was taken over by someone else (spec section 9.5).
 */
export class EndDetector {
  constructor({ endWindowMs = 2000, substituteAfterMs = 1500 } = {}) {
    this.endWindowMs = endWindowMs;
    this.substituteAfterMs = substituteAfterMs;
    this.stop();
  }

  /** Call right before asking Spotify to play `requestedUri`. */
  start(requestedUri, uriBefore = null, now = performance.now()) {
    this.requested = requestedUri;
    this.before = uriBefore;
    this.startedAt = now;
    this.observed = null;
    this.last = null;
    this.ended = false;
    this.halted = false;
  }

  stop() {
    this.requested = null;
    this.before = null;
    this.startedAt = 0;
    this.observed = null;
    this.last = null;
    this.ended = false;
    this.halted = false;
  }

  /** Records a local command (pause, seek) so the next comparison uses the right position. */
  note(patch, now = performance.now()) {
    if (this.last) this.last = { ...this.last, ...patch, at: now };
  }

  estimate(now) {
    if (!this.last) return 0;
    return this.last.paused ? this.last.positionMs : this.last.positionMs + (now - this.last.at);
  }

  wasNearEnd(now) {
    return Boolean(this.last) && this.last.durationMs > 0
      && this.estimate(now) >= this.last.durationMs - this.endWindowMs;
  }

  /**
   * @param {null|{uri: string, altUri?: string, positionMs: number, durationMs: number, paused: boolean}} state
   * @returns {{ours: boolean, event: null|'ended'|'interrupted', pauseOther: boolean}}
   *   ours: the state belongs to the round's song and may be shown.
   *   event 'ended': the song finished. 'interrupted': someone else took over before the end.
   *   pauseOther: another song is playing after the end (Spotify's autoplay) and must be paused.
   */
  update(state, now = performance.now()) {
    if (!this.requested || this.halted) return NOTHING;

    if (!this.observed) {
      if (!state?.uri) return NOTHING;
      const exact = state.uri === this.requested || state.altUri === this.requested;
      // Spotify may substitute an equivalent version of the track. Only accept a
      // different URI once it cannot be the stale state from before the play call.
      const substitute = state.uri !== this.before && now - this.startedAt >= this.substituteAfterMs;
      if (!exact && !substitute) return NOTHING;
      this.observed = state.uri;
    }

    if (state?.uri === this.observed) {
      if (this.ended) return NOTHING;
      const endedNow = this.wasNearEnd(now) && state.paused
        && (state.positionMs <= 1000 || state.positionMs >= state.durationMs - 1000);
      this.last = { ...state, at: now };
      if (endedNow) {
        this.ended = true;
        return { ours: true, event: 'ended', pauseOther: false };
      }
      return { ours: true, event: null, pauseOther: false };
    }

    // A different track, or nothing at all.
    const otherPlaying = Boolean(state && !state.paused);
    if (this.ended) return { ours: false, event: null, pauseOther: otherPlaying };
    if (this.wasNearEnd(now)) {
      this.ended = true;
      return { ours: false, event: 'ended', pauseOther: otherPlaying };
    }
    if (!state) {
      if (this.last && !this.last.paused) {
        this.halted = true;
        return { ours: false, event: 'interrupted', pauseOther: false };
      }
      return NOTHING;
    }
    this.halted = true;
    return { ours: false, event: 'interrupted', pauseOther: otherPlaying };
  }
}
