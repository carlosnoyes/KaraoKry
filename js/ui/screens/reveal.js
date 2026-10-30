// Screen 10: Reveal. When the round was filmed, "Got It!" lands straight on the
// replay of the singer (their voice only, looping) with the answer on top, plus
// Save, Share, Next singer and Go back. Otherwise a covered card is flipped to
// show the answer, so the singer can turn the phone to the room first.

import { go } from '../../router.js';
import { refs, showImage } from '../dom.js';
import { getGame, currentPair, actions, isLastRound } from '../../game.js';
import { playback } from '../../playback/manager.js';
import { getReplay, fileExtension } from '../../recording.js';
import { toast } from '../toast.js';
import { setDebug } from '../../debug.js';

// If the recorder never hands over its video, fall back to the card after this long.
const REPLAY_TIMEOUT_MS = 5000;
// After this long playing, Debug info notes whether the replay had any sound to decode.
const SOUND_CHECK_MS = 2500;

function safeFileName(text) {
  return String(text).replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'song';
}

function canShareFiles() {
  try {
    return Boolean(navigator.canShare?.({ files: [new File([''], 'test.mp4', { type: 'video/mp4' })] }));
  } catch {
    return false;
  }
}

export default {
  id: 'reveal',

  init(el) {
    this.r = refs(el);
    this.token = 0;
    this.blobs = null;
    this.urls = [];
    this.index = 0;
    const r = this.r;

    r.tap.addEventListener('click', () => this.flip());
    r.next.addEventListener('click', () => this.next());
    r.goBack.addEventListener('click', () => this.goBack());
    r.replayNext.addEventListener('click', () => this.next());
    r.replayBack.addEventListener('click', () => this.goBack());
    r.save.addEventListener('click', () => this.save());
    r.share.addEventListener('click', () => this.share());
    r.tapToPlay.addEventListener('click', () => this.playCurrent());
    // A tap on the video pauses it, and another tap plays it again.
    r.replay.addEventListener('click', (event) => {
      if (event.target.closest('button') || r.video.hidden) return;
      if (r.video.paused) {
        this.playCurrent();
      } else {
        r.video.pause();
        r.tapToPlay.hidden = false;
      }
    });
    r.video.addEventListener('ended', () => {
      // Several segments (after Go back) play one after another, then start over.
      if (this.urls.length > 1) this.load((this.index + 1) % this.urls.length);
    });
    r.video.addEventListener('playing', () => {
      r.tapToPlay.hidden = true;
      const token = this.token;
      setTimeout(() => {
        const decoded = r.video.webkitAudioDecodedByteCount;
        if (token !== this.token || typeof decoded !== 'number') return;
        setDebug('replaySound', decoded > 0 ? 'yes' : 'none (the video has no sound)');
      }, SOUND_CHECK_MS);
    });
  },

  show() {
    const game = getGame();
    const pair = currentPair();
    if (!game || !pair) {
      go('picker');
      return;
    }
    this.played = pair.played;
    const label = isLastRound() ? 'Finish' : 'Next singer';
    this.r.next.textContent = label;
    this.r.replayNext.textContent = label;

    const replay = getReplay();
    if (replay) this.showReplay(replay);
    else this.showCard();
  },

  hide() {
    this.stopReplay();
  },

  focus() {
    const target = this.r.replay.hidden ? this.r.tap : this.r.replayNext;
    target.focus({ preventScroll: true });
  },

  // ---- Covered card (round not filmed) ---------------------------------------------------

  showCard() {
    const { played } = this;
    this.r.replay.hidden = true;
    this.r.classic.hidden = false;
    this.el.classList.remove('screen--replay');
    this.r.card.classList.remove('is-flipped');
    this.r.back.setAttribute('aria-hidden', 'true');
    this.r.tap.removeAttribute('aria-hidden');
    // Load the art now, so it is ready when the card flips.
    showImage(this.r.art, this.r.artPlaceholder, played.imageUrl);
    this.r.title.textContent = played.name;
    this.r.artist.textContent = played.artists.join(', ');
  },

  flip() {
    this.r.card.classList.add('is-flipped');
    this.r.back.removeAttribute('aria-hidden');
    this.r.tap.setAttribute('aria-hidden', 'true');
    this.r.next.focus({ preventScroll: true });
  },

  // ---- Replay (round filmed) -----------------------------------------------------------------

  showReplay(replay) {
    const { played } = this;
    const r = this.r;
    r.classic.hidden = true;
    r.replay.hidden = false;
    this.el.classList.add('screen--replay');
    r.loading.hidden = false;
    r.tapToPlay.hidden = true;
    r.video.hidden = true;
    r.save.disabled = true;
    r.share.disabled = true;
    r.share.hidden = !canShareFiles();
    showImage(r.replayArt, r.replayArtPlaceholder, played.imageUrlSmall ?? played.imageUrl);
    r.replayTitle.textContent = played.name;
    r.replayArtist.textContent = played.artists.join(', ');

    const token = ++this.token;
    const timeout = new Promise((resolve) => setTimeout(() => resolve([]), REPLAY_TIMEOUT_MS));
    Promise.race([replay, timeout]).then((blobs) => {
      if (token !== this.token) return;
      if (!blobs?.length) {
        this.showCard();
        this.focus();
        return;
      }
      this.blobs = blobs;
      this.urls = blobs.map((blob) => URL.createObjectURL(blob));
      r.loading.hidden = true;
      r.video.hidden = false;
      r.save.disabled = false;
      r.share.disabled = false;
      // One segment loops by itself; several are chained by the 'ended' handler.
      r.video.loop = this.urls.length === 1;
      this.load(0);
    });
  },

  load(index) {
    this.index = index;
    this.r.video.src = this.urls[index];
    this.playCurrent();
  },

  playCurrent() {
    this.r.video.muted = false;
    this.r.video.play().catch(() => {
      // The browser wants another tap before playing sound.
      this.r.tapToPlay.hidden = false;
    });
  },

  stopReplay() {
    this.token++;
    const video = this.r.video;
    video.pause();
    video.removeAttribute('src');
    video.load();
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    this.blobs = null;
  },

  files() {
    const type = this.blobs[0]?.type || 'video/webm';
    const base = `KaraoKry - ${safeFileName(this.played.name)}`;
    return this.blobs.map((blob, i) => {
      const part = this.blobs.length > 1 ? ` (part ${i + 1})` : '';
      return new File([blob], `${base}${part}.${fileExtension(blob.type || type)}`, { type: blob.type || type });
    });
  },

  /** Saves the replay to the phone (Chrome puts it in Downloads). */
  save() {
    if (!this.blobs) return;
    for (const file of this.files()) {
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    toast('Saving the video to your phone...');
  },

  /** Opens Android's share sheet (Google Photos, WhatsApp...). */
  async share() {
    if (!this.blobs) return;
    try {
      await navigator.share({ files: this.files(), title: `KaraoKry: ${this.played.name}` });
    } catch (err) {
      if (err?.name !== 'AbortError') toast("Couldn't share the video. Try Save video instead.");
    }
  },

  next() {
    this.stopReplay();
    const over = actions.next();
    go(over ? 'game-over' : 'pass');
  },

  goBack() {
    this.stopReplay();
    // A tap: lets the browser restart the audio if the music was playing.
    playback.unlock();
    if (actions.goBack()) go('round', { fromReveal: true });
  },

  back() {
    this.goBack();
  },
};
