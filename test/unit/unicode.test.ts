import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_OVERRIDES,
  OverrideProvider,
  packCharProperties,
  unpackCharProperties,
  type UnicodeProvider,
} from '../../src/unicode.ts';

/**
 * A stand-in for the graphemes addon's provider. It bills every codepoint one
 * column and reports a charKind derived from the codepoint, which is enough to
 * pin that the override preserves the delegate's segmentation state.
 */
function fakeDelegate(width = 1): UnicodeProvider {
  return {
    version: '15-graphemes',
    ambiguousCharsAreWide: false,
    charProperties(codepoint: number) {
      return packCharProperties(codepoint & 0xff, width, false);
    },
    wcwidth() {
      return width;
    },
  };
}

test('the packed property layout round trips', () => {
  for (const width of [0, 1, 2]) {
    for (const shouldJoin of [false, true]) {
      const packed = packCharProperties(0x1234, width, shouldJoin);
      assert.deepEqual(unpackCharProperties(packed), { charKind: 0x1234, width, shouldJoin });
    }
  }
});

test('the shipped default zeroes ZWSP and nothing else', () => {
  assert.deepEqual(DEFAULT_OVERRIDES, { 0x200b: 0 });
});

test('a codepoint with no override is passed straight through', () => {
  const delegate = fakeDelegate(2);
  const provider = new OverrideProvider(delegate, DEFAULT_OVERRIDES);
  const expected = delegate.charProperties(0x4e16, 0);
  assert.equal(provider.charProperties(0x4e16, 0), expected);
  assert.equal(provider.wcwidth(0x4e16), 2);
});

test('ZWSP is rewritten to zero width and joined onto what precedes it', () => {
  // The join is what actually suppresses the advance: InputHandler only skips
  // the cursor increment on the joining branch, so a width of 0 without it
  // would still eat a column.
  const provider = new OverrideProvider(fakeDelegate(), DEFAULT_OVERRIDES);
  const properties = unpackCharProperties(provider.charProperties(0x200b, 1));
  assert.equal(properties.width, 0);
  assert.equal(properties.shouldJoin, true);
  assert.equal(provider.wcwidth(0x200b), 0);
});

test('ZWSP at column 0 is zero width but not joined, because there is nothing to join to', () => {
  // With no preceding cell InputHandler has nowhere to put the codepoint and
  // writes it into a cell of its own. That is not fixable from a width table
  // and the provider must not claim a join that cannot happen.
  const provider = new OverrideProvider(fakeDelegate(), DEFAULT_OVERRIDES);
  const properties = unpackCharProperties(provider.charProperties(0x200b, 0));
  assert.equal(properties.width, 0);
  assert.equal(properties.shouldJoin, false);
});

test('the delegate charKind survives the override', () => {
  // The addon's segmentation state machine reads charKind back on the next
  // scalar, so dropping it would break clustering everywhere after a ZWSP.
  const delegate = fakeDelegate();
  const provider = new OverrideProvider(delegate, DEFAULT_OVERRIDES);
  const expected = unpackCharProperties(delegate.charProperties(0x200b, 1)).charKind;
  assert.equal(unpackCharProperties(provider.charProperties(0x200b, 1)).charKind, expected);
});

test('ZWJ is left alone, because zeroing it breaks emoji sequences', () => {
  // The addon returns the joined cluster's accumulated width through the ZWJ's
  // own property value. Zero it and a family emoji re-advances at every joiner.
  const delegate = fakeDelegate(2);
  const provider = new OverrideProvider(delegate, DEFAULT_OVERRIDES);
  assert.equal(provider.charProperties(0x200d, 1), delegate.charProperties(0x200d, 1));
  assert.equal(provider.wcwidth(0x200d), 2);
});

test('an empty override map is a pure pass-through', () => {
  const delegate = fakeDelegate();
  const provider = new OverrideProvider(delegate, {});
  assert.equal(provider.charProperties(0x200b, 1), delegate.charProperties(0x200b, 1));
});

test('a non-zero override sets the width without claiming a join', () => {
  const provider = new OverrideProvider(fakeDelegate(1), { 0x2500: 2 });
  const properties = unpackCharProperties(provider.charProperties(0x2500, 1));
  assert.equal(properties.width, 2);
  assert.equal(properties.shouldJoin, false);
  assert.equal(provider.wcwidth(0x2500), 2);
});

test('the version string is taken from the delegate, so it displaces it in the registry', () => {
  const provider = new OverrideProvider(fakeDelegate(), DEFAULT_OVERRIDES);
  assert.equal(provider.version, '15-graphemes');
});

test('ambiguousCharsAreWide reads and writes through to the delegate', () => {
  const delegate = fakeDelegate();
  const provider = new OverrideProvider(delegate, DEFAULT_OVERRIDES);
  assert.equal(provider.ambiguousCharsAreWide, false);
  provider.ambiguousCharsAreWide = true;
  assert.equal(delegate.ambiguousCharsAreWide, true);
  assert.equal(provider.ambiguousCharsAreWide, true);
});
