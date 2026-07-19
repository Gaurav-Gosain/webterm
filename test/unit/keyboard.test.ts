/**
 * The expected byte sequences here are the ones kitty itself emits, not
 * whatever this implementation happens to produce. Every assertion is a literal
 * so a regression shows up as a diff of bytes rather than of behaviour.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

// The pure modules are imported directly rather than through the barrel: the
// barrel also exports the installer, which pulls in xterm and a DOM that does
// not exist here. Encoding and mode state are deliberately free of both.
import { encodeKey, resolveKey, type KeyInput } from '../../src/keyboard/encoder.ts';
import {
  KeyboardFlags,
  KeyboardModeStack,
  KeyboardSetMode,
  encodeModifiers,
} from '../../src/keyboard/protocol.ts';

const { DISAMBIGUATE, REPORT_EVENT_TYPES, REPORT_ALTERNATE_KEYS, REPORT_ALL_KEYS, REPORT_ASSOCIATED_TEXT } =
  KeyboardFlags;

/** A keydown, with the fields a browser would have filled in. */
function key(init: Partial<KeyInput> & { key: string }): KeyInput {
  return {
    type: 'keydown',
    code: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    location: 0,
    getModifierState: () => false,
    ...init,
  };
}

// --- Legacy passthrough ------------------------------------------------------

test('no flags means the encoder claims nothing at all', () => {
  const events = [
    key({ key: 'a', code: 'KeyA' }),
    key({ key: 'a', code: 'KeyA', ctrlKey: true }),
    key({ key: 'Escape', code: 'Escape' }),
    key({ key: 'ArrowUp', code: 'ArrowUp' }),
    key({ key: 'F1', code: 'F1' }),
  ];
  for (const event of events) {
    assert.equal(encodeKey(event, KeyboardFlags.NONE), null, `${event.key} should pass through`);
  }
});

test('disambiguate leaves plain text and unmodified cursor keys to xterm', () => {
  assert.equal(encodeKey(key({ key: 'a', code: 'KeyA' }), DISAMBIGUATE), null);
  assert.equal(encodeKey(key({ key: 'A', code: 'KeyA', shiftKey: true }), DISAMBIGUATE), null);
  assert.equal(encodeKey(key({ key: 'ArrowUp', code: 'ArrowUp' }), DISAMBIGUATE), null);
  assert.equal(encodeKey(key({ key: 'Enter', code: 'Enter' }), DISAMBIGUATE), null);
});

// --- Disambiguate ------------------------------------------------------------

test('disambiguate reports escape as CSI 27 u', () => {
  assert.equal(encodeKey(key({ key: 'Escape', code: 'Escape' }), DISAMBIGUATE), '\x1b[27u');
});

test('disambiguate reports ctrl and alt combinations as CSI u', () => {
  // ctrl+a would be 0x01 in legacy encoding, indistinguishable from ctrl+A and
  // from a literal SOH byte.
  assert.equal(encodeKey(key({ key: 'a', code: 'KeyA', ctrlKey: true }), DISAMBIGUATE), '\x1b[97;5u');
  assert.equal(encodeKey(key({ key: 'a', code: 'KeyA', altKey: true }), DISAMBIGUATE), '\x1b[97;3u');
  assert.equal(
    encodeKey(key({ key: 'a', code: 'KeyA', ctrlKey: true, altKey: true }), DISAMBIGUATE),
    '\x1b[97;7u',
  );
});

test('ctrl+i and Tab stay distinct under disambiguate', () => {
  const ctrlI = encodeKey(key({ key: 'i', code: 'KeyI', ctrlKey: true }), DISAMBIGUATE);
  const tab = encodeKey(key({ key: 'Tab', code: 'Tab', ctrlKey: true }), DISAMBIGUATE);
  assert.equal(ctrlI, '\x1b[105;5u');
  assert.equal(tab, '\x1b[9;5u');
  assert.notEqual(ctrlI, tab);
});

test('a modified cursor key keeps its letter final', () => {
  assert.equal(encodeKey(key({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true }), DISAMBIGUATE), '\x1b[1;5A');
  assert.equal(encodeKey(key({ key: 'End', code: 'End', altKey: true }), DISAMBIGUATE), '\x1b[1;3F');
});

test('the keypad is distinguished from the main row', () => {
  const keypadFive = key({ key: '5', code: 'Numpad5', location: 3, getModifierState: (m) => m === 'NumLock' });
  assert.equal(encodeKey(keypadFive, DISAMBIGUATE), '\x1b[57404;129u');

  // With num lock off the browser reports the navigation name, and the code is
  // what keeps it apart from the main-row Home.
  const keypadHome = key({ key: 'Home', code: 'Numpad7', location: 3 });
  assert.equal(encodeKey(keypadHome, DISAMBIGUATE), '\x1b[57423u');
});

// --- Report all keys ---------------------------------------------------------

