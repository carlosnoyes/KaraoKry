// YouTube-style scrub bar: tap to jump, drag the thumb with a time bubble, seek on
// release. Instrumental stretches are drawn as striped amber segments.

export function formatTime(ms) {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const KEY_STEP_MS = 5000;

export class ScrubBar {
  /**
   * @param {HTMLElement} root element with .scrub__track, .scrub__fill, .scrub__stretches, .scrub__thumb, .scrub__bubble
   * @param {{onSeek: (ms: number) => void}} options
   */
  constructor(root, { onSeek }) {
    this.root = root;
    this.onSeek = onSeek;
    this.track = root.querySelector('.scrub__track');
    this.fill = root.querySelector('.scrub__fill');
    this.stretchesEl = root.querySelector('.scrub__stretches');
    this.thumb = root.querySelector('.scrub__thumb');
    this.bubble = root.querySelector('.scrub__bubble');
    this.durationMs = 0;
    this.positionMs = 0;
    this.dragging = false;
    this.dragMs = 0;
    this.enabled = true;

    root.addEventListener('pointerdown', (event) => this.onDown(event));
    root.addEventListener('pointermove', (event) => this.onMove(event));
    root.addEventListener('pointerup', (event) => this.onUp(event));
    root.addEventListener('pointercancel', () => this.cancelDrag());
    root.addEventListener('keydown', (event) => this.onKey(event));
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.root.classList.toggle('is-disabled', !enabled);
    this.root.setAttribute('aria-disabled', String(!enabled));
    if (!enabled) this.cancelDrag();
  }

  setDuration(ms) {
    this.durationMs = Math.max(0, ms || 0);
    this.root.setAttribute('aria-valuemax', String(Math.round(this.durationMs / 1000)));
    this.render(this.positionMs);
  }

  /** @param {{start: number, end: number}[]} stretches in seconds */
  setStretches(stretches) {
    this.stretchesEl.replaceChildren();
    const total = this.durationMs / 1000;
    if (!total) return;
    for (const { start, end } of stretches ?? []) {
      const segment = document.createElement('div');
      segment.className = 'scrub__stretch';
      segment.style.left = `${(Math.max(0, start) / total) * 100}%`;
      segment.style.width = `${((Math.min(total, end) - Math.max(0, start)) / total) * 100}%`;
      this.stretchesEl.append(segment);
    }
  }

  /** Position updates are ignored while the finger is dragging, so the thumb never jumps back. */
  setPosition(ms) {
    this.positionMs = Math.max(0, Math.min(this.durationMs || Infinity, ms || 0));
    if (!this.dragging) this.render(this.positionMs);
  }

  render(ms) {
    const ratio = this.durationMs ? Math.min(1, Math.max(0, ms / this.durationMs)) : 0;
    const percent = `${ratio * 100}%`;
    this.fill.style.width = percent;
    this.thumb.style.left = percent;
    this.root.setAttribute('aria-valuenow', String(Math.round(ms / 1000)));
    this.root.setAttribute('aria-valuetext', `${formatTime(ms)} of ${formatTime(this.durationMs)}`);
  }

  msAt(clientX) {
    const rect = this.track.getBoundingClientRect();
    const ratio = rect.width ? (clientX - rect.left) / rect.width : 0;
    return Math.min(1, Math.max(0, ratio)) * this.durationMs;
  }

  onDown(event) {
    if (!this.enabled || !this.durationMs || event.button !== 0) return;
    event.preventDefault();
    try {
      this.root.setPointerCapture(event.pointerId);
    } catch {
      // capture is optional
    }
    this.dragging = true;
    this.root.classList.add('is-dragging');
    this.updateDrag(event.clientX);
  }

  onMove(event) {
    if (!this.dragging) return;
    this.updateDrag(event.clientX);
  }

  onUp(event) {
    if (!this.dragging) return;
    this.updateDrag(event.clientX);
    const target = this.dragMs;
    this.endDrag();
    this.positionMs = target;
    this.render(target);
    this.onSeek(target);
  }

  updateDrag(clientX) {
    this.dragMs = this.msAt(clientX);
    this.render(this.dragMs);
    this.bubble.textContent = formatTime(this.dragMs);
    this.bubble.style.left = `${(this.dragMs / this.durationMs) * 100}%`;
  }

  endDrag() {
    this.dragging = false;
    this.root.classList.remove('is-dragging');
  }

  cancelDrag() {
    if (!this.dragging) return;
    this.endDrag();
    this.render(this.positionMs);
  }

  onKey(event) {
    if (!this.enabled || !this.durationMs) return;
    let target = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') target = this.positionMs - KEY_STEP_MS;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') target = this.positionMs + KEY_STEP_MS;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = this.durationMs - 1000;
    if (target === null) return;
    event.preventDefault();
    target = Math.min(this.durationMs, Math.max(0, target));
    this.positionMs = target;
    this.render(target);
    this.onSeek(target);
  }
}
