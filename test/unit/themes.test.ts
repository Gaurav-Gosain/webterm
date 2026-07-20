import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getTheme, getThemeEntry, listThemes, themeCorpus } from '../../src/themes/index.ts';

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
] as const;

const HEX = /^#[0-9a-f]{6}$/;

test('the corpus loads and is large enough to be the corpus', () => {
  // A generator that silently emitted a handful of schemes would still pass
  // every other test here, so the count is asserted as a floor.
  const ids = Object.keys(themeCorpus);
  assert.ok(ids.length > 300, `expected the full corpus, got ${ids.length}`);
});

test('ids are unique and are usable as ids', () => {
  const ids = Object.keys(themeCorpus);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    // Lowercase, hyphenated, no leading or trailing separator: safe in a URL,
    // a CSS class and a config file without being escaped.
    assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `bad id: ${id}`);
  }
});

test('every scheme carries a full palette', () => {
  for (const [id, entry] of Object.entries(themeCorpus)) {
    assert.ok(entry.name.length > 0, `${id} has no name`);
    assert.match(entry.theme.background ?? '', HEX, `${id} background`);
    assert.match(entry.theme.foreground ?? '', HEX, `${id} foreground`);
    assert.match(entry.theme.cursor ?? '', HEX, `${id} cursor`);
    // cursorAccent is the glyph drawn inside a block cursor. xterm defaults it
    // to black, which vanishes on a dark scheme, so every entry sets it.
    assert.equal(entry.theme.cursorAccent, entry.theme.background, `${id} cursorAccent`);
    for (const key of ANSI) {
      assert.match(entry.theme[key] ?? '', HEX, `${id} ${key}`);
    }
  }
});

test('appearance follows the background, not the name', () => {
  // Schemes whose names point the wrong way, which is the case the computed
  // classification exists for.
  assert.equal(getThemeEntry('bright-lights')?.appearance, 'dark');
  assert.equal(getThemeEntry('thayer-bright')?.appearance, 'dark');
  assert.equal(getThemeEntry('tomorrow-night-bright')?.appearance, 'dark');
  assert.equal(getThemeEntry('tokyo-night-light')?.appearance, 'light');
  assert.equal(getThemeEntry('night-owlish-light')?.appearance, 'light');
  // And the obvious ones, so a threshold that inverted the whole corpus is
  // caught rather than passing on the exceptions alone.
  assert.equal(getThemeEntry('catppuccin-mocha')?.appearance, 'dark');
  assert.equal(getThemeEntry('catppuccin-latte')?.appearance, 'light');
  assert.equal(getThemeEntry('gruvbox-dark')?.appearance, 'dark');
  assert.equal(getThemeEntry('gruvbox-light')?.appearance, 'light');
  assert.equal(getThemeEntry('iterm2-solarized-light')?.appearance, 'light');
  assert.equal(getThemeEntry('iterm2-solarized-dark')?.appearance, 'dark');
  assert.equal(getThemeEntry('nord')?.appearance, 'dark');
});

test('appearance agrees with the luminance it was computed from', () => {
  const toLinear = (byte: number) => {
    const c = byte / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  for (const [id, entry] of Object.entries(themeCorpus)) {
    const hex = entry.theme.background as string;
    const luminance =
      0.2126 * toLinear(parseInt(hex.slice(1, 3), 16)) +
      0.7152 * toLinear(parseInt(hex.slice(3, 5), 16)) +
      0.0722 * toLinear(parseInt(hex.slice(5, 7), 16));
    assert.equal(entry.appearance, luminance > 0.18 ? 'light' : 'dark', `${id} at ${luminance}`);
  }
});

test('both appearances are well represented', () => {
  const list = listThemes();
  const light = list.filter((meta) => meta.appearance === 'light').length;
  assert.ok(light > 20, `expected light schemes, got ${light}`);
  assert.ok(list.length - light > 200, 'expected the corpus to be mostly dark');
});

test('getTheme returns the palette and nothing else', () => {
  const theme = getTheme('nord');
  assert.equal(theme, themeCorpus.nord.theme);
  assert.equal(theme?.background, '#2e3440');
});

test('an unknown id is undefined rather than a throw or a default', () => {
  assert.equal(getTheme('no-such-theme'), undefined);
  assert.equal(getThemeEntry('no-such-theme'), undefined);
});

test('a prototype key does not resolve to a prototype member', () => {
  // getTheme takes whatever a config file or a URL fragment held, so an id of
  // `constructor` must miss rather than hand back a function.
  assert.equal(getTheme('constructor'), undefined);
  assert.equal(getTheme('toString'), undefined);
  assert.equal(getThemeEntry('__proto__'), undefined);
});

test('listThemes covers the corpus and is stable across calls', () => {
  const list = listThemes();
  assert.equal(list.length, Object.keys(themeCorpus).length);
  // The same object each time, so it is safe as a memo or effect dependency.
  assert.equal(listThemes(), list);
  for (const meta of list) {
    const entry = themeCorpus[meta.id as keyof typeof themeCorpus];
    assert.equal(meta.name, entry.name);
    assert.equal(meta.appearance, entry.appearance);
  }
});
