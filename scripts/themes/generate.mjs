#!/usr/bin/env node
// Generates src/themes/data.ts, the vendored terminal colour scheme corpus.
//
//   node scripts/themes/generate.mjs           # refresh from upstream
//   node scripts/themes/generate.mjs --check   # regenerate and diff, no write
//
// The corpus is mbadolato/iTerm2-Color-Schemes, which is the collection every
// other project ends up copying from, taken through the flattened JSON build of
// it that charmbracelet/vhs publishes. That file is used rather than the
// upstream .itermcolors plists because the plists carry floating point 0..1
// component values per channel across four scheme dialects, and vhs has already
// done the normalisation into one hex-per-role shape.
//
// The output is committed. Nothing in install or build reaches the network:
// this script is run by hand when the corpus is worth refreshing, and its output
// is reviewed as a diff like any other source change.
//
// Light and dark are computed here, not read from the upstream `meta.isDark`
// flag and not guessed from the name. "Bright Lights", "Thayer Bright" and
// "Tomorrow Night Bright" are all dark and "Tokyo Night Light" is light, so the
// name is worthless, and the upstream flag is hand-maintained metadata that a
// new scheme can arrive without, as thirteen of them arrived with no cursor. The
// background colour is the one thing that is always present and always means
// the same thing, so it is gamma-decoded and reduced to a WCAG relative
// luminance. See THRESHOLD below for where the cut is put.
//
// Requires: network access. No node_modules.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const OUT = join(ROOT, 'src/themes/data.ts');
const SOURCE = 'https://github.com/charmbracelet/vhs/raw/refs/heads/main/themes.json';
const LICENSE_URL =
  'https://raw.githubusercontent.com/mbadolato/iTerm2-Color-Schemes/master/LICENSE';

// The cut between light and dark, on WCAG relative luminance of the background.
//
// 0.18 is the luminance of mid grey once sRGB is gamma-decoded, so it is the
// perceptual middle of the range rather than an arbitrary number, and it is the
// same midpoint the WCAG contrast ratio is built around. It also happens to
// agree with every one of the upstream `meta.isDark` flags on the corpus at
// hand, which is the check that it is not merely defensible but correct. The
// nearest schemes to it are Unikitty at 0.450 on the light side and Grass at
// 0.137 on the dark side, so there is a wide margin either way and a small move
// in the threshold reclassifies nothing.
const THRESHOLD = 0.18;

/**
 * One sRGB channel, 0..255, decoded to linear light. The piecewise form is the
 * sRGB transfer function itself: the low end is a linear segment because a pure
 * power curve has an infinite slope at zero, which quantises badly in 8 bits.
 */
