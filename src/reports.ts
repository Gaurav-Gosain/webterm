/*
 * The query and report sequences webterm answers that xterm.js does not.
 *
 * Everything here is built on published `term.parser` API. There is no private
 * reach in this file, and there does not need to be: xterm's parser lets a
 * handler registered after construction run before the built-in one and fall
 * through to it by returning false, so a single sequence can be corrected
 * without displacing anything else.
 *
 * What is deliberately not here:
 *
 *   - `CSI 14 t`, `CSI 16 t` and `CSI 18 t`. xterm.js implements all three, in
 *     `InputHandler.windowOptions` and `CoreBrowserTerminal._reportWindowsOptions`,
 *     and gates every one of them behind `options.windowOptions`, which defaults
 *     to `{}`. The gate is applied to custom handlers too, so registering one
 *     here without opening the gate would be dead code. webterm opens the gate
 *     for the read-only reports instead; see `terminalOptions` in webterm.ts.
 *
 *   - OSC 4, 10, 11 and 12 colour queries. xterm.js answers all of them from its
 *     theme service, which is the live resolved palette, so a handler here would
 *     be a second, staler answer: the theme service also tracks the palette an
 *     application changes at runtime with an OSC 4 set, and `options.theme` does
 *     not. They read as unanswered under `@xterm/headless` only because a
 *     headless terminal has no theme service to read a colour out of.
 *
 *   - The colon SGR five-argument shorthand (`38:2:R:G:B`). It is misparsed
 *     inside `InputHandler._extractColor`, which reserves the third slot for the
 *     T.416 colour space id and shifts past it only for the indexed form. There
 *     is no published way to set the current character attributes from outside
 *     the input handler, so correcting it from here would mean reimplementing
 *     the whole of SGR. It belongs upstream.
 */
import type { Terminal } from '@xterm/xterm';

/** The default reported by XTGETTCAP `TN`, when the embedder names none. */
export const DEFAULT_TERMINAL_NAME = 'xterm-256color';

/**
 * The XTWINOPS operations webterm turns on, and the only ones.
 *
 * xterm.js implements the three geometry reports and then refuses to run any of
 * them unless the embedder opts in, because the same sequence family can also
 * move, resize and raise a window and it will not let a remote program do that
 * unasked. These three cannot act on the page: they answer with the size the
 * terminal already is, which is what a sender has to know before it can transmit
 * an image sized in cells.
 *
 *   CSI 14 t -> CSI 4 ; height ; width t, the text area in pixels
 *   CSI 16 t -> CSI 6 ; height ; width t, one cell in pixels
 *   CSI 18 t -> CSI 8 ; rows ; cols t, the text area in cells
 *
 * Everything that changes the window stays off, so `CSI 1 t`, `CSI 3 ; x ; y t`
 * and the title stack remain the no-ops they are by default. The gate applies to
 * handlers registered from outside as well, so opening it is not merely the
 * shortest way to answer these, it is the only one.
 */
export const GEOMETRY_WINDOW_OPTIONS = {
  getWinSizePixels: true,
  getCellSizePixels: true,
  getWinSizeChars: true,
} as const;

export interface TerminalReportsOptions {
  /** Where a reply goes. Called with the raw bytes to send up the pty. */
  respond(data: string): void;
  /**
   * The terminfo entry name reported for XTGETTCAP `TN`.
   *
   * A frontend does not choose this: the far end sets TERM, and the answer has
   * to agree with it or an application will look up the wrong capabilities.
   * Defaults to `xterm-256color`, which is what xterm.js's own device attributes
   * describe.
   */
  terminalName?: string;
}

export interface TerminalReports {
  /** Forget the DECSCUSR the application set, as RIS and DECSTR do. */
  reset(): void;
  dispose(): void;
}

/** The three cursor shapes xterm.js draws, and the DECSCUSR parameter for each. */
const DECSCUSR_STEADY: Record<string, number> = { block: 2, underline: 4, bar: 6 };

/**
 * The DECSCUSR parameter that would produce `style` and `blink`.
 *
 * Steady shapes are even (2 block, 4 underline, 6 bar) and the blinking form of
 * each is the odd number below it, so a blinking bar is 5. An unrecognised shape
 * reports as a steady block, which is what xterm.js draws for one.
 */
export function decscusrParam(style: string | undefined, blink: boolean | undefined): number {
  const steady = DECSCUSR_STEADY[style ?? 'block'] ?? DECSCUSR_STEADY.block;
  return steady - (blink ? 1 : 0);
}

/** The cursor shape a DECSCUSR parameter selects, or undefined for 0 (reset). */
export function decscusrStyle(param: number): 'block' | 'underline' | 'bar' | undefined {
  if (param === 1 || param === 2) return 'block';
  if (param === 3 || param === 4) return 'underline';
  if (param === 5 || param === 6) return 'bar';
  return undefined;
}

