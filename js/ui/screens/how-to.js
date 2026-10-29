// Screen 3: How to play. Three cards with Next, Skip and "Let's go".

import { go } from '../../router.js';
import { refs } from '../dom.js';
import { lsSet } from '../../storage.js';
import { isLoggedIn } from '../../auth.js';

export default {
  id: 'how-to',

  init(el) {
    this.r = refs(el);
    this.cards = [...this.r.cards.children];
    this.dots = [...this.r.dots.children];
    this.index = 0;
    this.r.next.addEventListener('click', () => this.next());
    this.r.skip.addEventListener('click', () => this.finish());
  },

  show(params = {}, fromId) {
    if (!params.restore) {
      this.onDone = params.onDone ?? null;
      this.fromId = fromId && fromId !== 'loading' ? fromId : null;
    }
    this.index = 0;
    this.render();
  },

  render() {
    const last = this.cards.length - 1;
    this.cards.forEach((card, i) => {
      card.hidden = i !== this.index;
      if (i === this.index) card.setAttribute('aria-current', 'step');
      else card.removeAttribute('aria-current');
    });
    this.dots.forEach((dot, i) => dot.classList.toggle('is-on', i === this.index));
    this.r.next.textContent = this.index === last ? "Let's go" : 'Next';
    this.r.skip.hidden = this.index === last;
  },

  next() {
    if (this.index < this.cards.length - 1) {
      this.index++;
      this.render();
    } else {
      this.finish();
    }
  },

  finish() {
    lsSet('kk.seenHowTo', true);
    const onDone = this.onDone;
    this.onDone = null;
    if (onDone) onDone();
    else go(this.fromId ?? (isLoggedIn() ? 'picker' : 'welcome'), { restore: true });
  },

  back() {
    this.finish();
  },
};
