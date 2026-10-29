// Press-and-hold helper. While held, the button's --hold-progress CSS variable
// goes from 0 to 1 (the stylesheet draws a ring from it).

/**
 * @param {HTMLElement} button
 * @param {{duration?: number, onComplete: () => void, onCancel?: () => void}} options
 * @returns {() => void} cleanup
 */
export function longPress(button, { duration = 700, onComplete, onCancel }) {
  let startedAt = 0;
  let frame = 0;
  let timer = 0;
  let active = false;

  const setProgress = (value) => button.style.setProperty('--hold-progress', String(value));

  // Releasing anywhere (even after sliding off the button) ends the hold.
  const onRelease = () => finish(false);

  function begin() {
    if (button.disabled || active) return;
    active = true;
    startedAt = performance.now();
    button.classList.add('is-holding');
    window.addEventListener('pointerup', onRelease);
    window.addEventListener('pointercancel', onRelease);
    frame = requestAnimationFrame(draw);
    // A timer decides completion, so a slow or throttled frame rate never delays the skip.
    timer = setTimeout(() => finish(true), duration);
  }

  function draw(now) {
    if (!active) return;
    setProgress(Math.min(1, (now - startedAt) / duration));
    frame = requestAnimationFrame(draw);
  }

  function finish(completed) {
    if (!active) return;
    active = false;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    window.removeEventListener('pointerup', onRelease);
    window.removeEventListener('pointercancel', onRelease);
    button.classList.remove('is-holding');
    setProgress(0);
    if (completed) onComplete();
    else onCancel?.();
  }

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    begin();
  };
  const onKeyDown = (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
      event.preventDefault();
      begin();
    }
  };
  const onKeyUp = (event) => {
    if (event.key === 'Enter' || event.key === ' ') finish(false);
  };
  // A long touch would otherwise open the browser's context menu.
  const onContextMenu = (event) => event.preventDefault();

  button.addEventListener('pointerdown', onPointerDown);
  button.addEventListener('keydown', onKeyDown);
  button.addEventListener('keyup', onKeyUp);
  button.addEventListener('blur', onRelease);
  button.addEventListener('contextmenu', onContextMenu);

  return () => {
    finish(false);
    button.removeEventListener('pointerdown', onPointerDown);
    button.removeEventListener('keydown', onKeyDown);
    button.removeEventListener('keyup', onKeyUp);
    button.removeEventListener('blur', onRelease);
    button.removeEventListener('contextmenu', onContextMenu);
  };
}
