#!/usr/bin/env node
// Write the build sizes into README.md from dist/, or check that they match.
//
//   node scripts/sizes.mjs          rewrite the figures from the current dist/
//   node scripts/sizes.mjs --check  exit 1 when a figure differs from dist/
//
// Run it after `npm run build`. The README carries two kinds of marker:
//
//   <!-- sizes:begin --> ... <!-- sizes:end -->
//       The size table, regenerated whole from FILES below.
//   <!-- size:dist/index.js:gzip -->34.9 KB<!-- /size -->
//       One figure in prose. The field is raw or gzip, and an optional third
//       field `bytes` prints whole bytes instead of KB.
//
// The figures were written by hand before this script, and they went stale:
// the README said 861.5 KB for a standalone bundle that had grown to 1.8 MB.
// KB is 1000 bytes. Gzip is zlib at level 6, the level `gzip` uses by default.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const README = join(ROOT, 'README.md');

/** The table rows, in order, with what each file is. */
const FILES = [
  ['dist/index.js', 'ESM core, xterm external'],
  ['dist/transport/index.js', 'Both transports and the combinators'],
  ['dist/vtgl/index.js', 'The vtgl renderer adapter, vtgl itself external'],
  ['dist/chrome/index.js', 'The window chrome'],
  ['dist/mobile/index.js', 'Touch support: key bar, touch mouse, keyboard-aware layout'],
  ['dist/themes/index.js', 'The theme corpus, imported only if asked for'],
  ['dist/webterm.css', 'Container, scrollbar, overlay'],
  ['dist/chrome.css', 'The frame'],
  [
    'dist/webterm.standalone.global.js',
    'Everything inlined for a script tag: xterm, all five addons, the transports and touch support',
  ],
  [
    'dist/webterm-vtgl.standalone.global.js',
    'The vtgl renderer for a script tag, with vtgl, its HarfBuzz wasm and font',
  ],
  ['dist/webterm-chrome.standalone.global.js', 'The frame, for a script tag'],
];

/**
 * Upper bounds in raw bytes, checked by --check.
 *
 * The standalone bundle is the one a script-tag page downloads before the
 * terminal opens, and sip, tuios-web and the tuios Learn tour all ship it. It
 * grew from 861 KB to 1,811 KB when vtgl was inlined into it without anyone
 * noticing, so it carries a budget that the vtgl renderer alone would exceed.
 */
const BUDGETS = {
  'dist/webterm.standalone.global.js': 1_000_000,
};

const cache = new Map();
function measure(file) {
  if (!cache.has(file)) {
    let bytes;
    try {
      bytes = readFileSync(join(ROOT, file));
    } catch {
      throw new Error(`${file} is missing. Run npm run build first.`);
    }
    cache.set(file, { raw: bytes.length, gzip: gzipSync(bytes, { level: 6 }).length });
  }
  return cache.get(file);
}

const kb = (bytes) => `${(bytes / 1000).toFixed(1)} KB`;

function table() {
  const rows = FILES.map(([file, what]) => {
    const { raw, gzip } = measure(file);
    return `| \`${file}\` | ${kb(raw)} | ${kb(gzip)} | ${what} |`;
  });
  return ['| File | Raw | Gzip | What it is |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

function render(text) {
  const begin = '<!-- sizes:begin -->';
  const end = '<!-- sizes:end -->';
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start < 0 || stop < start) throw new Error('README.md has no sizes:begin/sizes:end markers');
  let out = `${text.slice(0, start + begin.length)}\n${table()}\n${text.slice(stop)}`;

  out = out.replace(
    /<!-- size:([^:\s]+):(raw|gzip)(:bytes)? -->[^<]*<!-- \/size -->/g,
    (_, file, field, bytes) => {
      const value = measure(file)[field];
      const shown = bytes ? `${value} bytes` : kb(value);
      return `<!-- size:${file}:${field}${bytes ?? ''} -->${shown}<!-- /size -->`;
    },
  );
  return out;
}

const check = process.argv.includes('--check');
const current = readFileSync(README, 'utf8');
const next = render(current);

const over = Object.entries(BUDGETS).filter(([file, max]) => measure(file).raw > max);
for (const [file, max] of over) {
  console.error(`${file} is ${measure(file).raw} bytes, over its budget of ${max} bytes.`);
}

if (check) {
  if (over.length) process.exit(1);
  if (next !== current) {
    const before = current.split('\n');
    const after = next.split('\n');
    const changed = [];
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      if (before[i] !== after[i]) changed.push(`  README.md:${i + 1}\n    is:     ${before[i]}\n    build:  ${after[i]}`);
    }
    console.error(`The sizes in README.md do not match dist/. Run npm run sizes.\n${changed.join('\n')}`);
    process.exit(1);
  }
  console.log('README.md sizes match dist/.');
} else if (next !== current) {
  writeFileSync(README, next);
  console.log('README.md sizes updated.');
} else {
  console.log('README.md sizes already match dist/.');
}
