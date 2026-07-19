/**
 * Turn a key event into the bytes the kitty keyboard protocol calls for.
 *
 * The encoder is a pure function of an event and a flag set. It holds no state
 * and knows no key names: everything key-specific comes from the tables in
 * `keys.ts`, and everything mode-specific comes from the flags. That is what
 * makes a new key a table row and a new protocol feature a single branch.
 *
 * The one structural decision worth knowing: when the flags do not call for a
 * CSI sequence, the encoder returns null and the caller lets xterm.js encode
 * the key exactly as it always has. Legacy encoding is a large, subtle surface
 * that xterm already gets right, and reimplementing it to hand back the same
 * bytes would be a pure liability. So with no flags set this whole module is
 * inert and key handling is bit-for-bit what it was before it existed.
 *
 * Free of DOM and xterm references so it can be exercised directly: the
 * `KeyInput` shape is a structural subset of `KeyboardEvent`, so a real browser
 * event satisfies it and so does a plain object in a test.
 */
import {
  KEYPAD_KEYS,
  KEYPAD_NAV_KEYS,
  MODIFIER_KEYS,
  NAMED_KEYS,
  US_LAYOUT,
  type KeySpec,
} from './keys.js';
import {
  KeyEventType,
  KeyboardFlags,
  encodeModifiers,
  type KeyEventTypeValue,
} from './protocol.js';

/** The subset of `KeyboardEvent` the encoder reads. */
export interface KeyInput {
  type: string;
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
  /** `DOM_KEY_LOCATION_NUMPAD` is 3, which is how the keypad is identified. */
  location?: number;
  getModifierState?(key: string): boolean;
}

/** A key resolved against the tables, before any flag-dependent decisions. */
export interface ResolvedKey {
  spec: KeySpec;
  /** The character shift produced, when it differs from the key itself. */
  shifted?: number;
  /** The character this physical key carries on a US layout. */
  base?: number;
  /** The text the key produced, when it produced any. */
  text?: string;
  isModifier: boolean;
  isKeypad: boolean;
}

const CSI = '\x1b[';

/**
 * Which keys a browser reports while an input method is mid-composition.
 *
 * These must never be encoded. The composition is not finished, so the key that
 * will eventually be produced is not known yet, and swallowing the event breaks
 * every non-Latin input method. Letting xterm handle them keeps its composition
 * helper in charge, which is where that logic belongs.
 */
const COMPOSITION_KEYS = new Set(['Dead', 'Process', 'Unidentified', 'Compose']);

/** The codepoint of a string that holds exactly one. */
function codepoint(text: string): number | undefined {
  const cp = text.codePointAt(0);
  if (cp === undefined) return undefined;
  return String.fromCodePoint(cp) === text ? cp : undefined;
}

/**
 * Resolve an event against the key tables.
 *
 * Returns null for anything that must not be encoded, which is composition
 * keys and events carrying no usable key at all.
 */
