// navigator.vibrate wrapper, controlled by the Vibration setting (kk.vibration).

import { lsGet, lsSet } from '../storage.js';

const KEY = 'kk.vibration';

export const PATTERNS = {
  tick: 20,
  gotIt: [30, 40, 60],
  skip: 40,
};

export function canVibrate() {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

export function isVibrationOn() {
  return lsGet(KEY, true) !== false;
}

export function setVibrationOn(on) {
  lsSet(KEY, Boolean(on));
}

export function vibrate(pattern) {
  if (!canVibrate() || !isVibrationOn()) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // ignore
  }
}
