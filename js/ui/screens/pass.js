// Screen 7: Pass the phone. Plain and dark: nothing hints at the coming songs.

import { go } from '../../router.js';
import { refs, songProgress } from '../dom.js';
import { getGame, actions } from '../../game.js';
import { playback } from '../../playback/manager.js';
import { confirmEndGame } from '../../app.js';
import { menuSheet } from '../dialogs.js';

export default {
  id: 'pass',

  init(el) {
    this.r = refs(el);
    this.r.ready.addEventListener('click', () => this.ready());
    this.r.menu.addEventListener('click', () => this.openMenu());
  },

  show() {
    const game = getGame();
    if (!game) {
      go('picker');
      return;
    }
    this.r.progress.textContent = songProgress(game.round, game.songs.length);
  },

  ready() {
    if (!getGame()) return;
    // This tap is the user gesture that lets the browser start audio later.
    playback.unlock();
    if (actions.ready()) go('round', { countdown: true });
  },

  async openMenu() {
    const choice = await menuSheet([
      { label: 'End game', value: 'end', danger: true },
      { label: 'Settings', value: 'settings' },
      { label: 'How to play', value: 'howto' },
    ]);
    if (choice === 'end') confirmEndGame();
    else if (choice === 'settings') go('settings');
    else if (choice === 'howto') go('how-to');
  },

  back() {
    confirmEndGame();
  },
};