/** Hex-decode one XTGETTCAP capability name. Returns undefined for bad input. */
export function decodeTcapName(hex: string): string | undefined {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined;
  let out = '';
  for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** Hex-encode a capability name or value the way XTGETTCAP replies carry them. */
export function encodeTcap(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Anything outside Latin-1 has no single-byte encoding to hex, and no
    // terminfo capability name or value webterm answers contains one.
    if (code > 0xff) return '';
    out += code.toString(16).padStart(2, '0').toUpperCase();
  }
  return out;
}

/**
 * Build the XTGETTCAP reply for a request payload, or undefined to stay silent.
 *
 * Only capabilities webterm can answer truthfully are answered. An unknown name
 * is left out rather than refused with `DCS 0 + r`: a refusal is a claim that
 * the terminal lacks the capability, and what is actually true here is that this
 * layer does not know. An application that gets no answer falls back to its
 * terminfo entry, which is the right source for everything else.
 */
export function xtgettcapReply(payload: string, terminalName: string): string | undefined {
  const answers: string[] = [];
  for (const hex of payload.split(';')) {
    const name = decodeTcapName(hex.trim());
    if (name === undefined) continue;
    const value = tcapValue(name, terminalName);
    if (value === undefined) continue;
    const encodedName = encodeTcap(name);
    const encodedValue = encodeTcap(value);
    if (!encodedName || !encodedValue) continue;
    answers.push(`${encodedName}=${encodedValue}`);
  }
  if (answers.length === 0) return undefined;
  return `\x1bP1+r${answers.join(';')}\x1b\\`;
}

/** The capabilities this layer can state as fact. */
function tcapValue(name: string, terminalName: string): string | undefined {
  // TN is the terminfo entry name. Co and colors are the same capability under
  // its termcap and terminfo names; xterm.js renders the full 256-colour palette
  // and truecolour, so 256 is a floor it always meets.
  if (name === 'TN' || name === 'name') return terminalName;
  if (name === 'Co' || name === 'colors') return '256';
  return undefined;
}

/**
 * Register the report handlers on `term`.
 *
 * Two sequences are corrected:
 *
 *   DECRQSS for DECSCUSR (`DCS $ q SP q ST`). xterm.js answers it from
 *   `options.cursorStyle` and `options.cursorBlink`, but `CSI Ps SP q` writes to
 *   `coreService.decPrivateModes` and never touches the options, so the reply
 *   reports the embedder's configured cursor rather than the one the application
 *   set and the one on screen. The application's DECSCUSR is tracked here and
 *   the reply is built from it, falling back to the options exactly as the
 *   renderer does. Every other DECRQSS setting falls through to xterm.
 *
 *   XTGETTCAP (`DCS + q ... ST`). xterm.js has no handler for it at all, so the
 *   request is parsed and discarded and the application waits out its timeout.
 */
export function installTerminalReports(
  term: Terminal,
  options: TerminalReportsOptions,
): TerminalReports {
  const terminalName = options.terminalName ?? DEFAULT_TERMINAL_NAME;

  // Undefined means the application has set no DECSCUSR, so the configured
  // option is in force. This mirrors `decPrivateModes.cursorStyle ?? options`,
  // which is how the renderer decides what to draw.
  let style: 'block' | 'underline' | 'bar' | undefined;
  let blink: boolean | undefined;

  const reset = (): void => {
    style = undefined;
    blink = undefined;
  };

  const subscriptions = [
    // DECSCUSR. Returning false leaves xterm to apply it as before; this only
    // watches, so the reply can be built from the same state that is drawn.
    term.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
      const param = params.length === 0 ? 1 : (params[0] as number);
      if (param === 0) reset();
      else {
        const next = decscusrStyle(param);
        if (next) {
          style = next;
          blink = param % 2 === 1;
        }
      }
      return false;
    }),

    // RIS and DECSTR both clear the private modes xterm keeps DECSCUSR in.
    term.parser.registerEscHandler({ final: 'c' }, () => {
      reset();
      return false;
    }),
    term.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
      reset();
      return false;
    }),

    // DECRQSS. Only the cursor style is answered here; everything else falls
    // through to xterm's own `requestStatusString`.
    term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, (data) => {
      if (data !== ' q') return false;
      const param = decscusrParam(style ?? term.options.cursorStyle, blink ?? term.options.cursorBlink);
      options.respond(`\x1bP1$r${param} q\x1b\\`);
      return true;
    }),

    // XTGETTCAP.
    term.parser.registerDcsHandler({ intermediates: '+', final: 'q' }, (data) => {
      const reply = xtgettcapReply(data, terminalName);
      if (reply) options.respond(reply);
      // Consumed either way: nothing else is listening for this identifier, and
      // reporting it unhandled would only reach xterm's no-op fallback.
      return true;
    }),
  ];

  return {
    reset,
    dispose(): void {
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}
