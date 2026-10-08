// Key specs and the default encoder for the touch key bar.

/** A modifier the bar can hold, because a touch screen cannot. */
export type MobileModifier = 'ctrl' | 'alt';

/** Modifier state handed to an encoder. */
export interface KeyMods {
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/**
 * One key the bar can send, or one control on it.
 *
 * `key` is a KeyboardEvent key name ('Escape', 'ArrowLeft', 'PageUp') or a
 * literal character. `code` is the KeyboardEvent code, unused by the default
 * encoder and passed through for hosts that encode from a keymap. `ctrl`,
 * `alt` and `shift` are modifiers the button carries itself, on top of
 * whatever the bar has armed.
 *
 * `mod` makes the button a sticky modifier instead. `prefix` makes it arm the
 * leader chord, and `prefixed` makes one tap send the leader and then this
 * key; both need the bar's `prefix` option.
 */
export interface MobileKey {
  label: string;
  title?: string;
  key?: string;
  code?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  narrow?: boolean;
  id?: string;
  mod?: MobileModifier;
  prefix?: boolean;
  prefixed?: boolean;
}

/** The leader chord a deployment is driven by: tmux's Ctrl+B, screen's Ctrl+A. */
export interface KeyChord {
  key: string;
  code?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** What an encoder is asked to encode. */
export interface EncodableKey {
  key?: string;
  code?: string;
  shift?: boolean;
}

// Keys that carry no input of their own, so pressing one must not consume
// an armed one-shot modifier.
export const BARE_MODIFIERS = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock',
  'AltGraph', 'Dead', 'Unidentified',
]);

/**
 * The keys a phone keyboard does not have, or hides two layers deep.
 *
 * Whatever is first here is what a narrow phone shows without scrolling, so
 * the order is the priority order. Everything in it is a key any terminal
 * program understands; nothing here assumes anything about what is running.
 */
// The code and shift fields are not read by encodeKeySpec, which works
// from key alone. They are here because a host may substitute an encoder
// of its own, and a keymap encoder derives the character from code plus
// the shift state rather than from the key name, so a table without them
// is unusable at exactly the extension point this module advertises.
export const DEFAULT_KEYS: readonly MobileKey[] = Object.freeze([
  { label: 'esc', title: 'Escape', key: 'Escape', code: 'Escape' },
  { label: 'tab', title: 'Tab', key: 'Tab', code: 'Tab' },
  { label: 'ctrl', title: 'Ctrl (tap to arm, tap again to lock)', mod: 'ctrl' },
  { label: 'alt', title: 'Alt (tap to arm, tap again to lock)', mod: 'alt' },
  { label: '←', title: 'Left', key: 'ArrowLeft', code: 'ArrowLeft', narrow: true },
  { label: '↓', title: 'Down', key: 'ArrowDown', code: 'ArrowDown', narrow: true },
  { label: '↑', title: 'Up', key: 'ArrowUp', code: 'ArrowUp', narrow: true },
  { label: '→', title: 'Right', key: 'ArrowRight', code: 'ArrowRight', narrow: true },
  { label: '/', title: 'Slash', key: '/', code: 'Slash', narrow: true },
  { label: '-', title: 'Minus', key: '-', code: 'Minus', narrow: true },
  { label: '|', title: 'Pipe', key: '|', code: 'Backslash', shift: true, narrow: true },
  { label: ':', title: 'Colon', key: ':', code: 'Semicolon', shift: true, narrow: true },
] satisfies MobileKey[]);

// The named keys the default bar can send, as their unmodified bytes and,
// where one exists, the CSI final byte a modified press uses instead.
// Anything not in here is treated as a literal character.
const NAMED_KEYS: Record<string, { bytes: string; csi?: string; param?: string }> = {
  Escape: { bytes: '\x1b' },
  Tab: { bytes: '\t' },
  Enter: { bytes: '\r' },
  Backspace: { bytes: '\x7f' },
  Delete: { bytes: '\x1b[3~', csi: '~', param: '3' },
  Insert: { bytes: '\x1b[2~', csi: '~', param: '2' },
  ArrowUp: { bytes: '\x1b[A', csi: 'A' },
  ArrowDown: { bytes: '\x1b[B', csi: 'B' },
  ArrowRight: { bytes: '\x1b[C', csi: 'C' },
  ArrowLeft: { bytes: '\x1b[D', csi: 'D' },
  Home: { bytes: '\x1b[H', csi: 'H' },
  End: { bytes: '\x1b[F', csi: 'F' },
  PageUp: { bytes: '\x1b[5~', csi: '~', param: '5' },
  PageDown: { bytes: '\x1b[6~', csi: '~', param: '6' },
};

/** xterm's modifier parameter: 1 plus a bitmask of shift, alt and ctrl. */
export function modifierParam(mods: KeyMods): number {
  return 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
}

/**
 * The control byte a character produces when Ctrl is held.
 *
 * The classic table: a letter is masked to its low five bits, and the seven
 * punctuation marks that sit next to the letters in ASCII produce the
 * remaining control codes. Anything else has no control form, so the
 * character is sent as itself rather than being swallowed.
 */
export function ctrlByte(ch: string): string {
  const c = ch.toUpperCase().charCodeAt(0);
  if (c >= 0x41 && c <= 0x5f) return String.fromCharCode(c & 0x1f);
  if (ch === ' ') return '\x00';
  if (ch === '?') return '\x7f';
  return ch;
}

/**
 * Encode one key spec as terminal input.
 *
 * This is the default host.encodeKey: enough for the default key set and
 * for anything else built out of named keys and literal characters. A host
 * with a key encoder of its own (a kitty keyboard protocol encoder, say)
 * passes that instead and this is never called.
 */
export function encodeKeySpec(spec: EncodableKey, mods?: KeyMods | null): string | null {
  const m = {
    ctrl: !!(mods && mods.ctrl),
    alt: !!(mods && mods.alt),
    shift: !!(mods && mods.shift) || !!spec.shift,
  };
  const named = spec.key !== undefined ? NAMED_KEYS[spec.key] : undefined;
  if (named) {
    const param = modifierParam(m);
    if (param > 1 && named.csi) {
      return `\x1b[${named.param || '1'};${param}${named.csi}`;
    }
    // Escape, Tab, Enter and Backspace have no CSI form. Alt still
    // prefixes them, which is what every terminal does with Meta.
    return (m.alt ? '\x1b' : '') + named.bytes;
  }
  if (typeof spec.key !== 'string' || spec.key.length === 0) return null;
  const ch = m.ctrl ? ctrlByte(spec.key) : spec.key;
  return (m.alt ? '\x1b' : '') + ch;
}

// A bare arrow or Home/End, as sent by a terminal that has not been told
// about a modifier. Rewritten in place when the bar has one armed.
export const BARE_CSI = /^\x1b(?:\[|O)([A-DHF])$/;
