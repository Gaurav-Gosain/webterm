/**
 * The kitty keyboard protocol, attached to an xterm.js Terminal.
 *
 * This module owns the wiring and nothing else: the flag state lives in
 * `protocol.ts`, the key tables in `keys.ts` and the encoding in `encoder.ts`,
 * all three of which are pure and independently testable. What is left here is
 * the four control sequences that drive the mode, and the key handler that
 * consults it.
 *
 * It touches no xterm internals. `parser.registerCsiHandler`,
 * `attachCustomKeyEventHandler`, `buffer.onBufferChange` and `input` are all
 * public, documented API, so unlike the graphics side there is no private
 * dependency here to isolate or to break.
 */
import type { Terminal } from '@xterm/xterm';
import { encodeKey, type KeyInput } from './encoder.js';
import {
  ALL_KEYBOARD_FLAGS,
  KeyboardFlags,
  KeyboardModeStack,
  KeyboardSetMode,
} from './protocol.js';

export interface KittyKeyboardOptions {
  /**
   * Send bytes to the application. Defaults to `term.input`, which is the same
   * path a typed character takes, so a consumer's `onData` listener sees
   * protocol sequences and keystrokes identically.
   */
  send?(data: string): void;
  /**
   * Gate every outbound sequence. Returning false makes the handler inert and
   * hands the key back to xterm untouched, which is what a read-only terminal
   * needs: no bytes, and no swallowed browser shortcuts either.
   */
  enabled?(): boolean;
  /**
   * A key handler to consult before the protocol does. Returning false from it
   * stops the key reaching both the protocol and xterm.
   *
   * This exists because `attachCustomKeyEventHandler` is a single slot on the
   * Terminal rather than a list. Installing the protocol would otherwise
   * silently overwrite a consumer's own handler, so the slot is taken once here
   * and a consumer's handler is chained through this option.
   */
  onKeyEvent?(event: KeyboardEvent): boolean;
}

/**
 * The parameters xterm hands a CSI handler.
 *
 * A parameter is a number, or an array of numbers when the sequence used
 * colon-separated sub-parameters.
 */
type CsiParams = readonly (number | number[])[];

/** The first value of a CSI parameter, sub-parameters and absence flattened. */
function param(params: CsiParams, index: number, fallback: number): number {
  const value = params[index];
  const scalar = Array.isArray(value) ? value[0] : value;
  // xterm reports an omitted parameter as 0, which for every parameter this
  // protocol uses means "not given" rather than a literal zero.
  return scalar === undefined || scalar === 0 ? fallback : scalar;
}

export class KittyKeyboard {
  /**
   * One stack per screen.
   *
   * The main and alternate screens keep independent keyboard state, so a
   * full-screen application that enables the protocol and is then suspended
   * does not leave the shell it returns to in a mode the shell never asked for.
   * This mirrors how the two screens keep independent cursors and scrollback.
   */
  private readonly stacks = {
    normal: new KeyboardModeStack(),
    alternate: new KeyboardModeStack(),
  };

  private readonly term: Terminal;
  private readonly options: KittyKeyboardOptions;
  private readonly teardown: Array<() => void> = [];
  private disposed = false;
  /**
   * Set when a keydown was encoded, so the keypress that follows it can be
   * suppressed.
   *
   * xterm runs its keypress path whenever its own keydown path did not claim
   * the event, and a custom handler returning false does not count as claiming
   * it. Without this the character would be delivered twice: once as the CSI
   * sequence and once as plain text.
   */
  private suppressKeypress = false;

  constructor(term: Terminal, options: KittyKeyboardOptions = {}) {
    this.term = term;
    this.options = options;
    this.install();
  }

  /** The flags in effect on the active screen. */
  get flags(): number {
    return this.stack.current;
  }

  /** True when any enhancement is on, so the protocol is shaping key output. */
  get active(): boolean {
    return this.stack.current !== KeyboardFlags.NONE;
  }

