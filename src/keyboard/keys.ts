/**
 * The key tables.
 *
 * Everything the protocol knows about a specific key lives here as data, so
 * teaching the encoder a new key is a table row and never a code change. The
 * encoder itself contains no key names at all.
 *
 * Free of DOM and xterm references so it can be exercised directly.
 */

/**
 * How a key is written into a CSI sequence.
 *
 * `final` is what decides the shape:
 *
 *   'u'  the CSI u form, `CSI <number> ; <mods> u`, where the number is the
 *        key's unicode codepoint or its protocol-assigned code above 57343.
 *   '~'  the legacy tilde form, `CSI <number> ; <mods> ~`, kept for the keys
 *        that have always used it so an application parsing legacy sequences
 *        keeps working.
 *   a letter, `CSI 1 ; <mods> <letter>`, for the cursor and editing keys whose
 *        legacy encoding is a letter final. The number is always 1 there and
 *        is omitted entirely when there is nothing else to report.
 */
export interface KeySpec {
  number: number;
  final: string;
}

/** A CSI u key whose number is its own protocol code. */
const u = (number: number): KeySpec => ({ number, final: 'u' });
/** A legacy key encoded `CSI <number> ; <mods> ~`. */
const tilde = (number: number): KeySpec => ({ number, final: '~' });
/** A legacy key encoded `CSI 1 ; <mods> <letter>`. */
const letter = (final: string): KeySpec => ({ number: 1, final });

/**
 * Keys identified by `KeyboardEvent.key`.
 *
 * The text keys are deliberately absent: a printable key is resolved from its
 * codepoint, not from a table, so every character in every script works without
 * being enumerated here.
 */
export const NAMED_KEYS: Readonly<Record<string, KeySpec>> = {
  // The four keys whose legacy encodings are single control characters that
  // collide with other meanings. Disambiguating these is the whole point of
  // flag 1: Esc is indistinguishable from the start of any escape sequence,
  // Tab from ctrl+i, Enter from ctrl+m and Backspace from ctrl+h.
  Escape: u(27),
  Enter: u(13),
  Tab: u(9),
  Backspace: u(127),

  Insert: tilde(2),
  Delete: tilde(3),
  PageUp: tilde(5),
  PageDown: tilde(6),

  ArrowUp: letter('A'),
  ArrowDown: letter('B'),
  ArrowRight: letter('C'),
  ArrowLeft: letter('D'),
  Home: letter('H'),
  End: letter('F'),

  // Lock and system keys. A browser only ever delivers these when the page has
  // focus and the OS did not swallow them first, which for PrintScreen and
  // Pause is rarely.
  CapsLock: u(57358),
  ScrollLock: u(57359),
  NumLock: u(57360),
  PrintScreen: u(57361),
  Pause: u(57362),
  ContextMenu: u(57363),

  // F1 through F4 keep their letter finals. F3 is the exception: `CSI R` is
  // already the cursor position report, so the legacy encoding of F3 is the
  // tilde form and the protocol keeps it that way.
  F1: letter('P'),
  F2: letter('Q'),
  F3: tilde(13),
  F4: letter('S'),
  F5: tilde(15),
  F6: tilde(17),
  F7: tilde(18),
  F8: tilde(19),
  F9: tilde(20),
  F10: tilde(21),
  F11: tilde(23),
  F12: tilde(24),

  // F13 upward have no legacy encoding at all, so they are pure CSI u, numbered
  // consecutively from 57376.
  ...functionKeys(),

  // Media keys. A browser delivers these only when the OS routes them to the
  // page rather than to the system media session, so they are opportunistic.
  MediaPlay: u(57428),
  MediaPause: u(57429),
  MediaPlayPause: u(57430),
  MediaTrackPrevious: u(57436),
  MediaTrackNext: u(57435),
  MediaStop: u(57432),
  AudioVolumeDown: u(57438),
  AudioVolumeUp: u(57439),
  AudioVolumeMute: u(57440),
};

