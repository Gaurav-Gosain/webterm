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

test('the shipped default zeroes ZWSP and widens the indicators and the matra', () => {
  assert.equal(DEFAULT_OVERRIDES[0x200b], 0);
  // Every regional indicator, both ends of the range and one in the middle.
  assert.equal(DEFAULT_OVERRIDES[0x1f1e6], 2);
  assert.equal(DEFAULT_OVERRIDES[0x1f1ef], 2);
  assert.equal(DEFAULT_OVERRIDES[0x1f1ff], 2);
  // The Devanagari spacing matra.
  assert.equal(DEFAULT_OVERRIDES[0x093f], 2);
  // Nothing outside those: 26 indicators, the matra and ZWSP.
  assert.equal(Object.keys(DEFAULT_OVERRIDES).length, 26 + 2);
  // A codepoint just past the indicator range is untouched.
  assert.equal(DEFAULT_OVERRIDES[0x1f200], undefined);
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

test('a non-zero override sets the width and keeps the delegate not joining', () => {
  // The fake delegate never joins, so a lone scalar override widens and advances
  // on its own, which is the lone-regional-indicator case.
  const provider = new OverrideProvider(fakeDelegate(1), { 0x2500: 2 });
  const properties = unpackCharProperties(provider.charProperties(0x2500, 1));
  assert.equal(properties.width, 2);
  assert.equal(properties.shouldJoin, false);
  assert.equal(provider.wcwidth(0x2500), 2);
});

test('a non-zero override keeps the delegate join, so it rewidths a cluster', () => {
  // When the delegate joins a scalar onto the cluster before it, InputHandler
  // reads the returned width back as the cluster's running width. A non-zero
  // override must keep that join, or a matra whose width it restates would be
  // split off into a cell of its own instead. This is the failure a naive
  // "non-zero means no join" would have shipped for the second regional
  // indicator of a flag and for a spacing matra.
  const joiningDelegate: UnicodeProvider = {
    version: '15-graphemes',
    ambiguousCharsAreWide: false,
    charProperties(codepoint: number) {
      return packCharProperties(codepoint & 0xff, 1, true);
    },
    wcwidth() {
      return 1;
    },
  };
  const provider = new OverrideProvider(joiningDelegate, { 0x93f: 2 });
  const properties = unpackCharProperties(provider.charProperties(0x93f, 1));
  assert.equal(properties.width, 2);
  assert.equal(properties.shouldJoin, true);
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