export function resolveKey(event: KeyInput): ResolvedKey | null {
  const { key, code } = event;
  if (!key || COMPOSITION_KEYS.has(key)) return null;

  // Modifier keys first: they are identified by code because left and right
  // are separate keys in the protocol and share one `key` name.
  const modifier = MODIFIER_KEYS[code];
  if (modifier) return { spec: modifier, isModifier: true, isKeypad: false };

  // The keypad next, and again by code, because with num lock off the browser
  // reports the navigation name and the key would otherwise be taken for the
  // main-row arrow of the same name.
  if (event.location === 3) {
    const numLockOn = event.getModifierState?.('NumLock') ?? true;
    const keypad = (numLockOn ? KEYPAD_KEYS[code] : KEYPAD_NAV_KEYS[code]) ?? KEYPAD_KEYS[code];
    if (keypad) {
      return {
        spec: keypad,
        isModifier: false,
        isKeypad: true,
        text: producesText(event) ? printableText(event) : undefined,
      };
    }
  }

  const named = NAMED_KEYS[key];
  if (named) return { spec: named, isModifier: false, isKeypad: false };

  // Anything left that is a single character is a text key, resolved from its
  // codepoint rather than a table so every script works without enumeration.
  const cp = codepoint(key);
  if (cp === undefined) return null;

  const baseChar = US_LAYOUT[code];
  const baseCp = baseChar ? codepoint(baseChar) : undefined;

  // The number field is the key with no modifiers applied. A browser does not
  // report that directly, so it is recovered: an uppercase letter under shift
  // lowercases, and any other shifted character falls back to what the physical
  // key carries unshifted. Without this, shift+a would report 65 rather than
  // reporting 97 with 65 as its shifted alternate, and an application matching
  // on the base key would never see a match.
  let number = cp;
  let shifted: number | undefined;
  const lowered = key.toLowerCase();
  const loweredCp = lowered === key ? undefined : codepoint(lowered);

  if (event.shiftKey) {
    if (loweredCp !== undefined) {
      number = loweredCp;
      shifted = cp;
    } else if (baseCp !== undefined && baseCp !== cp) {
      // A shifted punctuation key, where lowercasing does nothing: shift+1 is
      // '!' and only the physical key says the base is '1'.
      number = baseCp;
      shifted = cp;
    }
  } else if (loweredCp !== undefined && (event.getModifierState?.('CapsLock') ?? false)) {
    // Caps lock changes the character the key produces but not which key it is,
    // so the base key still lowercases. It is reported through the modifier
    // field instead, which is what lets an application tell a capital typed
    // with caps lock from one typed with shift. There is no shifted alternate
    // here: caps lock is a lock, not a shift.
    number = loweredCp;
  }

  return {
    spec: { number, final: 'u' },
    shifted,
    base: baseCp !== undefined && baseCp !== number ? baseCp : undefined,
    text: producesText(event) ? printableText(event) : undefined,
    isModifier: false,
    isKeypad: false,
  };
}

/**
 * Whether the key produced text.
 *
 * Ctrl and the command key produce a shortcut rather than a character, and alt
 * produces one only as a meta prefix, which is not associated text. Shift and
 * the lock keys do produce text, so they are not disqualifying.
 */
function producesText(event: KeyInput): boolean {
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  return codepoint(event.key) !== undefined;
}

function printableText(event: KeyInput): string | undefined {
  const cp = codepoint(event.key);
  // A control character is not text an application wants echoed back to it.
  return cp !== undefined && cp >= 0x20 && cp !== 0x7f ? event.key : undefined;
}

/** The event type, from the DOM event's own type and repeat flag. */
export function eventTypeOf(event: KeyInput): KeyEventTypeValue {
  if (event.type === 'keyup') return KeyEventType.RELEASE;
  return event.repeat ? KeyEventType.REPEAT : KeyEventType.PRESS;
}

/**
 * Whether this key must be reported as a CSI sequence under these flags.
 *
 * Returning false hands the key back to xterm's legacy encoding, so this is the
 * single decision that separates "the protocol owns this key" from "nothing has
 * changed". Each branch is one flag, so a new flag adds one branch.
 */
export function needsCsi(event: KeyInput, resolved: ResolvedKey, flags: number): boolean {
  // Every key as an escape code, including plain printable text.
  if (flags & KeyboardFlags.REPORT_ALL_KEYS) return true;

  // A modifier key on its own has no legacy encoding to fall back to, so it is
  // reported only when all keys are, which the branch above already covered.
  if (resolved.isModifier) return false;

  if (flags & KeyboardFlags.DISAMBIGUATE) {
    // Esc is indistinguishable from the introducer of any escape sequence, and
    // is the key the disambiguate flag exists for.
    if (resolved.spec.final === 'u' && resolved.spec.number === 27) return true;
    // Ctrl and alt collapse distinct keys onto the same bytes in the legacy
    // encoding: ctrl+i and Tab, ctrl+m and Enter, alt+a and Esc followed by a.
    if (event.ctrlKey || event.altKey || event.metaKey) return true;
    // The keypad is a distinct set of keys that legacy encoding merges with the
    // main row.
    if (resolved.isKeypad) return true;
  }

  return false;
}

