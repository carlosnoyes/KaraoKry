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
const VIDEO_BITS_PER_SECOND = 2_000_000;
const AUDIO_BITS_PER_SECOND = 128_000;
const TIMESLICE_MS = 1000;

// MP4 first: it plays and saves almost anywhere. WebM as a fallback.
export const MIME_TYPES = [
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1,opus',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
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

/** The first recording format this browser supports, or '' to let it decide. */
export function chooseMimeType(isSupported) {
  return MIME_TYPES.find((type) => {
    try {
      return isSupported(type);
    } catch {
      return false;
    }
  }) ?? '';
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
const streamListeners = new Set();

/** fn(stream|null) whenever the camera starts or stops (for the selfie preview). */
export function onStreamChange(fn) {
  streamListeners.add(fn);
  return () => streamListeners.delete(fn);
}

function setStream(next) {
  stream = next;
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
    // Raw sound suits singing better than call-style processing.
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
}

const VIDEO_CONSTRAINTS = {
  facingMode: 'user',
  width: { ideal: 720 },
  height: { ideal: 1280 },
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
  const choice = getMicChoice();
  // Labels are only visible once permission was granted, so on the very first run
  // the default mic opens first and is swapped right after.
  let micId = chooseMicrophone(await listMicrophones(), choice);
  let media = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS, audio: audioConstraints(micId) });
  if (!micId) {
    const better = chooseMicrophone(await listMicrophones(), choice);
    const current = media.getAudioTracks()[0]?.getSettings().deviceId;
    if (better && better !== current) {
      try {
        const audio = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(better) });
        for (const track of media.getAudioTracks()) track.stop();
        media = new MediaStream([...media.getVideoTracks(), ...audio.getAudioTracks()]);
        micId = better;
      } catch {
        // keep the default microphone
      }
    }
  }
  setDebug('microphone', media.getAudioTracks()[0]?.label || 'default');
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

function recorderMimeType() {
  if (mimeType === null) {
    mimeType = chooseMimeType((type) => MediaRecorder.isTypeSupported(type));
    setDebug('recordingFormat', mimeType || 'browser default');
  }
  return mimeType;
}

function startSegment() {
  if (!streamLive() || recorder) return;
  let next;
  try {
    const type = recorderMimeType();
    next = new MediaRecorder(stream, {
      ...(type ? { mimeType: type } : {}),
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });
  } catch {
    return;
  }
  const chunks = [];
  // The round this segment belongs to: a later round starts a fresh array.
  const roundSegments = segments;
  next.addEventListener('dataavailable', (event) => {
    if (event.data?.size) chunks.push(event.data);
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
