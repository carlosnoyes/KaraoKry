// Checks that the service worker caches every app file and that versions match.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from '../config.js';
import { chooseDevice } from '../js/playback/connect-engine.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
const shell = [...sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test('sw.js VERSION matches APP_VERSION in config.js', () => {
  const version = sw.match(/const VERSION = '([^']+)'/)[1];
  assert.equal(version, APP_VERSION);
});

test('every shell entry exists', () => {
  for (const path of shell) {
    if (path === './') continue;
    assert.ok(existsSync(join(ROOT, path)), `missing: ${path}`);
  }
});

test('every app module, the stylesheet and the icons are in the shell (dev tools excepted)', () => {
  const files = [...walk(join(ROOT, 'js')), ...walk(join(ROOT, 'css')), ...walk(join(ROOT, 'icons'))]
    .map((path) => relative(ROOT, path).split(sep).join('/'))
    .filter((path) => !path.startsWith('js/dev/'));
  for (const file of files) assert.ok(shell.includes(file), `not cached by sw.js: ${file}`);
  for (const file of ['index.html', 'manifest.webmanifest', 'config.js']) assert.ok(shell.includes(file));
});

test('manifest icons exist and the maskable one is declared', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.orientation, 'portrait');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  for (const icon of manifest.icons) assert.ok(existsSync(join(ROOT, icon.src)), icon.src);
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));
});

test('the Connect engine picks the phone, never a speaker or KaraoKry itself', () => {
  assert.equal(chooseDevice([
    { id: 'tv', type: 'TV', is_active: true },
    { id: 'phone', type: 'Smartphone', is_active: false },
  ]).id, 'phone');
  assert.equal(chooseDevice([
    { id: 'kk', type: 'Smartphone', name: 'KaraoKry', is_active: true },
    { id: 'phone2', type: 'Smartphone', is_active: false },
  ]).id, 'phone2');
  assert.equal(chooseDevice([{ id: 'pc', type: 'Computer', is_active: true }]).id, 'pc');
  assert.equal(chooseDevice([{ id: 'pc', type: 'Computer', is_active: false }]), null);
  assert.equal(chooseDevice([]), null);
});
