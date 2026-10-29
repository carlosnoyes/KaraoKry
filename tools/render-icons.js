// Renders icons/icon.svg to the PNG icons with headless Chrome or Edge.
//
//   node tools/render-icons.js       (or: npm run icons)
//
// Set CHROME=/path/to/chrome if it is not found automatically.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ICONS = join(ROOT, 'icons');

const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const browser = CANDIDATES.find((path) => existsSync(path));
if (!browser) {
  console.error('Chrome or Edge not found. Set CHROME=/path/to/chrome.');
  process.exit(1);
}

const master = readFileSync(join(ICONS, 'icon.svg'), 'utf8');

// Maskable: the background fills the whole square and the artwork sits inside
// the central 80% safe zone.
const maskable = master
  .replace(/(<rect id="bg"[^>]*?) rx="112"/, '$1')
  .replace(/(<rect id="spotlight"[^>]*?) rx="112"/, '$1')
  .replace('<g id="art">', '<g id="art" transform="translate(256 256) scale(0.8) translate(-256 -256)">');

const jobs = [
  { svg: master, size: 192, out: 'icon-192.png' },
  { svg: master, size: 512, out: 'icon-512.png' },
  { svg: maskable, size: 512, out: 'icon-maskable-512.png' },
];

const work = mkdtempSync(join(tmpdir(), 'karaokry-icons-'));
try {
  for (const { svg, size, out } of jobs) {
    const html = join(work, `${out}.html`);
    writeFileSync(html, `<!doctype html><html><head><style>
      html,body{margin:0;padding:0;background:transparent;overflow:hidden}
      svg{display:block;width:${size}px;height:${size}px}
    </style></head><body>${svg.replace(/<svg /, '<svg ')}</body></html>`);
    execFileSync(browser, [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      `--window-size=${size},${size}`,
      `--screenshot=${join(ICONS, out)}`,
      pathToFileURL(html).href,
    ], { stdio: 'pipe' });
    console.log(`icons/${out} (${size}x${size})`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
