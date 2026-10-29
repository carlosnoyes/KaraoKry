// Keeps the screen awake during a game (Screen Wake Lock API).
// Android releases the lock when the app is hidden, so it is re-requested on return.
// Failures are silent: the game carries on either way.

let wanted = false;
let sentinel = null;

async function request() {
  if (!wanted || sentinel || document.hidden || !('wakeLock' in navigator)) return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
    if (!wanted) release();
  } catch {
    sentinel = null;
  }
}

function release() {
  const current = sentinel;
  sentinel = null;
  current?.release().catch(() => {});
}

/** true while a game is running, false otherwise. */
export function keepAwake(on) {
  wanted = on;
  if (on) request();
  else release();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) request();
});
