import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setAuthHooks } from '../js/spotify-api.js';
import { SdkEngine } from '../js/playback/sdk-engine.js';
import { EngineUnavailableError } from '../js/playback/engine.js';
import { playback } from '../js/playback/manager.js';

const SONG = 'spotify:track:song';
const realFetch = globalThis.fetch;

/** A stand-in for Spotify.Player: every connect() comes back with a new device id. */
class FakePlayer {
  static devices = 0;

  constructor() {
    this.listeners = new Map();
  }

  addListener(event, fn) {
    this.listeners.set(event, fn);
  }

  emit(event, data) {
    this.listeners.get(event)?.(data);
  }

  async connect() {
    const deviceId = `device${++FakePlayer.devices}`;
    setTimeout(() => this.emit('ready', { device_id: deviceId }), 5);
    return true;
  }

  disconnect() {}
  activateElement() {}
  async pause() {}
  async getCurrentState() {
    return null;
  }
}

/** Spotify's answers to "play": devices in `forgotten` get "Device not found". */
function fakeSpotify(forgotten) {
  const played = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/me/player/play') {
      const deviceId = u.searchParams.get('device_id');
      if (forgotten.has(deviceId)) {
        return new Response(JSON.stringify({ error: { status: 404, message: 'Device not found' } }), { status: 404 });
      }
      played.push({ deviceId, body: JSON.parse(init.body) });
    }
    return new Response(null, { status: 204 });
  };
  return played;
}

let engine;

beforeEach(() => {
  FakePlayer.devices = 0;
  globalThis.window = { Spotify: { Player: FakePlayer } };
  globalThis.document = { hidden: true };
  setAuthHooks({ getToken: async () => 't', forceRefresh: async () => {} });
});

afterEach(async () => {
  await engine?.destroy();
  engine = null;
  globalThis.fetch = realFetch;
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.localStorage;
});

test('a player Spotify has forgotten connects again and plays on its new device', async () => {
  const played = fakeSpotify(new Set(['device1']));
  engine = new SdkEngine();
  await engine.init();
  assert.equal(engine.deviceId, 'device1');
  await engine.playTrack(SONG, 0);
  assert.equal(engine.deviceId, 'device2');
  assert.deepEqual(played.map((p) => p.deviceId), ['device2']);
  assert.equal(played[0].body.uris[0], SONG);
});

test('a player that went offline between songs connects again before playing', async () => {
  const played = fakeSpotify(new Set());
  engine = new SdkEngine();
  await engine.init();
  engine.player.emit('not_ready', { device_id: 'device1' });
  assert.equal(engine.deviceId, null);
  await engine.playTrack(SONG, 0);
  assert.notEqual(engine.deviceId, null);
  assert.deepEqual(played.map((p) => p.deviceId), [engine.deviceId]);
});

test('the old player going offline after a reconnect leaves the new device alone', async () => {
  fakeSpotify(new Set());
  engine = new SdkEngine();
  await engine.init();
  await engine.reconnect();
  assert.equal(engine.deviceId, 'device2');
  engine.player.emit('not_ready', { device_id: 'device1' });
  assert.equal(engine.deviceId, 'device2');
});

test('Automatic switches to the Spotify app only if playing inside KaraoKry never worked on this phone', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  const failure = new EngineUnavailableError('Device not found');
  assert.equal(playback.canFallBack({ name: 'sdk', everPlayed: false }, failure), true);
  assert.equal(playback.canFallBack({ name: 'sdk', everPlayed: true }, failure), false, 'it played in this game');
  store.set('kk.sdkPlayed', 'true');
  assert.equal(playback.canFallBack({ name: 'sdk', everPlayed: false }, failure), false, 'it played here before');
  assert.equal(playback.canFallBack({ name: 'connect', everPlayed: false }, failure), false);
});
