import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  backgroundNames,
  backgrounds,
  resolveBackground,
  shadows,
} from '../../src/chrome/presets.ts';

test('the default background is a preset, not nothing', () => {
  assert.equal(resolveBackground(undefined), backgrounds.aurora);
});

test('a bare string is a preset name when it names one', () => {
  assert.equal(resolveBackground('sunset'), backgrounds.sunset);
});

test('a bare string that names no preset is passed through as CSS', () => {
  // The escape hatch: anything the browser accepts for `background`.
  assert.equal(resolveBackground('#101014'), '#101014');
  assert.equal(
    resolveBackground('linear-gradient(90deg, red, blue)'),
    'linear-gradient(90deg, red, blue)',
  );
});

test('an empty string falls back rather than painting nothing', () => {
  // A select that has not been populated yet reads as '', and a frame with no
  // background at all looks like a mistake rather than like `none`.
  assert.equal(resolveBackground(''), backgrounds.aurora);
  assert.equal(resolveBackground('   '), backgrounds.aurora);
  // Asking for nothing on purpose still works.
  assert.equal(resolveBackground('none'), backgrounds.none);
});

test('the tagged forms each resolve', () => {
  assert.equal(resolveBackground({ preset: 'noir' }), backgrounds.noir);
  assert.equal(resolveBackground({ color: '#fff' }), '#fff');
  assert.equal(resolveBackground({ gradient: 'radial-gradient(red, blue)' }), 'radial-gradient(red, blue)');
  assert.equal(resolveBackground({ css: 'red url(x.png)' }), 'red url(x.png)');
});

test('an image resolves to a shorthand with cover defaults', () => {
  assert.equal(resolveBackground({ image: '/a.png' }), 'url("/a.png") center / cover no-repeat');
  assert.equal(
    resolveBackground({ image: '/a.png', size: '200px', position: 'top left', repeat: 'repeat' }),
    'url("/a.png") top left / 200px repeat',
  );
});

test('every named background is exported and non-empty', () => {
  assert.ok(backgroundNames.length >= 8);
  for (const name of backgroundNames) {
    assert.equal(typeof backgrounds[name], 'string');
    assert.ok(backgrounds[name].length > 0);
  }
});

test('each shadow beyond none is layered', () => {
  assert.equal(shadows.none, 'none');
  for (const size of ['small', 'medium', 'large'] as const) {
    // A single shadow cannot be both a contact shadow and a diffuse one, so
    // every size is a stack.
    assert.ok(shadows[size].split(',').length >= 3, `${size} is not layered`);
  }
});