/**
 * Encode a key event, or return null to leave it to xterm's legacy encoding.
 *
 * Null has two distinct causes that the caller must treat differently, and both
 * mean the same thing here: emit nothing of our own. A key that does not need a
 * CSI sequence is passed through to xterm. A release event on a key that is not
 * being reported as CSI is dropped entirely, because legacy encoding has no way
 * to say "released" and sending the press encoding again would type the key
 * twice.
 */
export function encodeKey(event: KeyInput, flags: number): string | null {
  const resolved = resolveKey(event);
  if (!resolved) return null;

  if (!needsCsi(event, resolved, flags)) return null;

  const type = eventTypeOf(event);
  const reportEvents = (flags & KeyboardFlags.REPORT_EVENT_TYPES) !== 0;
  // Without the event-types flag an application is expecting one sequence per
  // keypress, so a release would read as a second press of the same key.
  if (type !== KeyEventType.PRESS && !reportEvents) return null;

  const { spec } = resolved;

  // Field one: the key, and its alternates when asked for.
  const keyFields = [String(spec.number)];
  if (flags & KeyboardFlags.REPORT_ALTERNATE_KEYS) {
    const shifted = resolved.shifted;
    const base = resolved.base;
    // A sub-parameter can be left empty to skip it, which is how a base-layout
    // key is reported for a key that has no shifted form.
    if (shifted !== undefined || base !== undefined) {
      keyFields.push(shifted !== undefined ? String(shifted) : '');
      if (base !== undefined) keyFields.push(String(base));
    }
  }

  // Field two: the modifiers, and the event type when asked for.
  const modifiers = encodeModifiers({
    shift: event.shiftKey,
    alt: event.altKey,
    ctrl: event.ctrlKey,
    super: event.metaKey,
    capsLock: event.getModifierState?.('CapsLock') ?? false,
    numLock: event.getModifierState?.('NumLock') ?? false,
  });
  const modifierFields = [String(modifiers)];
  // Press is the default and is omitted, so a terminal reporting events and one
  // that is not produce identical bytes for a plain keypress.
  if (reportEvents && type !== KeyEventType.PRESS) modifierFields.push(String(type));

  // Field three: the text the key produced.
  let textField = '';
  if (
    flags & KeyboardFlags.REPORT_ASSOCIATED_TEXT &&
    resolved.text &&
    type !== KeyEventType.RELEASE
  ) {
    // A release produces no text: the character was already delivered on press,
    // and reporting it again would duplicate every character typed.
    textField = [...resolved.text].map((ch) => String(ch.codePointAt(0))).join(':');
  }

  return assemble(spec, keyFields, modifierFields, textField);
}

/**
 * Build the sequence, dropping trailing parameters that carry their defaults.
 *
 * Trailing defaults are dropped rather than written out because an application
 * comparing against a literal expects the shortest form, and kitty itself emits
 * the shortest form. A parameter can only be dropped if everything after it is
 * dropped too, which is what makes this a single pass from the back.
 */
function assemble(
  spec: KeySpec,
  keyFields: string[],
  modifierFields: string[],
  textField: string,
): string {
  const params: string[] = [keyFields.join(':')];
  const modifiersAreDefault = modifierFields.length === 1 && modifierFields[0] === '1';

  // The modifier field has to be written when the text field follows it, even
  // at its default, because parameters are positional.
  if (!modifiersAreDefault || textField) params.push(modifierFields.join(':'));
  if (textField) params.push(textField);

  const isLetterFinal = spec.final !== 'u' && spec.final !== '~';
  // A letter-final key with nothing to report is its bare legacy form: `CSI A`
  // for Up, not `CSI 1 A`. The number there is a placeholder that only exists
  // to give the modifiers somewhere to sit.
  if (isLetterFinal && params.length === 1 && params[0] === '1') return `${CSI}${spec.final}`;

  return `${CSI}${params.join(';')}${spec.final}`;
}
