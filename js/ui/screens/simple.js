// Small screens: Loading, Login finished elsewhere, Not on the guest list, Resume prompt.

import { go } from '../../router.js';
import { refs, songProgress } from '../dom.js';
import { afterLogin, logout, resumeSavedGame } from '../../app.js';
import { deleteSavedGame } from '../../game.js';
import { confirmDialog } from '../dialogs.js';

export const loading = {
  id: 'loading',
  root: true,
};

export const loginDone = {
  id: 'login-done',
  root: true,
  init(el) {
    refs(el).continue.addEventListener('click', () => afterLogin());
  },
};

export const guestList = {
  id: 'guest-list',
  root: true,
  init(el) {
    const r = refs(el);
    r.retry.addEventListener('click', () => afterLogin());
    r.logout.addEventListener('click', () => logout());
    r.advanced.addEventListener('click', () => go('settings', { advanced: true }));
  },
};

export const resume = {
  id: 'resume',
  root: true,
  init(el) {
    this.r = refs(el);
    this.r.resume.addEventListener('click', () => {
      if (this.saved) resumeSavedGame(this.saved);
    });
    this.r.newGame.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Start a new game?',
        body: 'Your saved game will be deleted.',
        confirmLabel: 'New game',
        danger: true,
      });
      if (!ok) return;
      await deleteSavedGame();
      this.saved = null;
      go('picker');
    });
  },
  show({ saved } = {}) {
    if (saved) this.saved = saved;
    if (!this.saved) {
      go('picker');
      return;
    }
    this.r.playlist.textContent = this.saved.playlist?.name ?? '';
    this.r.progress.textContent = songProgress(this.saved.round, this.saved.songs.length);
  },
};