test('report-all-keys encodes plain printable text', () => {
  assert.equal(encodeKey(key({ key: 'a', code: 'KeyA' }), REPORT_ALL_KEYS), '\x1b[97u');
  assert.equal(encodeKey(key({ key: ' ', code: 'Space' }), REPORT_ALL_KEYS), '\x1b[32u');
});

test('report-all-keys reports shift as a modifier on the base key', () => {
  assert.equal(
    encodeKey(key({ key: 'A', code: 'KeyA', shiftKey: true }), REPORT_ALL_KEYS),
    '\x1b[97;2u',
  );
});

test('an unmodified letter-final key stays in its bare legacy form', () => {
  // `CSI A`, not `CSI 1 A`: the number only exists to give modifiers a place to
  // sit, so it is dropped when there are none.
  assert.equal(encodeKey(key({ key: 'ArrowUp', code: 'ArrowUp' }), REPORT_ALL_KEYS), '\x1b[A');
  assert.equal(encodeKey(key({ key: 'F1', code: 'F1' }), REPORT_ALL_KEYS), '\x1b[P');
});

test('tilde-final keys keep their number', () => {
  assert.equal(encodeKey(key({ key: 'Delete', code: 'Delete' }), REPORT_ALL_KEYS), '\x1b[3~');
  assert.equal(encodeKey(key({ key: 'F5', code: 'F5' }), REPORT_ALL_KEYS), '\x1b[15~');
  // F3 is the tilde form because `CSI R` is already the cursor position report.
  assert.equal(encodeKey(key({ key: 'F3', code: 'F3' }), REPORT_ALL_KEYS), '\x1b[13~');
});

test('modifier keys are reported only when all keys are', () => {
  const shift = key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true, location: 1 });
  assert.equal(encodeKey(shift, DISAMBIGUATE), null);
  assert.equal(encodeKey(shift, REPORT_ALL_KEYS), '\x1b[57441;2u');
});

// --- Alternate keys ----------------------------------------------------------

test('alternate keys report the shifted character', () => {
  assert.equal(
    encodeKey(key({ key: 'A', code: 'KeyA', shiftKey: true }), REPORT_ALL_KEYS | REPORT_ALTERNATE_KEYS),
    '\x1b[97:65;2u',
  );
  // shift+1 on a US layout is '!', whose base key is '1'.
  assert.equal(
    encodeKey(key({ key: '!', code: 'Digit1', shiftKey: true }), REPORT_ALL_KEYS | REPORT_ALTERNATE_KEYS),
    '\x1b[49:33;2u',
  );
});

test('alternate keys report the base layout key for a non-US layout', () => {
  // A Dvorak user pressing the physical key labelled Q on a US keyboard gets
  // "'" from their layout, and the base-layout field carries the position so a
  // binding on the physical key still resolves.
  assert.equal(
    encodeKey(key({ key: "'", code: 'KeyQ' }), REPORT_ALL_KEYS | REPORT_ALTERNATE_KEYS),
    '\x1b[39::113u',
  );
});

test('alternate keys are absent when there is no alternate', () => {
  assert.equal(
    encodeKey(key({ key: 'a', code: 'KeyA' }), REPORT_ALL_KEYS | REPORT_ALTERNATE_KEYS),
    '\x1b[97u',
  );
});

// --- Event types -------------------------------------------------------------

test('a release is dropped unless event types are reported', () => {
  const release = key({ key: 'a', code: 'KeyA', type: 'keyup' });
  assert.equal(encodeKey(release, REPORT_ALL_KEYS), null);
  assert.equal(encodeKey(release, REPORT_ALL_KEYS | REPORT_EVENT_TYPES), '\x1b[97;1:3u');
});

test('a repeat is reported as event type 2', () => {
  const repeat = key({ key: 'a', code: 'KeyA', repeat: true });
  assert.equal(encodeKey(repeat, REPORT_ALL_KEYS | REPORT_EVENT_TYPES), '\x1b[97;1:2u');
});

test('a press carries no event type, so enabling the flag does not change it', () => {
  const press = key({ key: 'a', code: 'KeyA' });
  assert.equal(encodeKey(press, REPORT_ALL_KEYS), '\x1b[97u');
  assert.equal(encodeKey(press, REPORT_ALL_KEYS | REPORT_EVENT_TYPES), '\x1b[97u');
});

test('a release carries its modifiers', () => {
  const release = key({ key: 'a', code: 'KeyA', type: 'keyup', ctrlKey: true });
  assert.equal(encodeKey(release, REPORT_ALL_KEYS | REPORT_EVENT_TYPES), '\x1b[97;5:3u');
});

// --- Associated text ---------------------------------------------------------