/** F13 through F35, which are numbered consecutively with no legacy forms. */
function functionKeys(): Record<string, KeySpec> {
  const out: Record<string, KeySpec> = {};
  for (let n = 13; n <= 35; n++) out[`F${n}`] = u(57376 + (n - 13));
  return out;
}

/**
 * Modifier keys, identified by `KeyboardEvent.code` because left and right are
 * separate keys in the protocol and `KeyboardEvent.key` reports both as the
 * same name.
 *
 * A browser reports the Command key on macOS and the Windows key on Windows
 * both as `Meta`, and the protocol's super is the closest match to what those
 * keys actually mean to an application, so both map to the super codes.
 */
export const MODIFIER_KEYS: Readonly<Record<string, KeySpec>> = {
  ShiftLeft: u(57441),
  ControlLeft: u(57442),
  AltLeft: u(57443),
  MetaLeft: u(57444),
  ShiftRight: u(57447),
  ControlRight: u(57448),
  AltRight: u(57449),
  MetaRight: u(57450),
};

/**
 * Keypad keys with num lock on, identified by `KeyboardEvent.code`.
 *
 * The keypad is a separate set of keys in the protocol even though it produces
 * the same characters as the main row. An application that wants to bind the
 * keypad plus separately from the main-row plus has no way to do it otherwise,
 * which is why flag 1 reports the keypad as CSI u even with no modifiers held.
 */
export const KEYPAD_KEYS: Readonly<Record<string, KeySpec>> = {
  Numpad0: u(57399),
  Numpad1: u(57400),
  Numpad2: u(57401),
  Numpad3: u(57402),
  Numpad4: u(57403),
  Numpad5: u(57404),
  Numpad6: u(57405),
  Numpad7: u(57406),
  Numpad8: u(57407),
  Numpad9: u(57408),
  NumpadDecimal: u(57409),
  NumpadDivide: u(57410),
  NumpadMultiply: u(57411),
  NumpadSubtract: u(57412),
  NumpadAdd: u(57413),
  NumpadEnter: u(57414),
  NumpadEqual: u(57415),
  NumpadComma: u(57416),
};

/**
 * Keypad keys with num lock off, identified by `KeyboardEvent.code`.
 *
 * With num lock off the browser reports the navigation meaning in
 * `KeyboardEvent.key`, so Numpad4 arrives as ArrowLeft and would otherwise be
 * indistinguishable from the main-row arrow. The protocol has distinct codes
 * for exactly this, so the code is what resolves them.
 */
export const KEYPAD_NAV_KEYS: Readonly<Record<string, KeySpec>> = {
  Numpad4: u(57417),
  Numpad6: u(57418),
  Numpad8: u(57419),
  Numpad2: u(57420),
  Numpad9: u(57421),
  Numpad3: u(57422),
  Numpad7: u(57423),
  Numpad1: u(57424),
  Numpad0: u(57425),
  NumpadDecimal: u(57426),
  Numpad5: u(57427),
};

/**
 * The character a physical key produces on a US layout, unshifted.
 *
 * This backs the base-layout field of the alternate-keys report, which exists
 * so an application can bind a physical key position regardless of the layout
 * the user has active. A user on a Dvorak layout pressing the key labelled Q on
 * a US keyboard sends a base-layout code of `q` whatever their layout maps it
 * to, so a shortcut bound to a position keeps working.
 *
 * `KeyboardEvent.code` names the physical key, which is what makes this a plain
 * lookup rather than a guess.
 */
export const US_LAYOUT: Readonly<Record<string, string>> = {
  ...letterRow(),
  ...digitRow(),
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: ' ',
};

function letterRow(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < 26; i++) out[`Key${String.fromCharCode(65 + i)}`] = String.fromCharCode(97 + i);
  return out;
}

function digitRow(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i <= 9; i++) out[`Digit${i}`] = String(i);
  return out;
}
