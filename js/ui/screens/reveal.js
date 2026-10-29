// Screen 10: Reveal. The card starts covered so the singer can turn the phone to
// the room first; a tap flips it to show the played song.

import { go } from '../../router.js';
import { refs, showImage } from '../dom.js';
import { getGame, currentPair, actions, isLastRound } from '../../game.js';
import { playback } from '../../playback/manager.js';

export default {
  id: 'reveal',

  init(el) {
    this.r = refs(el);
    this.r.tap.addEventListener('click', () => this.flip());
    this.r.next.addEventListener('click', () => this.next());
    this.r.goBack.addEventListener('click', () => this.goBack());
  },

  show() {
    const game = getGame();
    const pair = currentPair();
    if (!game || !pair) {
      go('picker');
      return;
    }
    const { played, lyrics } = pair;
    this.r.card.classList.remove('is-flipped');
    this.r.back.setAttribute('aria-hidden', 'true');
    this.r.tap.hidden = false;
    this.r.tap.removeAttribute('aria-hidden');

    // Load the art now, so it is ready when the card flips.
    showImage(this.r.art, this.r.artPlaceholder, played.imageUrl);
    this.r.title.textContent = played.name;
    this.r.artist.textContent = played.artists.join(', ');
    this.r.singing.textContent = `You were singing: ${lyrics.name} by ${lyrics.artists.join(', ')}`;
    this.r.next.textContent = isLastRound() ? 'Finish' : 'Next singer';
  },

  flip() {
    this.r.card.classList.add('is-flipped');
    this.r.back.removeAttribute('aria-hidden');
    this.r.tap.setAttribute('aria-hidden', 'true');
    this.r.next.focus({ preventScroll: true });
  },

  next() {
    const over = actions.next();
    go(over ? 'game-over' : 'pass');
  },

  goBack() {
    // A tap: lets the browser restart the audio if the music was playing.
    playback.unlock();
    if (actions.goBack()) go('round', { fromReveal: true });
  },

  back() {
    this.goBack();
  },
};