test('associated text is appended as codepoints', () => {
  assert.equal(
    encodeKey(key({ key: 'a', code: 'KeyA' }), REPORT_ALL_KEYS | REPORT_ASSOCIATED_TEXT),
    '\x1b[97;1;97u',
  );
  assert.equal(
    encodeKey(key({ key: 'A', code: 'KeyA', shiftKey: true }), REPORT_ALL_KEYS | REPORT_ASSOCIATED_TEXT),
    '\x1b[97;2;65u',
  );
});

test('a shortcut carries no associated text', () => {
  assert.equal(
    encodeKey(key({ key: 'a', code: 'KeyA', ctrlKey: true }), REPORT_ALL_KEYS | REPORT_ASSOCIATED_TEXT),
    '\x1b[97;5u',
  );
});

test('a release carries no associated text', () => {
  assert.equal(
    encodeKey(
      key({ key: 'a', code: 'KeyA', type: 'keyup' }),
      REPORT_ALL_KEYS | REPORT_EVENT_TYPES | REPORT_ASSOCIATED_TEXT,
    ),
    '\x1b[97;1:3u',
  );
});

// --- Modifiers ---------------------------------------------------------------

test('modifiers encode as one plus the sum of their bits', () => {
  assert.equal(encodeModifiers({}), 1);
  assert.equal(encodeModifiers({ shift: true }), 2);
  assert.equal(encodeModifiers({ alt: true }), 3);
  assert.equal(encodeModifiers({ ctrl: true }), 5);
  assert.equal(encodeModifiers({ super: true }), 9);
  assert.equal(encodeModifiers({ shift: true, alt: true, ctrl: true }), 8);
  assert.equal(encodeModifiers({ capsLock: true }), 65);
  assert.equal(encodeModifiers({ numLock: true }), 129);
});

test('caps lock is distinguishable from shift', () => {
  const withCaps = key({ key: 'A', code: 'KeyA', getModifierState: (m) => m === 'CapsLock' });
  const withShift = key({ key: 'A', code: 'KeyA', shiftKey: true });
  assert.equal(encodeKey(withCaps, REPORT_ALL_KEYS), '\x1b[97;65u');
  assert.equal(encodeKey(withShift, REPORT_ALL_KEYS), '\x1b[97;2u');
});

// --- Composition -------------------------------------------------------------

test('composition keys are never claimed', () => {
  for (const name of ['Dead', 'Process', 'Unidentified', 'Compose']) {
    assert.equal(resolveKey(key({ key: name, code: 'KeyA' })), null);
    assert.equal(encodeKey(key({ key: name, code: 'KeyA' }), REPORT_ALL_KEYS), null);
  }
});

// --- The mode stack ----------------------------------------------------------

test('push and pop restore the previous flags exactly', () => {
  const stack = new KeyboardModeStack();
  assert.equal(stack.current, 0);

  stack.push(DISAMBIGUATE);
  assert.equal(stack.current, 1);

  stack.push(REPORT_ALL_KEYS | REPORT_EVENT_TYPES);
  assert.equal(stack.current, 10);

  stack.pop();
  assert.equal(stack.current, 1);

  stack.pop();
  assert.equal(stack.current, 0);
});

test('popping more than was pushed lands on no enhancements', () => {
  const stack = new KeyboardModeStack();
  stack.push(DISAMBIGUATE);
  stack.pop(5);
  assert.equal(stack.current, 0);
  assert.equal(stack.depth, 0);
});

test('pop takes a count', () => {
  const stack = new KeyboardModeStack();
  stack.push(1);
  stack.push(2);
  stack.push(4);
  stack.push(8);
  assert.equal(stack.current, 8);
  stack.pop(3);
  assert.equal(stack.current, 1);
});

test('the stack is bounded and drops from the bottom', () => {
  const stack = new KeyboardModeStack(4);
  for (let i = 0; i < 10; i++) stack.push(i & 15);
  assert.equal(stack.depth, 4);
});

test('set replaces, adds and removes flags', () => {
  const stack = new KeyboardModeStack();
  stack.set(DISAMBIGUATE | REPORT_ALL_KEYS, KeyboardSetMode.ALL);
  assert.equal(stack.current, 9);

  stack.set(REPORT_EVENT_TYPES, KeyboardSetMode.SET);
  assert.equal(stack.current, 11);

  stack.set(DISAMBIGUATE, KeyboardSetMode.RESET);
  assert.equal(stack.current, 10);

  stack.set(REPORT_ALTERNATE_KEYS, KeyboardSetMode.ALL);
  assert.equal(stack.current, 4);
});

test('set does not disturb the stack', () => {
  const stack = new KeyboardModeStack();
  stack.push(DISAMBIGUATE);
  stack.set(REPORT_ALL_KEYS);
  assert.equal(stack.current, 8);
  stack.pop();
  assert.equal(stack.current, 0);
});

test('unknown flag bits are masked off', () => {
  const stack = new KeyboardModeStack();
  stack.push(0xffff);
  assert.equal(stack.current, 31);
});
