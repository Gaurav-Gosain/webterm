/**
 * The browser's paste chords, kept away from the program.
 *
 * The paste is the browser's default action for the key. A chord that is
 * claimed from xterm but keeps its default makes the browser fire a paste
 * event on xterm's textarea, which reads clipboardData. That needs no clipboard
 * permission and no secure context, and it only ever happens on a key the user
 * pressed.
 */

/** What plain Ctrl+V does: paste, or reach the program as a key. */
export type CtrlVMode = 'paste' | 'program';

type ChordEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>;

/** True on macOS and iOS, where the command key carries the paste chord. */
export function isApplePlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? '');
}

/**
 * Whether a key is one of the paste chords.
 *
 * On Apple platforms: Cmd+V and Shift+Insert. Ctrl+V there is no paste in any
 * browser, so it stays the program's key.
 *
 * Elsewhere: Ctrl+Shift+V, Shift+Insert, and Ctrl+V unless `ctrlV` is
 * 'program'. Ctrl+V pastes by default, as it does in the terminals of VS Code
 * and Windows Terminal, because in a browser tab the program's own clipboard
 * key reads the clipboard of the server, not the user's. 'program' gives the
 * key back, for vim's block select (which Ctrl+Q also starts) and a shell's
 * literal-next.
 */
export function isPasteChord(
  event: ChordEvent,
  ctrlV: CtrlVMode = 'paste',
  apple: boolean = isApplePlatform(),
): boolean {
  if (event.altKey) return false;
  if (event.code === 'Insert') return event.shiftKey && !event.ctrlKey && !event.metaKey;
  // The letter decides on a Latin layout, as it does for the browser's own
  // shortcut. A layout with no Latin letters falls back to the physical key.
  const key = (event.key ?? '').toLowerCase();
  const isV = key === 'v' || (!/^[a-z]$/.test(key) && event.code === 'KeyV');
  if (!isV) return false;
  if (apple) return event.metaKey && !event.ctrlKey && !event.shiftKey;
  if (!event.ctrlKey || event.metaKey) return false;
  return event.shiftKey || ctrlV === 'paste';
}

/**
 * Claims the paste chords from xterm and from the keyboard protocol.
 *
 * `handle` returns false for a key it claimed, which stops xterm and the
 * protocol both, and undefined for a key it leaves alone. It never prevents
 * the default, which is the paste.
 */
export class PasteChords {
  /**
   * The code of a paste chord's key while it is held, so its release is
   * swallowed too. Under the event-types flag the release would otherwise
   * reach the program as a key it never saw go down.
   */
  private heldCode: string | null = null;

  private readonly ctrlV: () => CtrlVMode;

  constructor(ctrlV: () => CtrlVMode = () => 'paste') {
    this.ctrlV = ctrlV;
  }

  handle(event: KeyboardEvent): false | undefined {
    if (event.type === 'keydown') {
      if (event.code === this.heldCode) this.heldCode = null;
      if (!isPasteChord(event, this.ctrlV())) return undefined;
      this.heldCode = event.code;
      return false;
    }
    // A keypress for the chord, which some engines send for Ctrl+V, would
    // reach xterm's keypress path as the control character.
    if (event.code === this.heldCode) {
      if (event.type === 'keyup') this.heldCode = null;
      return false;
    }
    return undefined;
  }

  reset(): void {
    this.heldCode = null;
  }
}
