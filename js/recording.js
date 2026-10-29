// Films the singer with the front camera and records their voice (no music: the
// music only plays in their headphones), so the room can watch it back after
// "Got It!". Recordings stay in memory on this phone; nothing is uploaded.
//
// Lifecycle: startCamera() inside the Start/Resume tap (permission prompt), then
// per round: beginRound() -> recordPlaying()/recordPaused() -> finishRound()
// (replay) or discardRound() (skip, next singer). stopCamera() when leaving.

import { lsGet, lsSet } from './storage.js';
import { setDebug } from './debug.js';

const ENABLED_KEY = 'kk.record';
const MIC_KEY = 'kk.mic';
const NO_SOUND_KEY = 'kk.recNoSound';
const VIDEO_BITS_PER_SECOND = 2_000_000;
const AUDIO_BITS_PER_SECOND = 128_000;
const TIMESLICE_MS = 1000;
// How many of a segment's first chunks are searched for its header.
const HEADER_CHUNKS = 3;
const LEVEL_CHECK_MS = 250;
// A working microphone always picks up some noise; this long of exact silence means it's dead.
const DEAD_MIC_MS = 5000;

// MP4 with AAC sound plays and saves almost anywhere. Phone galleries often can't
// play Opus sound inside MP4, so WebM (which Android plays natively) comes before it.
export const MIME_TYPES = [
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm',
  'video/mp4;codecs=avc1,opus',
  'video/mp4',
];

// Chrome on Android names its inputs "Speakerphone", "Headset earpiece",
// "Bluetooth headset" and so on. Using a Bluetooth microphone makes Android put the
// headphones into phone-call mode (mono, low quality music), so avoid it.
const BLUETOOTH_MIC = /bluetooth|\bbt\b|hands-?free|airpods|buds/i;
const PHONE_MIC = /speakerphone|built-?in|internal|phone|bottom|back/i;

// ---- Settings ---------------------------------------------------------------------------

export function isRecordingSupported() {
  return Boolean(globalThis.navigator?.mediaDevices?.getUserMedia && globalThis.MediaRecorder);
}

export function isRecordingEnabled() {
  return lsGet(ENABLED_KEY, true) !== false;
}

export function setRecordingEnabled(on) {
  lsSet(ENABLED_KEY, Boolean(on));
  if (!on) stopCamera();
}

/** 'auto' (the phone's own mic), 'default' (Android's choice) or a device id. */
export function getMicChoice() {
  const value = lsGet(MIC_KEY, 'auto');
  return typeof value === 'string' && value ? value : 'auto';
}

export function setMicChoice(choice) {
  lsSet(MIC_KEY, choice || 'auto');
  if (stream) restartCamera();
}

// ---- Pure helpers (tested) ----------------------------------------------------------------

/**
 * The first recording format this browser supports, or '' to let it decide.
 * @param {string[]} skip formats that recorded no sound on this phone
 */
export function chooseMimeType(isSupported, skip = []) {
  return MIME_TYPES.find((type) => {
    if (skip.includes(type)) return false;
    try {
      return isSupported(type);
    } catch {
      return false;
    }
  }) ?? '';
}

const ascii = (bytes, start, length) => String.fromCharCode(...bytes.subarray(start, start + length));

/**
 * The kinds of track a recording's first bytes declare, or null while no header is
 * there yet. Some phones claim they can record MP4 with sound, then leave it out.
 * @param {Uint8Array} bytes
 * @returns {{video: boolean, audio: boolean} | null}
 */
export function headerTracks(bytes) {
  let video = false;
  let audio = false;
  for (let i = 0; i + 4 <= bytes.length; i++) {
    // MP4: every track has a 'hdlr' box. After its name come 4 bytes of version and
    // flags, 4 reserved bytes, then the track's kind: 'vide' or 'soun'.
    if (bytes[i] === 0x68 && i + 16 <= bytes.length && ascii(bytes, i, 4) === 'hdlr') {
      const kind = ascii(bytes, i + 12, 4);
      if (kind === 'vide') video = true;
      if (kind === 'soun') audio = true;
    }
    // WebM: every track has a CodecID element: 0x86, a one-byte length, then 'V_...' or 'A_...'.
    if (bytes[i] === 0x86 && bytes[i + 1] > 0x82 && bytes[i + 1] < 0xA0 && bytes[i + 3] === 0x5F) {
      if (bytes[i + 2] === 0x56) video = true;
      if (bytes[i + 2] === 0x41) audio = true;
    }
  }
  return video || audio ? { video, audio } : null;
}

/** A peak sample (0 to 1) as a meter reading from 0 (-50 dB or quieter) to 1 (-6 dB or louder). */
export function meterLevel(peak) {
  if (!(peak > 0)) return 0;
  return Math.min(1, Math.max(0, (20 * Math.log10(peak) + 50) / 44));
}

