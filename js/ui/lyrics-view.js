// Lyrics rendering, hand scrolling and two-finger pinch zoom (16-64 px).
// There is no auto-scroll, highlighting or timing: the singer scrolls freely.
//
// Pinch uses touch events (non-passive, so the page itself never zooms) because
// pointer events get cancelled as soon as the browser starts a scroll.

import { lsGet, lsSet, lsRemove } from '../storage.js';

const SIZE_KEY = 'kk.lyricsSize';
export const MIN_LYRICS_SIZE = 16;
export const MAX_LYRICS_SIZE = 64;

const clampSize = (px) => Math.min(MAX_LYRICS_SIZE, Math.max(MIN_LYRICS_SIZE, px));

/** The saved lyrics size in px, or null for the default size. */
export function getSavedLyricsSize() {
  const value = Number(lsGet(SIZE_KEY));
  return Number.isFinite(value) && value > 0 ? clampSize(value) : null;
}

export function resetLyricsSize() {
  lsRemove(SIZE_KEY);
}

function distance(a, b) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

export class LyricsView {
  /**
   * @param {HTMLElement} el scroll container
   * @param {{onScroll?: (ratio: number) => void}} [options]
   */
  constructor(el, { onScroll } = {}) {
    this.el = el;
    this.onScroll = onScroll;
    this.pinch = null;
    this.scrollQueued = false;
    this.applySavedSize();

    el.addEventListener('touchstart', (event) => this.onTouchStart(event), { passive: true });
    el.addEventListener('touchmove', (event) => this.onTouchMove(event), { passive: false });
    el.addEventListener('touchend', (event) => this.onTouchEnd(event));
    el.addEventListener('touchcancel', (event) => this.onTouchEnd(event));
    // Trackpad pinch on desktop arrives as ctrl + wheel.
    el.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    el.addEventListener('scroll', () => this.queueScrollReport(), { passive: true });
  }

  setText(text) {
    const fragment = document.createDocumentFragment();
    for (const line of String(text ?? '').split('\n')) {
      if (line === '') {
        const gap = document.createElement('div');
        gap.className = 'lyrics__gap';
        gap.setAttribute('aria-hidden', 'true');
        fragment.append(gap);
      } else {
        const p = document.createElement('p');
        p.className = 'lyrics__line';
        p.dir = 'auto';
        p.textContent = line;
        fragment.append(p);
      }
    }
    this.el.replaceChildren(fragment);
    this.el.scrollTop = 0;
  }

  applySavedSize() {
    const size = getSavedLyricsSize();
    if (size) this.el.style.setProperty('--lyrics-size', `${size}px`);
    else this.el.style.removeProperty('--lyrics-size');
  }

  currentSize() {
    return parseFloat(getComputedStyle(this.el).fontSize) || 28;
  }

  getScrollRatio() {
    const max = this.el.scrollHeight - this.el.clientHeight;
    return max > 0 ? this.el.scrollTop / max : 0;
  }

  setScrollRatio(ratio) {
    const max = this.el.scrollHeight - this.el.clientHeight;
    this.el.scrollTop = max > 0 ? Math.min(1, Math.max(0, ratio)) * max : 0;
  }

  queueScrollReport() {
    if (this.scrollQueued) return;
    this.scrollQueued = true;
    requestAnimationFrame(() => {
      this.scrollQueued = false;
      this.onScroll?.(this.getScrollRatio());
    });
  }

  /** Changes the size while keeping the text at `focusY` (px from the container top) in place. */
  zoomTo(size, focusY, startSize = this.currentSize(), startScroll = this.el.scrollTop) {
    const next = clampSize(size);
    const padTop = parseFloat(getComputedStyle(this.el).paddingTop) || 0;
    const anchor = (startScroll + focusY - padTop) / startSize;
    this.el.style.setProperty('--lyrics-size', `${next}px`);
    this.el.scrollTop = anchor * next + padTop - focusY;
    return next;
  }

  focusYOf(touches) {
    const rect = this.el.getBoundingClientRect();
    return (touches[0].clientY + touches[1].clientY) / 2 - rect.top;
  }

  onTouchStart(event) {
    if (event.touches.length !== 2) return;
    this.pinch = {
      startDistance: Math.max(1, distance(event.touches[0], event.touches[1])),
      startSize: this.currentSize(),
      startScroll: this.el.scrollTop,
      focusY: this.focusYOf(event.touches),
      size: this.currentSize(),
    };
  }

  onTouchMove(event) {
    if (!this.pinch || event.touches.length !== 2) return;
    if (event.cancelable) event.preventDefault();
    const scale = distance(event.touches[0], event.touches[1]) / this.pinch.startDistance;
    this.pinch.size = this.zoomTo(
      this.pinch.startSize * scale,
      this.pinch.focusY,
      this.pinch.startSize,
      this.pinch.startScroll,
    );
  }

  onTouchEnd(event) {
    if (!this.pinch || event.touches.length >= 2) return;
    lsSet(SIZE_KEY, Math.round(this.pinch.size));
    this.pinch = null;
    this.queueScrollReport();
  }

  onWheel(event) {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const rect = this.el.getBoundingClientRect();
    const size = this.zoomTo(this.currentSize() * Math.exp(-event.deltaY / 200), event.clientY - rect.top);
    lsSet(SIZE_KEY, Math.round(size));
  }
}
