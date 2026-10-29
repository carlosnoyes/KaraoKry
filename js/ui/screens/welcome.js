// Screen 1: Welcome.

import { go } from '../../router.js';
import { refs } from '../dom.js';
import { startLogin, getClientId } from '../../auth.js';
import { canInstall, onInstallChange, promptInstall, isLoopbackHost } from '../../pwa.js';
import { showDialog } from '../dialogs.js';
import { toast } from '../toast.js';

const LOGIN_LABEL = 'Log in with Spotify';
const RETRY_LABEL = 'Try logging in again';

export default {
  id: 'welcome',
  root: true,

  init(el) {
    this.r = refs(el);
    this.loginLabel = LOGIN_LABEL;
    this.r.login.addEventListener('click', () => this.login());
    this.r.howto.addEventListener('click', () => go('how-to'));
    this.r.install.addEventListener('click', () => promptInstall());
    onInstallChange((available) => {
      this.r.install.hidden = !available;
    });
    // Coming back from Spotify's page with the browser's back button restores this page as it was.
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) this.resetLoginButton();
    });
    if (isLoopbackHost()) {
      this.r.demo.hidden = false;
      this.r.demo.addEventListener('click', async () => {
        const { startDemoGame } = await import('../../dev/demo.js');
        startDemoGame();
      });
    }
  },

  show(params = {}) {
    this.r.message.textContent = params.message ?? '';
    this.r.message.hidden = !params.message;
    this.loginLabel = params.retry ? RETRY_LABEL : LOGIN_LABEL;
    this.resetLoginButton();
    this.r.install.hidden = !canInstall();
  },

  resetLoginButton() {
    this.r.login.disabled = false;
    this.r.login.textContent = this.loginLabel;
  },

  async login() {
    if (!getClientId()) {
      const choice = await showDialog({
        title: 'Spotify app not set up yet',
        body: "KaraoKry isn't connected to a Spotify app yet. The person who runs KaraoKry needs to add the Client ID (see the README), or you can use your own in Settings.",
        actions: [
          { label: 'Close', value: null, kind: 'secondary' },
          { label: 'Open Settings', value: 'settings', kind: 'primary' },
        ],
      });
      if (choice === 'settings') go('settings', { advanced: true });
      return;
    }
    this.r.login.disabled = true;
    this.r.login.textContent = 'Opening Spotify...';
    try {
      await startLogin();
    } catch {
      this.resetLoginButton();
      toast("Couldn't open the Spotify login. Try again.");
    }
  },
};