/**
 * Picks the microphone to record from.
 * @param {{deviceId: string, label: string}[]} mics audio inputs from enumerateDevices()
 * @param {string} choice 'auto' | 'default' | a deviceId
 * @returns {string|null} a deviceId, or null to use the browser's default
 */
export function chooseMicrophone(mics, choice) {
  if (choice === 'default') return null;
  if (choice !== 'auto') return mics.some((m) => m.deviceId === choice) ? choice : null;
  const real = mics.filter((m) => m.deviceId && m.deviceId !== 'default' && m.deviceId !== 'communications' && m.label);
  const phone = real.find((m) => PHONE_MIC.test(m.label) && !BLUETOOTH_MIC.test(m.label));
  if (phone) return phone.deviceId;
  // Only switch away from the default when we can see a Bluetooth mic to avoid.
  if (!real.some((m) => BLUETOOTH_MIC.test(m.label))) return null;
  return real.find((m) => !BLUETOOTH_MIC.test(m.label))?.deviceId ?? null;
}

export function fileExtension(mimeType) {
  return String(mimeType).startsWith('video/mp4') ? 'mp4' : 'webm';
}

// ---- Camera ---------------------------------------------------------------------------------

let stream = null;
let starting = null;
let fallbackStreamFactory = null;
let lastStartFailed = false;
let deadMicFallback = false;
const streamListeners = new Set();

/** fn(stream|null) whenever the camera starts or stops (for the selfie preview). */
export function onStreamChange(fn) {
  streamListeners.add(fn);
  return () => streamListeners.delete(fn);
}

function setStream(next) {
  stream = next;
  connectMeter(stream);
  for (const fn of streamListeners) fn(stream);
}

function streamLive() {
  return Boolean(stream) && stream.getTracks().some((t) => t.kind === 'video' && t.readyState === 'live');
}

/** Development only: a stand-in stream for computers without a camera. */
export function setFallbackStream(factory) {
  fallbackStreamFactory = factory;
}

function audioConstraints(deviceId) {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    // Echo cancelling would put Bluetooth headphones into phone-call mode, and noise
    // suppression mangles singing. Automatic gain stays on: phones record quietly without it.
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: true,
  };
}

function openMicrophone(deviceId) {
  return navigator.mediaDevices.getUserMedia({ audio: audioConstraints(deviceId) });
}

// Browsers match sizes against the camera's landscape modes and turn the picture
// upright themselves, so a phone held upright gets a 720x1280 portrait video from
// these landscape numbers. Portrait numbers here can make Chrome pick an oddly cropped mode.
const VIDEO_CONSTRAINTS = {
  facingMode: 'user',
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30, max: 30 },
};

/** Audio inputs. Their names are empty until camera and microphone permission was granted. */
export async function listMicrophones() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  } catch {
    return [];
  }
}

async function openStream() {
  // After a chosen microphone stayed silent, Android's own choice is used until the app restarts.
  const choice = deadMicFallback ? 'default' : getMicChoice();
  // Labels are only visible once permission was granted, so on the very first run
  // the default mic opens first and is swapped right after.
  const micId = chooseMicrophone(await listMicrophones(), choice);
  let media = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS, audio: audioConstraints(micId) });
  if (!micId) {
    const better = chooseMicrophone(await listMicrophones(), choice);
    const current = media.getAudioTracks()[0]?.getSettings().deviceId;
    if (better && better !== current) {
      // Android hands the sound to only one recording at a time (the others get
      // silence), so close the first microphone before opening the second.
      for (const track of media.getAudioTracks()) track.stop();
      const audio = await openMicrophone(better).catch(() => openMicrophone(null)).catch(() => null);
      media = new MediaStream([...media.getVideoTracks(), ...(audio?.getAudioTracks() ?? [])]);
    }
  }
  setDebug('microphone', media.getAudioTracks()[0]?.label || (media.getAudioTracks().length ? 'default' : 'none'));
  const video = media.getVideoTracks()[0]?.getSettings();
  setDebug('camera', video?.width ? `${video.width}x${video.height}` : 'unknown size');
  return media;
}

/**
 * Starts the front camera and microphone. Call inside a tap the first time, so the
 * browser can ask for permission. Resolves true when filming is possible.
 */
