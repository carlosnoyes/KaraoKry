// Development-only demo mode, offered on 127.0.0.1 / localhost.
// Lets you play through every game screen without Spotify: five made-up songs
// with original placeholder lyrics, and an engine that simulates playback
// silently. On a computer without a camera, a test pattern with a beep stands in
// for the singer's video. It is never loaded on the published site.

import { Emitter } from '../playback/engine.js';
import { newGame } from '../game.js';
import { shuffle } from '../prepare.js';
import { enterGame } from '../app.js';
import { go } from '../router.js';
import { setFallbackStream } from '../recording.js';

const VERSES = [
  ['Neon on the ceiling, glitter on the floor', 'Somebody is knocking on the karaoke door',
    'Hand me the microphone and turn the speakers high', 'Tonight we sing the wrong words and we never wonder why',
    '', 'Oh oh, the chorus goes around', 'Oh oh, we never touch the ground', 'Sing it wrong, sing it loud',
    'Sing it to the crowd'],
  ['Paper boats are sailing down the kitchen sink', 'Coffee in the morning is the colour of my ink',
    'Every little postcard says I miss you more', 'Every little raincloud knocks upon my door',
    '', 'And I keep on writing', 'Keep on writing you', 'Letters made of thunder', 'Sentences of blue'],
  ['Running down the highway with the windows down', 'Radio is playing every song in town',
    'Cactus in the mirror and the sun is gold', 'We are never young and we are never old',
    '', 'Drive, drive, into the light', 'Drive, drive, all through the night'],
  ['Tiny little robot with a heart of tin', 'Waiting at the station for the train to roll in',
    'Beep beep boop he sings a lonely tune', 'Dancing with his shadow underneath the moon',
    '', 'Robot, robot, do you feel the beat', 'Robot, robot, move your metal feet'],
  ['Grandma has a secret recipe for pie', 'Nobody has seen it and nobody knows why',
    'Cinnamon and stardust and a pinch of rain', 'Every single slice will make you smile again',
    '', 'Pie in the sky, pie in the sky', 'One more slice before we say goodbye'],
];

const SONGS = [
  { name: 'Neon Microphone', artists: ['The Wrong Notes'], album: 'Karaoke Nights', durationMs: 75_000,
    instrumentalStretches: [{ start: 0, end: 18 }, { start: 40, end: 58 }] },
  { name: 'Paper Boats', artists: ['Clementine Ray'], album: 'Kitchen Sink', durationMs: 90_000,
    instrumentalStretches: [] },
  { name: 'Desert Highway', artists: ['Cactus Club', 'Dana Vee'], album: 'Gold', durationMs: 80_000,
    instrumentalStretches: [{ start: 50, end: 70 }] },
  { name: 'Tin Heart Robot', artists: ['Beep Boop Band'], album: 'Station', durationMs: 70_000,
    instrumentalStretches: [] },
  { name: 'Pie in the Sky (Grandma\'s Version)', artists: ['The Bakers'], album: 'Recipes', durationMs: 85_000,
    instrumentalStretches: [{ start: 0, end: 20 }] },
];

export const DEMO_PLAYLIST = { id: 'demo', name: 'Demo playlist', imageUrl: null };

export function demoSongs() {
  return SONGS.map((song, i) => ({
    id: `demo${i + 1}`,
    uri: `spotify:track:demo${i + 1}`,
    imageUrl: null,
    imageUrlSmall: null,
    explicit: false,
    lyrics: VERSES[i].join('\n'),
    ...song,
  }));
}

const TICK_MS = 500;

/** Simulates a playback engine with timers. Same interface as the real engines. */
export class DemoEngine extends Emitter {
  name = 'demo';

  constructor(songs) {
    super();
    this.durations = new Map(songs.map((s) => [s.uri, s.durationMs]));
    this.state = null;
    this.stateAt = 0;
    this.timer = null;
    this.deviceId = 'demo-device';
  }

  async init() {}

  unlock() {}

  newGame() {}

  async playTrack(uri, positionMs = 0) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    this.state = { uri, positionMs, durationMs: this.durations.get(uri) ?? 60_000, paused: false };
    this.stateAt = performance.now();
    this.tick();
  }

  async pause() {
    this.patch({ paused: true });
  }

  async resume() {
    this.patch({ paused: false });
  }

  async seek(positionMs) {
    this.patch({ positionMs });
  }

  patch(change) {
    if (!this.state) return;
    this.state = { ...this.state, positionMs: this.getPosition().positionMs, ...change };
    this.stateAt = performance.now();
    this.emit('state', this.getPosition());
  }

  getPosition() {
    const s = this.state;
    if (!s) return { positionMs: 0, durationMs: 0, paused: true, uri: null, current: false };
    const elapsed = s.paused ? 0 : performance.now() - this.stateAt;
    return { positionMs: Math.min(s.durationMs, s.positionMs + elapsed), durationMs: s.durationMs,
      paused: s.paused, uri: s.uri, current: true };
  }

  tick() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.state) return;
      const pos = this.getPosition();
      if (!pos.paused && pos.positionMs >= pos.durationMs) {
        this.state = { ...this.state, positionMs: pos.durationMs, paused: true };
        this.stateAt = performance.now();
        this.emit('ended');
        return;
      }
      this.emit('state', pos);
      this.tick();
    }, TICK_MS);
  }

  async destroy() {
    clearTimeout(this.timer);
    this.removeAllListeners();
  }
}

const demoEngineFactory = () => new DemoEngine(demoSongs());

/** A moving test pattern with a clock and a quiet beep every second. */
function testPatternStream() {
  const canvas = document.createElement('canvas');
  canvas.width = 360;
  canvas.height = 640;
  const ctx = canvas.getContext('2d');
  const started = performance.now();
  let stream = null;
  const draw = () => {
    if (stream && stream.getVideoTracks().every((track) => track.readyState === 'ended')) return;
    const t = (performance.now() - started) / 1000;
    const hue = (t * 40) % 360;
    ctx.fillStyle = `hsl(${hue} 60% 18%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#FF2E97';
    ctx.beginPath();
    ctx.arc(180 + Math.sin(t * 2) * 120, 320 + Math.cos(t * 1.4) * 200, 40, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#F5F0FF';
    ctx.font = 'bold 40px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('DEMO CAMERA', 180, 90);
    ctx.fillText(`${t.toFixed(1)} s`, 180, 580);
    requestAnimationFrame(draw);
  };
  draw();
  stream = canvas.captureStream(30);

  try {
    const audio = new AudioContext();
    const destination = audio.createMediaStreamDestination();
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    // A faint hum between the beeps, like the noise a real microphone always picks up.
    const HUM = 0.004;
    gain.gain.value = HUM;
    tone.frequency.value = 660;
    tone.connect(gain).connect(destination);
    tone.start();
    for (let s = 0; s < 600; s++) {
      gain.gain.setValueAtTime(0.08, audio.currentTime + s);
      gain.gain.setValueAtTime(HUM, audio.currentTime + s + 0.12);
    }
    for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
  } catch {
    // video only
  }
  return stream;
}

/** Starts a demo game on the Pass the phone screen. Call from a tap. */
export function startDemoGame() {
  setFallbackStream(testPatternStream);
  newGame({ userId: 'demo', clientId: '', playlist: DEMO_PLAYLIST, songs: shuffle(demoSongs()) });
  enterGame({ engineFactory: demoEngineFactory });
  go('pass');
}