function toLinear(byte) {
  const c = byte / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#rrggbb` string. */
function luminance(hex) {
  const r = toLinear(parseInt(hex.slice(1, 3), 16));
  const g = toLinear(parseInt(hex.slice(3, 5), 16));
  const b = toLinear(parseInt(hex.slice(5, 7), 16));
  // The green weight dominates because the eye's luminance response does.
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Turns a display name into a stable id.
 *
 * The camel case split is what keeps `TokyoNight` and `tokyonight` apart. They
 * are two different palettes that both ship in the corpus, and folding case
 * first would collapse them into one id and silently drop a scheme. `+` is
 * spelled out for the same reason: `Dracula` and `Dracula+` are distinct, and
 * stripping punctuation would merge them.
 *
 * The split needs two lowercase letters before the capital, or `iTerm2` becomes
 * `i-term2`. A single leading lowercase letter is a prefix on the word after
 * it, not a word of its own.
 */
function toId(name) {
  return name
    .replace(/\+/g, ' plus ')
    .replace(/([a-z]{2,})([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The order xterm's ITheme lists them in, which is also the order an ANSI
// palette is indexed in, so a generated entry can be read against a colour
// table without counting.
const ANSI = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
];

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Maps one upstream record onto an ITheme.
 *
 * Thirteen schemes carry no `cursor`, so it falls back to the foreground, which
 * is what a terminal does when a scheme does not name one: the cursor is the
 * text colour drawn as a block. Leaving it unset would hand xterm its own
 * default of white, which is invisible on a light scheme.
 *
 * Two more fields need thought. `selection` is a single colour upstream and
 * becomes `selectionBackground`; `selectionForeground` is deliberately left
 * unset, because the corpus does not carry one and inventing it would override
 * xterm's own behaviour of keeping the cell's foreground under a selection.
 * `cursorAccent` is set to the background, since that is the colour a block
 * cursor's glyph has to be drawn in to stay legible, and xterm defaults it to
 * black otherwise, which disappears on a dark scheme.
 */
function toTheme(raw) {
  // Case is normalised because the corpus is inconsistent about it, and a
  // consumer comparing a theme colour against one of its own would otherwise
  // have to know which schemes shout their hex digits.
  const hex = (value) => value.toLowerCase();
  const theme = {
    foreground: hex(raw.foreground),
    background: hex(raw.background),
    cursor: hex(raw.cursor ?? raw.foreground),
    cursorAccent: hex(raw.background),
  };
  if (raw.selection) theme.selectionBackground = hex(raw.selection);
  for (const key of ANSI) theme[key] = hex(raw[key]);
  return theme;
}

/** Emits a TypeScript object literal at a fixed indent, keys quoted only when needed. */
function literal(value, indent) {
  const pad = '  '.repeat(indent);
  const inner = '  '.repeat(indent + 1);
  const lines = Object.entries(value).map(([key, val]) => {
    const name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `'${key}'`;
    const rendered =
      typeof val === 'string'
        ? `'${val}'`
        : typeof val === 'object'
          ? literal(val, indent + 1)
          : String(val);
    return `${inner}${name}: ${rendered},`;
  });
  return `{\n${lines.join('\n')}\n${pad}}`;
}

const check = process.argv.includes('--check');

const upstream = JSON.parse(await fetchText(SOURCE));
const license = await fetchText(LICENSE_URL);
if (!/MIT License/.test(license)) {
  // The header this script writes asserts the upstream terms. If they ever
  // change, the assertion has to be rewritten by a human rather than carried
  // forward by a script that never looked.
  throw new Error(`upstream LICENSE is no longer the MIT text; review ${LICENSE_URL}`);
}

// The corpus ships a handful of schemes twice, under a display spelling and a
// slug spelling of the same name: `Rose Pine` and `rose-pine`, `Catppuccin
// Macchiato` and `catppuccin-macchiato`. Most of those pairs are byte-identical
// and one entry is simply dropped. A few are not, because one copy was updated
// upstream and the other was not, and dropping either would lose a palette
// someone is asking for by name. Those get a numbered id, assigned in sorted
// name order so the output does not move when the upstream file is reordered.
const entries = new Map();
const byId = new Map();
for (const raw of [...upstream].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
  const base = toId(raw.name);
  const theme = toTheme(raw);
  const seen = byId.get(base) ?? [];
  if (seen.some((other) => JSON.stringify(other) === JSON.stringify(theme))) continue;
  seen.push(theme);
  byId.set(base, seen);
  const id = seen.length === 1 ? base : `${base}-${seen.length}`;
  entries.set(id, {
    id,
    name: raw.name,
    appearance: luminance(raw.background) > THRESHOLD ? 'light' : 'dark',
    theme,
  });
}

const sorted = [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
const dark = sorted.filter((entry) => entry.appearance === 'dark').length;

const body = sorted
  .map((entry) =>
    literal({ name: entry.name, appearance: entry.appearance, theme: entry.theme }, 1).replace(
      /^\{/,
      `'${entry.id}': {`,
    ),
  )
  .map((text) => `  ${text},`)
  .join('\n');

// The `/*!` marker is what makes esbuild treat this as a legal comment and keep
// it in the bundle. The MIT terms require the notice to travel with the copies,
// and the built dist/ files are copies, so the notice has to survive the build
// rather than only exist in the repository.
const out = `/*!
 * Terminal colour schemes from iTerm2-Color-Schemes.
 * @license MIT
 *
 * Copyright (c) 2011 to Present Mark Badolato
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * The copyright and licence for each individual scheme belongs to the author of
 * that scheme. https://github.com/mbadolato/iTerm2-Color-Schemes
 */

// Generated by scripts/themes/generate.mjs. Do not edit by hand.
//
// Source: ${SOURCE}
// Schemes: ${sorted.length} (${dark} dark, ${sorted.length - dark} light)
// Appearance: WCAG relative luminance of the background, cut at ${THRESHOLD}.
import type { ThemeEntry } from './types.js';

/**
 * Every id in the corpus, as a union, so an editor completes it and a typo is a
 * compile error rather than a silent miss.
 */
export type ThemeId =
${sorted.map((entry) => `  | '${entry.id}'`).join('\n')};

// Annotated rather than inferred. \`satisfies\` would work and would give the
// same key union, but it also carries all 22 colours of all ${sorted.length} palettes into
// the emitted .d.ts as literal types, which is a megabyte of declarations
// nobody reads and a real cost on every consumer's typecheck.
export const themeCorpus: Record<ThemeId, ThemeEntry> = {
${body}
};
`;

if (check) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== out) {
    console.error(`${OUT} is stale; run node scripts/themes/generate.mjs`);
    process.exit(1);
  }
  console.log(`${OUT} is up to date (${sorted.length} schemes)`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, out);
  console.log(`wrote ${OUT}: ${sorted.length} schemes, ${dark} dark, ${sorted.length - dark} light`);
}
