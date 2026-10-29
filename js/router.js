// Shows one screen at a time and handles Android's back gesture.
//
// History model: "root" screens (Welcome, Playlist picker...) sit on the base
// history entry, so Back there leaves the app as usual. Every other screen keeps
// exactly one extra entry on top. Back pops it, the screen's back() decides what
// happens, and the entry is pushed again, so the app never closes by surprise.

import { closeTopDialog } from './ui/dialogs.js';

const screens = new Map();
const listeners = new Set();
let current = null;
let hasTop = history.state?.kk === 'top';
let pendingPop = false;
let wantTop = false;

/**
 * @param {{id: string, root?: boolean, init?: (el: HTMLElement) => void,
 *          show?: (params: object, fromId: string|null) => void, hide?: () => void, back?: () => void}} screen
 */
export function registerScreen(screen) {
  const el = document.getElementById(`screen-${screen.id}`);
  if (!el) throw new Error(`Missing <section id="screen-${screen.id}">`);
  screen.el = el;
  screens.set(screen.id, screen);
  screen.init?.(el);
}

export function currentScreenId() {
  return current?.id ?? null;
}

/** fn(newId, previousId) after every screen change. */
export function onScreenChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function go(id, params = {}) {
  const next = screens.get(id);
  if (!next) throw new Error(`Unknown screen: ${id}`);
  const previous = current;
  if (previous && previous !== next) {
    previous.hide?.();
    previous.el.hidden = true;
  }
  current = next;
  next.el.hidden = false;
  next.show?.(params, previous?.id ?? null);
  syncHistory(next);
  if (previous !== next) moveFocus(next.el);
  for (const fn of listeners) fn(id, previous?.id ?? null);
}

function moveFocus(el) {
  const target = el.querySelector('[data-autofocus]') ?? el.querySelector('h1, h2');
  if (!target) return;
  if (!target.hasAttribute('tabindex') && !/^(BUTTON|INPUT|A)$/.test(target.tagName)) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

function pushTop() {
  history.pushState({ kk: 'top' }, '');
  hasTop = true;
}

function ensureTop() {
  if (!current || current.root || hasTop) return;
  if (pendingPop) wantTop = true;
  else pushTop();
}

function syncHistory(screen) {
  if (!screen.root) {
    ensureTop();
    return;
  }
  wantTop = false;
  if (hasTop) {
    hasTop = false;
    pendingPop = true;
    history.back();
  }
}

window.addEventListener('popstate', () => {
  if (pendingPop) {
    pendingPop = false;
    if (wantTop) {
      wantTop = false;
      pushTop();
    }
    return;
  }
  hasTop = false;
  if (!closeTopDialog()) current?.back?.();
  ensureTop();
});
