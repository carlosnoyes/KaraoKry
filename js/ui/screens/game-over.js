// Screen 11: Game over. No recap of songs, just the count.

import { go } from '../../router.js';
import { refs, plural } from '../dom.js';
import { getGame, deleteSavedGame } from '../../game.js';
import { isLoggedIn } from '../../auth.js';

export default {
  id: 'game-over',

  init(el) {
    this.r = refs(el);
    this.r.again.addEventListener('click', () => this.playAgain());
    this.r.pick.addEventListener('click', () => this.pickAnother());
  },

  show() {
    deleteSavedGame();
    const game = getGame();
    if (!game) {
      this.r.summary.textContent = '';
      return;
    }
    this.playlist = game.playlist;
    const total = game.songs.length;
    const played = Math.min(game.roundsPlayed, total);
    this.r.summary.textContent = played >= total
      ? `You played all ${plural(total, 'song')} from ${game.playlist.name}.`
      : `You played ${played} of ${plural(total, 'song')} from ${game.playlist.name}.`;
  },

  async playAgain() {
    if (this.playlist?.id === 'demo') {
      const { startDemoGame } = await import('../../dev/demo.js');
      startDemoGame();
      return;
    }
    if (this.playlist) go('preparing', { playlist: this.playlist });
    else this.pickAnother();
  },

  pickAnother() {
    go(isLoggedIn() ? 'picker' : 'welcome');
  },

  back() {
    this.pickAnother();
  },
};