export function startCamera() {
  if (!isRecordingEnabled()) return Promise.resolve(false);
  if (streamLive()) return Promise.resolve(true);
  if (starting) return starting;
  starting = (async () => {
    try {
      if (!isRecordingSupported()) throw new Error('Recording not supported');
      const media = await openStream();
      if (!isRecordingEnabled()) {
        media.getTracks().forEach((t) => t.stop());
        return false;
      }
      setStream(media);
      lastStartFailed = false;
      return true;
    } catch (err) {
      if (fallbackStreamFactory) {
        setStream(fallbackStreamFactory());
        return true;
      }
      lastStartFailed = true;
      setDebug('microphone', `camera unavailable (${err?.name || 'error'})`);
      return false;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

/** True when the last attempt to start the camera was refused or failed. */
export function cameraFailed() {
  return lastStartFailed;
}

export function stopCamera() {
  discardRound();
  wantRecording = false;
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    setStream(null);
  }
}

async function restartCamera() {
  const wasRecording = recorder?.state === 'recording';
  if (wasRecording) await stopSegment(true);
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    setStream(null);
  }
  if (await startCamera() && wasRecording) startSegment();
}

// ---- Microphone level ------------------------------------------------------------------------
// Measured (never played) through Web Audio: it drives the voice ring around the selfie
// and catches a microphone that hears nothing at all.

let audioContext = null;
let meter = null;
let levelTimer = 0;
let silentSince = null;
let roundPeak = 0;
let silenceReported = false;
const silentListeners = new Set();

/** fn() when the microphone hears nothing even after falling back to Android's choice (once). */
export function onMicSilent(fn) {
  silentListeners.add(fn);
  return () => silentListeners.delete(fn);
}

function connectMeter(media) {
  meter?.source.disconnect();
  meter = null;
  clearInterval(levelTimer);
  silentSince = null;
  const track = media?.getAudioTracks().find((t) => t.readyState === 'live');
  if (!track || !globalThis.AudioContext) {
    // Nothing to measure: let the audio hardware rest.
    audioContext?.suspend().catch(() => {});
    return;
  }
  try {
    audioContext ??= new AudioContext();
    audioContext.resume().catch(() => {});
    const source = audioContext.createMediaStreamSource(new MediaStream([track]));
    // A short window for the lively voice ring, a long one (about 0.7 s) for the checks.
    const now = audioContext.createAnalyser();
    now.fftSize = 1024;
    const recent = audioContext.createAnalyser();
    recent.fftSize = 32768;
    source.connect(now);
    source.connect(recent);
    meter = { source, now, recent, nowSamples: new Float32Array(now.fftSize), recentSamples: new Float32Array(recent.fftSize) };
    levelTimer = setInterval(checkLevel, LEVEL_CHECK_MS);
  } catch {
    meter = null;
  }
}

function peakOf(analyser, samples) {
  if (!meter) return null;
  if (audioContext.state !== 'running') {
    audioContext.resume().catch(() => {});
    return null;
  }
  analyser.getFloatTimeDomainData(samples);
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

/** The microphone's loudest sample right now, from 0 to 1, or null when it can't be measured. */
export function micPeak() {
  return meter ? peakOf(meter.now, meter.nowSamples) : null;
}

function checkLevel() {
  const peak = recorder?.state === 'recording' && meter ? peakOf(meter.recent, meter.recentSamples) : null;
  if (peak === null || peak > 0) {
    silentSince = null;
    if (peak) roundPeak = Math.max(roundPeak, peak);
    return;
  }
  silentSince ??= performance.now();
  if (performance.now() - silentSince < DEAD_MIC_MS) return;
  silentSince = null;
  if (!deadMicFallback && getMicChoice() !== 'default') {
    deadMicFallback = true;
    restartCamera();
  } else if (!silenceReported) {
    silenceReported = true;
    setDebug('micLevel', 'silent: the microphone picked up nothing');
    for (const fn of silentListeners) fn();
  }
}

function reportRoundLevel() {
  if (!meter) return;
  setDebug('micLevel', roundPeak > 0
    ? `loudest ${Math.round(20 * Math.log10(roundPeak))} dB last round`
    : 'silent last round');
}

// ---- Recording a round --------------------------------------------------------------------------

let roundKey = null;
let recorder = null;
let lastStop = Promise.resolve();
let segments = [];
let mimeType = null;
let wantRecording = false;
let replay = null;
const recordingListeners = new Set();

/** fn(isRecording) whenever recording starts, pauses or stops (for the REC dot). */
export function onRecordingChange(fn) {
  recordingListeners.add(fn);
  return () => recordingListeners.delete(fn);
}

function notifyRecording() {
  const on = recorder?.state === 'recording';
  for (const fn of recordingListeners) fn(on);
}

/** Formats that recorded no sound in this browser version (a Chrome update gets a fresh try). */
function noSoundTypes() {
  const saved = lsGet(NO_SOUND_KEY, null);
  return saved?.browser === navigator.userAgent && Array.isArray(saved.types) ? saved.types : [];
}

function recorderMimeType() {
  if (mimeType === null) {
    const skip = noSoundTypes();
    mimeType = chooseMimeType((type) => MediaRecorder.isTypeSupported(type), skip);
    setDebug('recordingFormat', (mimeType || 'browser default') + (skip.length ? ` (no sound in ${skip.join(', ')})` : ''));
  }
  return mimeType;
}

/** Looks for the segment's header in its first chunks and makes sure it has sound. */
async function checkSound(segment, chunks) {
  let tracks = null;
  try {
    const head = await new Blob(chunks).slice(0, 512 * 1024).arrayBuffer();
    tracks = headerTracks(new Uint8Array(head));
  } catch {
    return;
  }
  if (!tracks) return;
  segment.checked = true;
  if (tracks.audio) {
    setDebug('recordingTracks', 'video and sound');
    return;
  }
  // Only blame the format when the microphone is clearly hearing something.
  const micHears = meter && peakOf(meter.recent, meter.recentSamples) > 0;
  setDebug('recordingTracks', `video only, no sound${micHears ? '' : ' (the microphone sent nothing)'}`);
  if (!micHears || recorder !== segment || !segment.format) return;
  // This format drops the sound on this phone: remember that, and start over in the next one.
  lsSet(NO_SOUND_KEY, { browser: navigator.userAgent, types: [...new Set([...noSoundTypes(), segment.format])] });
  mimeType = null;
  await stopSegment(false);
  if (wantRecording && !recorder) startSegment();
}

function startSegment() {
  if (!streamLive() || recorder) return;
  let next;
  const type = recorderMimeType();
  try {
    next = new MediaRecorder(stream, {
      ...(type ? { mimeType: type } : {}),
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });
  } catch {
    return;
  }
  next.format = type;
  const chunks = [];
  // The round this segment belongs to: a later round starts a fresh array.
  const roundSegments = segments;
  const hasMic = stream.getAudioTracks().some((t) => t.readyState === 'live');
  let headerChecks = 0;
  next.addEventListener('dataavailable', (event) => {
    if (!event.data?.size) return;
    chunks.push(event.data);
    if (hasMic && !next.checked && headerChecks < HEADER_CHUNKS) {
      headerChecks++;
      checkSound(next, chunks);
    }
  });
  next.addEventListener('stop', () => {
    // A recorder can also stop on its own when the camera is taken away; keep what it had.
    if (recorder === next) {
      recorder = null;
      notifyRecording();
    }
    if (next.keep !== false && chunks.length) {
      roundSegments.push(new Blob(chunks, { type: next.mimeType || mimeType || 'video/webm' }));
    }
    next.resolveStop?.();
  });
  next.addEventListener('error', () => {
    next.keep = false;
  });
  next.addEventListener('pause', notifyRecording);
  next.addEventListener('resume', notifyRecording);
  recorder = next;
  try {
    next.start(TIMESLICE_MS);
  } catch {
    recorder = null;
  }
  notifyRecording();
}

/** Stops the current segment. With keep=true its video joins the round's segments. */
function stopSegment(keep) {
  const current = recorder;
  recorder = null;
  // Nothing recording: wait for any stop still finishing, so its video is included.
  if (!current) return lastStop;
  current.keep = keep;
  const done = new Promise((resolve) => {
    current.resolveStop = resolve;
  });
  try {
    if (current.state !== 'inactive') current.stop();
    else current.resolveStop();
  } catch {
    current.resolveStop();
  }
  notifyRecording();
  lastStop = done;
  return done;
}

/** Call whenever the game may have moved to another round; a new round starts empty. */
export function beginRound(key) {
  if (key === roundKey) return;
  discardRound();
  roundKey = key;
  roundPeak = 0;
}

/** The music is playing: record (a new segment, or carry on after a pause). */
export function recordPlaying() {
  wantRecording = true;
  if (recorder?.state === 'paused') {
    recorder.resume();
    return;
  }
  if (recorder) return;
  if (streamLive()) {
    startSegment();
    return;
  }
  // The camera stopped (for example while the app was in the background): restart it.
  startCamera().then((ok) => {
    if (ok && wantRecording && !recorder) startSegment();
  });
}

/** The music is paused or over: pause the recording too. */
export function recordPaused() {
  wantRecording = false;
  if (recorder?.state === 'recording') recorder.pause();
}

/**
 * Ends the round's recording for the replay. The result stays available from
 * getReplay() until the round changes.
 * @returns {Promise<Blob[]>} the round's video segments (several after "Go back")
 */
export function finishRound() {
  wantRecording = false;
  reportRoundLevel();
  const key = roundKey;
  if (!recorder && !segments.length) {
    replay = null;
    return Promise.resolve([]);
  }
  const promise = stopSegment(true).then(() => (roundKey === key ? [...segments] : []));
  replay = { key, promise };
  return promise;
}

/** Drops the round's recording (skip, next singer, new round). */
export function discardRound() {
  wantRecording = false;
  stopSegment(false);
  segments = [];
  replay = null;
}

/** The replay for the current round, or null when there is none. */
export function getReplay() {
  return replay && replay.key === roundKey ? replay.promise : null;
}