  private get stack(): KeyboardModeStack {
    return this.term.buffer.active.type === 'alternate'
      ? this.stacks.alternate
      : this.stacks.normal;
  }

  private install(): void {
    // `CSI ? u` asks what is enabled. The reply is how an application detects
    // support at all: a terminal that does not implement the protocol answers
    // nothing, and the application falls back to legacy encoding.
    this.csi('?', (params) => {
      this.send(`\x1b[?${this.stack.current}u`);
      void params;
      return true;
    });

    // `CSI > flags u` pushes.
    this.csi('>', (params) => {
      this.stack.push(param(params, 0, KeyboardFlags.NONE) & ALL_KEYBOARD_FLAGS);
      return true;
    });

    // `CSI < number u` pops, defaulting to one entry.
    this.csi('<', (params) => {
      this.stack.pop(param(params, 0, 1));
      return true;
    });

    // `CSI = flags ; mode u` sets without touching the stack.
    this.csi('=', (params) => {
      this.stack.set(
        param(params, 0, KeyboardFlags.NONE) & ALL_KEYBOARD_FLAGS,
        param(params, 1, KeyboardSetMode.ALL),
      );
      return true;
    });

    this.term.attachCustomKeyEventHandler((event) => this.onKeyEvent(event));

    // The alternate screen's state is discarded when it is left, the same way
    // its buffer is, so a program that crashes without popping cannot strand
    // the shell in its mode.
    const onBufferChange = this.term.buffer.onBufferChange(() => {
      if (this.term.buffer.active.type !== 'alternate') this.stacks.alternate.reset();
    });
    this.teardown.push(() => onBufferChange.dispose());
  }

  private csi(prefix: string, handler: (params: CsiParams) => boolean): void {
    try {
      const registration = this.term.parser.registerCsiHandler(
        { prefix, final: 'u' },
        handler as (params: (number | number[])[]) => boolean | Promise<boolean>,
      );
      this.teardown.push(() => registration.dispose());
    } catch (error) {
      console.warn(`webterm: kitty keyboard handler CSI ${prefix} u not registered`, error);
    }
  }

  private send(data: string): void {
    if (this.options.send) this.options.send(data);
    // wasUserInput is true so the terminal scrolls to the prompt and clears the
    // selection exactly as it does for a typed key, which is what this is.
    else this.term.input(data, true);
  }

  /**
   * The single key handler.
   *
   * Returns true to let xterm encode the key as it always has, false to claim
   * it. Claiming is only ever done for a key the protocol actually encoded, so
   * with no flags set every key takes the untouched path.
   */
  private onKeyEvent(event: KeyboardEvent): boolean {
    if (this.disposed) return true;

    const chained = this.options.onKeyEvent?.(event);
    if (chained === false) return false;

    if (event.type === 'keypress') {
      // The decision was made on the keydown; this only carries it out.
      if (!this.suppressKeypress) return true;
      this.suppressKeypress = false;
      return false;
    }

    if (event.type === 'keydown') this.suppressKeypress = false;

    const flags = this.stack.current;
    if (flags === KeyboardFlags.NONE) return true;
    if (this.options.enabled && !this.options.enabled()) return true;

    const sequence = encodeKey(event as KeyInput, flags);
    if (sequence === null) {
      // A release with nothing to report must still be swallowed, or xterm's
      // keyup path may deliver something for it. A press with nothing to report
      // is a key the protocol is not claiming, so it passes through.
      return event.type !== 'keyup';
    }

    // The browser's own action for this key is not wanted once the application
    // has asked to see the key itself.
    event.preventDefault();
    event.stopPropagation();
    this.send(sequence);
    if (event.type === 'keydown') this.suppressKeypress = true;
    return false;
  }

  /** Drop all state, as a terminal reset requires. */
  reset(): void {
    this.stacks.normal.reset();
    this.stacks.alternate.reset();
    this.suppressKeypress = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const fn of this.teardown) {
      try {
        fn();
      } catch {
        // Disposal races a terminal that is already tearing down.
      }
    }
    this.teardown.length = 0;
    this.reset();
  }
}
