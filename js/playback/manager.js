// Chooses and owns the active playback engine (spec section 9.2).
// The rest of the app only talks to `playback`, never to an engine directly, so
// it never needs to know which engine is in use.
//
// Extra events on top of the engine's own:
//   'switched'     Automatic mode moved to the Spotify app engine
//   'replay'       after such a switch mid-round: replay the round's song
//   'track-error'  this one song will not play; skip it

import { lsGet, lsSet, lsRemove } from '../storage.js';
import { setDebug } from '../debug.js';
import { Emitter, EngineUnavailableError } from './engine.js';
import { SdkEngine, loadSdk } from './sdk-engine.js';
import { ConnectEngine } from './connect-engine.js';

const MODE_KEY = 'kk.playbackMode';
// Renamed in 1.2.3: older versions also switched when the in-browser player had only
// lost its connection, so phones get one more try at playing inside KaraoKry.
const ENGINE_KEY = 'kk.engine2';
const OLD_ENGINE_KEY = 'kk.engine';
// Set once the in-browser player has played on this phone. From then on, Automatic
// never switches to the Spotify app by itself.
const SDK_PLAYED_KEY = 'kk.sdkPlayed';
export const MODES = ['auto', 'sdk', 'connect'];
const FORWARDED_EVENTS = ['state', 'ended', 'interrupted'];

const IDLE_POSITION = Object.freeze({ positionMs: 0, durationMs: 0, paused: true, uri: null, current: false });

class PlaybackManager extends Emitter {
  constructor() {
    super();
    this.engine = null;
    this.generation = 0;
    this.unsubscribers = [];
    this.demoFactory = null;
    lsRemove(OLD_ENGINE_KEY);
  }

  getMode() {
    const mode = lsGet(MODE_KEY, 'auto');
    return MODES.includes(mode) ? mode : 'auto';
  }

  /** Changing the mode stops the current engine; the next play starts the new one. */
  setMode(mode) {
    if (!MODES.includes(mode)) return;
    lsSet(MODE_KEY, mode);
    if (mode === 'auto') lsRemove(ENGINE_KEY);
    if (this.engine && this.engine.name !== this.desiredName()) this.reset();
  }

  desiredName() {
    if (this.demoFactory) return 'demo';
    const mode = this.getMode();
    if (mode !== 'auto') return mode;
    return lsGet(ENGINE_KEY) === 'connect' ? 'connect' : 'sdk';
  }

  /** Development only: plays with a simulated engine instead of Spotify (null switches back). */
  useDemo(factory) {
    if (this.demoFactory === factory) return;
    this.demoFactory = factory;
    this.reset();
  }

  get name() {
    return this.engine?.name ?? this.desiredName();
  }

  get deviceId() {
    return this.engine?.deviceId ?? null;
  }

  ensureEngine() {
    const name = this.desiredName();
    if (this.engine?.name !== name) this.attach(this.create(name));
    return this.engine;
  }

  create(name) {
    if (name === 'demo') return this.demoFactory();
    return name === 'connect' ? new ConnectEngine() : new SdkEngine();
  }

  attach(engine) {
    this.detach();
    this.engine = engine;
    this.generation++;
    setDebug('engine', engine.name);
    setDebug('deviceId', null);
    for (const event of FORWARDED_EVENTS) {
      this.unsubscribers.push(engine.on(event, (data) => this.emit(event, data)));
    }
    if (engine.name === 'sdk') {
      const unsubscribe = engine.on('state', () => {
        if (!engine.everPlayed) return;
        lsSet(SDK_PLAYED_KEY, true);
        unsubscribe();
      });
      this.unsubscribers.push(unsubscribe);
    }
    this.unsubscribers.push(engine.on('error', (err) => this.onEngineError(engine, err)));
  }

  detach() {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    const old = this.engine;
    this.engine = null;
    if (old) this.generation++;
    old?.destroy().catch(() => {});
  }

  /** Loads the SDK script early, so the player can be created synchronously inside a tap. */
  preload() {
    if (this.desiredName() === 'sdk') loadSdk().catch(() => {});
  }

  /** Call inside the Start or Resume tap: creates the engine and connects in the background. */
  prepare({ newGame = false } = {}) {
    const engine = this.ensureEngine();
    if (newGame) engine.newGame?.();
    engine.unlock();
    engine.init().catch((err) => {
      if (engine === this.engine && this.canFallBack(engine, err)) this.fallBack();
    });
  }

  /** Call synchronously inside a tap, before anything plays. */
  unlock() {
    this.ensureEngine().unlock();
  }

  /** True once the in-browser player has played on this phone, in this game or before. */
  sdkHasPlayed(engine) {
    return Boolean(engine.everPlayed) || lsGet(SDK_PLAYED_KEY, false) === true;
  }

  /**
   * Automatic mode switches to the Spotify app only on a phone where playing inside
   * KaraoKry has never worked. Where it has, a failure is shown with "Try again" instead.
   */
  canFallBack(engine, err) {
    return this.getMode() === 'auto' && engine.name === 'sdk' && err instanceof EngineUnavailableError
      && !this.sdkHasPlayed(engine);
  }

  fallBack() {
    lsSet(ENGINE_KEY, 'connect');
    this.attach(new ConnectEngine());
    this.emit('switched', 'connect');
  }

  onEngineError(engine, err) {
    if (engine !== this.engine) return;
    // Start-up failures reach the caller through init() and playTrack() instead.
    if (err.kind === 'init') return;
    if (err.kind === 'playback' && engine.name === 'sdk') {
      // A phone that never managed to play (DRM or Widevine trouble) falls back to the
      // Spotify app. Once songs have played fine, an error means this one song is the problem.
      if (this.sdkHasPlayed(engine)) {
        this.emit('track-error');
      } else if (this.getMode() === 'auto') {
        this.fallBack();
        this.emit('replay');
      } else {
        this.emit('error', { kind: 'engine-failed', message: err.message });
      }
      return;
    }
    this.emit('error', err);
  }

  async playTrack(uri, positionMs = 0) {
    const engine = this.ensureEngine();
    try {
      await engine.playTrack(uri, positionMs);
    } catch (err) {
      if (engine === this.engine && this.canFallBack(engine, err)) {
        this.fallBack();
        return this.engine.playTrack(uri, positionMs);
      }
      throw err;
    }
  }

  async pause() {
    await this.engine?.pause();
  }

  async resume() {
    await this.engine?.resume();
  }

  async seek(positionMs) {
    await this.engine?.seek(positionMs);
  }

  getPosition() {
    return this.engine?.getPosition() ?? IDLE_POSITION;
  }

  /** Connect engine only: waits (up to 60 s) for the Spotify app to appear. */
  async waitForSpotifyApp({ signal } = {}) {
    const engine = this.ensureEngine();
    return engine.waitForDevice ? engine.waitForDevice({ signal }) : true;
  }

  /** Stops and forgets the current engine. */
  reset() {
    this.detach();
  }
}

export const playback = new PlaybackManager();
