/**
 * The kitty keyboard protocol's state: the progressive enhancement flags, the
 * modifier and event-type encodings, and the mode stack the application pushes
 * and pops.
 *
 * Free of DOM and xterm references so it can be exercised directly.
 *
 * Reference: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
 */

/**
 * Progressive enhancement flags.
 *
 * An application turns on only the behaviour it can handle, so a terminal that
 * supports more than the application asked for still speaks the subset the
 * application understands. Every flag is independent, which is why the encoder
 * branches on each one separately rather than on a level number.
 */
export const KeyboardFlags = {
  /** Nothing enabled: legacy encoding throughout. */
  NONE: 0,
  /**
   * Report Esc, ctrl+key, alt+key and the keypad as CSI u sequences instead of
   * their legacy forms, which collide with each other and with real escape
   * sequences.
   */
  DISAMBIGUATE: 1,
  /** Report key repeat and key release, not only key press. */
  REPORT_EVENT_TYPES: 2,
  /** Report the shifted key and the base-layout key alongside the key itself. */
  REPORT_ALTERNATE_KEYS: 4,
  /** Report every key as an escape code, including plain printable text. */
  REPORT_ALL_KEYS: 8,
  /** Append the text the key produced, as codepoints. */
  REPORT_ASSOCIATED_TEXT: 16,
} as const;

/** Every bit the implementation understands. Anything else is ignored. */
export const ALL_KEYBOARD_FLAGS =
  KeyboardFlags.DISAMBIGUATE |
  KeyboardFlags.REPORT_EVENT_TYPES |
  KeyboardFlags.REPORT_ALTERNATE_KEYS |
  KeyboardFlags.REPORT_ALL_KEYS |
  KeyboardFlags.REPORT_ASSOCIATED_TEXT;

/** The event type field of a CSI u sequence. */
export const KeyEventType = {
  PRESS: 1,
  REPEAT: 2,
  RELEASE: 3,
} as const;

export type KeyEventTypeValue = (typeof KeyEventType)[keyof typeof KeyEventType];

/**
 * Modifier bits.
 *
 * These are summed and reported as `1 + sum`, so the unmodified value is 1 and
 * a zero modifier field never appears. A browser cannot distinguish hyper from
 * super, and reports the Windows and Command keys both as `metaKey`, so `SUPER`
 * is what a browser can actually observe and `HYPER` and `META` are here for
 * completeness of the encoding rather than because a KeyboardEvent produces
 * them.
 */
export const KeyModifiers = {
  SHIFT: 1,
  ALT: 2,
  CTRL: 4,
  SUPER: 8,
  HYPER: 16,
  META: 32,
  CAPS_LOCK: 64,
  NUM_LOCK: 128,
} as const;

/**
 * The mode-setting operations of `CSI = flags ; mode u`.
 *
 * Kept as named constants because the wire values are indistinguishable from
 * each other at a call site otherwise.
 */
export const KeyboardSetMode = {
  /** Replace every flag with the given set. The default when `mode` is absent. */
  ALL: 1,
  /** Turn on the given flags, leaving the rest alone. */
  SET: 2,
  /** Turn off the given flags, leaving the rest alone. */
  RESET: 3,
} as const;

/**
 * How deep the push stack goes before the oldest entry is dropped.
 *
 * A bounded stack matters because a program that pushes without popping, or
 * that is killed between the two, must not be able to grow terminal memory
 * without limit. Dropping from the bottom rather than refusing the push keeps
 * the most recent state correct, which is the state the running application is
 * relying on.
 */
export const KEYBOARD_STACK_LIMIT = 16;

/**
 * The push/pop stack of enhancement flags for one screen.
 *
 * The stack exists so a program can enable what it needs on entry and restore
 * exactly what it found on exit without having to know what that was. A shell
 * that spawns a full-screen editor and gets it back in a different keyboard
 * mode than it left is the failure this prevents.
 */
export class KeyboardModeStack {
  private readonly entries: number[] = [];
  private flags: number = KeyboardFlags.NONE;
  private readonly limit: number;

  constructor(limit: number = KEYBOARD_STACK_LIMIT) {
    this.limit = limit;
  }

  /** The flags in effect now. */
  get current(): number {
    return this.flags;
  }

  /** How many entries are pushed. Exposed for tests and for introspection. */
  get depth(): number {
    return this.entries.length;
  }

  /** `CSI > flags u`: save the current flags and adopt the given ones. */
  push(flags: number): void {
    this.entries.push(this.flags);
    // Drop from the bottom, so the entries nearest the top, the ones a running
    // program is most likely to pop back to, are the ones that survive.
    while (this.entries.length > this.limit) this.entries.shift();
    this.flags = flags & ALL_KEYBOARD_FLAGS;
  }

  /**
   * `CSI < number u`: restore the flags from `count` entries back.
   *
   * Popping an empty stack resets to no enhancements rather than being ignored.
   * A program that pops more than it pushed is confused about its own state,
   * and leaving it in an enhanced mode it does not believe it is in produces
   * keystrokes it cannot parse; plain legacy encoding is the state every
   * application can handle.
   */
  pop(count = 1): void {
    for (let i = 0; i < Math.max(1, count); i++) {
      const previous = this.entries.pop();
      if (previous === undefined) {
        this.flags = KeyboardFlags.NONE;
        return;
      }
      this.flags = previous;
    }
  }

  /** `CSI = flags ; mode u`: change the current flags without touching the stack. */
  set(flags: number, mode: number = KeyboardSetMode.ALL): void {
    const masked = flags & ALL_KEYBOARD_FLAGS;
    switch (mode) {
      case KeyboardSetMode.SET:
        this.flags |= masked;
        break;
      case KeyboardSetMode.RESET:
        this.flags &= ~masked;
        break;
      default:
        this.flags = masked;
        break;
    }
  }

  /** Return to the power-on state, as a terminal reset requires. */
  reset(): void {
    this.entries.length = 0;
    this.flags = KeyboardFlags.NONE;
  }
}

/**
 * Encode the modifier field.
 *
 * Returns `1 + sum of bits`, so no modifiers is 1. Caps lock and num lock are
 * included because the protocol carries them, and an application that wants to
 * distinguish a capital typed with shift from one typed with caps lock has no
 * other way to tell.
 */
export function encodeModifiers(state: {
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  super?: boolean;
  hyper?: boolean;
  meta?: boolean;
  capsLock?: boolean;
  numLock?: boolean;
}): number {
  let bits = 0;
  if (state.shift) bits |= KeyModifiers.SHIFT;
  if (state.alt) bits |= KeyModifiers.ALT;
  if (state.ctrl) bits |= KeyModifiers.CTRL;
  if (state.super) bits |= KeyModifiers.SUPER;
  if (state.hyper) bits |= KeyModifiers.HYPER;
  if (state.meta) bits |= KeyModifiers.META;
  if (state.capsLock) bits |= KeyModifiers.CAPS_LOCK;
  if (state.numLock) bits |= KeyModifiers.NUM_LOCK;
  return bits + 1;
}
