import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_TERMINAL_NAME,
  GEOMETRY_WINDOW_OPTIONS,
  decodeTcapName,
  decscusrParam,
  decscusrStyle,
  encodeTcap,
  xtgettcapReply,
} from '../../src/reports.ts';

test('DECSCUSR parameters round trip through shape and blink', () => {
  // The table in the VT525 manual: odd blinks, even is steady, block 1/2,
  // underline 3/4, bar 5/6.
  const expected: Array<[number, string, boolean]> = [
    [1, 'block', true],
    [2, 'block', false],
    [3, 'underline', true],
    [4, 'underline', false],
    [5, 'bar', true],
    [6, 'bar', false],
  ];
  for (const [param, style, blink] of expected) {
    assert.equal(decscusrParam(style, blink), param, `${style} blink=${blink}`);
    assert.equal(decscusrStyle(param), style, `param ${param}`);
  }
});

test('DECSCUSR 0 selects no shape, so the configured cursor stays in force', () => {
  assert.equal(decscusrStyle(0), undefined);
  // Anything outside the table is not a shape either. Reporting one anyway
  // would claim the application set a cursor it never asked for.
  assert.equal(decscusrStyle(7), undefined);
  assert.equal(decscusrStyle(-1), undefined);
});

test('an unset or unknown shape reports as a steady block', () => {
  // xterm.js draws a block for anything it does not recognise, and the report
  // has to describe what is on screen rather than what was asked for.
  assert.equal(decscusrParam(undefined, undefined), 2);
  assert.equal(decscusrParam('rhombus', false), 2);
  assert.equal(decscusrParam(undefined, true), 1);
});

test('capability names decode from hex and reject anything that is not', () => {
  assert.equal(decodeTcapName('544e'), 'TN');
  assert.equal(decodeTcapName('544E'), 'TN');
  assert.equal(decodeTcapName('436f'), 'Co');
  // An odd digit count, an empty payload or a non-hex byte is not a name.
  assert.equal(decodeTcapName('544'), undefined);
  assert.equal(decodeTcapName(''), undefined);
  assert.equal(decodeTcapName('zz'), undefined);
});

test('capability values encode as upper case hex byte pairs', () => {
  assert.equal(encodeTcap('TN'), '544E');
  assert.equal(encodeTcap('256'), '323536');
  assert.equal(encodeTcap('xterm-256color'), '787465726D2D323536636F6C6F72');
  // Nothing webterm answers is outside Latin-1, and guessing an encoding for
  // one would put bytes on the wire that no reader agrees on.
  assert.equal(encodeTcap('世'), '');
});

test('XTGETTCAP answers TN with the configured terminal name', () => {
  assert.equal(
    xtgettcapReply('544e', 'xterm-kitty'),
    '\x1bP1+r544E=787465726D2D6B69747479\x1b\\',
  );
  assert.equal(
    xtgettcapReply('544e', DEFAULT_TERMINAL_NAME),
    '\x1bP1+r544E=787465726D2D323536636F6C6F72\x1b\\',
  );
});

test('XTGETTCAP answers colours under both its termcap and terminfo names', () => {
  // Co is the termcap spelling, colors the terminfo one, and an application
  // may ask for either.
  assert.equal(xtgettcapReply(encodeTcap('Co'), 'x'), `\x1bP1+r${encodeTcap('Co')}=323536\x1b\\`);
  assert.equal(
    xtgettcapReply(encodeTcap('colors'), 'x'),
    `\x1bP1+r${encodeTcap('colors')}=323536\x1b\\`,
  );
});

test('XTGETTCAP answers a multi-capability request in one reply', () => {
  const reply = xtgettcapReply(`${encodeTcap('TN')};${encodeTcap('Co')}`, 'xterm-kitty');
  assert.equal(reply, `\x1bP1+r544E=787465726D2D6B69747479;436F=323536\x1b\\`);
});

test('XTGETTCAP stays silent rather than refusing a capability it cannot judge', () => {
  // A DCS 0 + r refusal is a statement that the terminal lacks the capability.
  // What is true here is only that this layer does not know, and an application
  // that gets no answer falls back to its terminfo entry, which does.
  assert.equal(xtgettcapReply(encodeTcap('Smulx'), 'x'), undefined);
  assert.equal(xtgettcapReply('', 'x'), undefined);
  assert.equal(xtgettcapReply('nothex', 'x'), undefined);
  // A known name alongside an unknown one still gets its answer.
  assert.equal(
    xtgettcapReply(`${encodeTcap('Smulx')};${encodeTcap('TN')}`, 'xterm-kitty'),
    '\x1bP1+r544E=787465726D2D6B69747479\x1b\\',
  );
});

test('only the read-only geometry reports are opened in windowOptions', () => {
  // Everything CSI t can otherwise reach moves, resizes, raises or retitles the
  // window on the application's say-so. Nothing here can act on the page, and a
  // key arriving in this object that can is a regression whatever else passes.
  assert.deepEqual(Object.keys(GEOMETRY_WINDOW_OPTIONS).sort(), [
    'getCellSizePixels',
    'getWinSizeChars',
    'getWinSizePixels',
  ]);
  for (const value of Object.values(GEOMETRY_WINDOW_OPTIONS)) assert.equal(value, true);
});
