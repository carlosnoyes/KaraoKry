// Debug info shown in Settings > Advanced > Debug info.
// Holds no tokens or personal data: only engine names, device ids and short
// error descriptions.

import { APP_VERSION } from '../config.js';

const info = {
  engine: null,
  deviceId: null,
  lastError: null,
  lastPrepare: null,
  microphone: null,
  camera: null,
  recordingFormat: null,
  recordingTracks: null,
  micLevel: null,
  replaySound: null,
};

export function setDebug(key, value) {
  info[key] = value;
}

export function describeError(err) {
  if (!err) return 'unknown error';
  const parts = [err.name || 'Error'];
  if (err.code) parts.push(err.code);
  if (err.status) parts.push(`HTTP ${err.status}`);
  if (err.reason) parts.push(err.reason);
  if (err.message && err.message !== err.code) parts.push(err.message);
  return parts.join(' · ');
}

export function recordError(where, err) {
  info.lastError = `${new Date().toISOString()} ${where}: ${describeError(err)}`;
}

export function getDebugText(extra = {}) {
  const lines = {
    'App version': APP_VERSION,
    'Playback engine': info.engine ?? 'not started',
    'Device id': info.deviceId ?? 'none',
    'Last error': info.lastError ?? 'none',
    'Last preparation': info.lastPrepare ?? 'none',
    'Recording microphone': info.microphone ?? 'not started',
    'Camera size': info.camera ?? 'not started',
    'Recording format': info.recordingFormat ?? 'not started',
    'Recording contains': info.recordingTracks ?? 'not checked yet',
    'Microphone level': info.micLevel ?? 'not measured yet',
    'Replay sound': info.replaySound ?? 'no replay yet',
    ...extra,
    'User agent': globalThis.navigator?.userAgent ?? 'unknown',
  };
  return Object.entries(lines).map(([k, v]) => `${k}: ${v}`).join('\n');
}
