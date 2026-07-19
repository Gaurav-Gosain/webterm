/*
 * The single place webterm reaches past xterm.js's public API.
 *
 * Everything the kitty overlay needs that is not stable, published API lives
 * here, so that a breaking xterm release is one file to read and one file to
 * fix rather than a search across the graphics code. Nothing else under
 * src/kitty/ may cast through `unknown` to an underscore-prefixed property or
 * name a non-public method; the overlay talks to the object this module
 * returns.
 *
 * Three dependencies, each with a defined degradation:
 *
 *   1. `term.parser.registerApcHandler`. Not present in @xterm/xterm 6.0.0, and
 *      only shipped in the 6.1.0 beta, so it is absent from the published types
 *      even where it exists at runtime. Nothing can receive the kitty APC
 *      without it: `supportsApc` reports that up front so a consumer can skip
 *      installing the overlay entirely, and the overlay refuses to construct
 *      rather than half-working. If xterm renames or drops it, kitty graphics
 *      stops working and the escape sequences are swallowed by xterm's own APC
 *      parsing, which is the same as having no graphics support.
 *
 *   2. `term._core._inputHandler`, for `lineFeed()` and `_moveCursor()`. Used
 *      to consume the cells a placement covers at the exact point in the stream
 *      the placement was parsed. If it disappears the movement is queued as a
 *      written escape sequence instead: the rows are still consumed, but only
 *      after the remainder of the current chunk has been parsed, so text that
 *      followed the image in the same chunk lands on top of it.
 *
 *   3. `term._core._renderService.dimensions.css.cell`, for the cell box in CSS
 *      pixels. If it disappears the cell box is measured off the rendered
 *      `.xterm-screen` element against the grid, which is public and real; only
 *      when no element has been rendered yet does it fall back to a ratio of
 *      the font size, which misplaces images on a font whose metrics differ.
 *
 * Every reach is wrapped so a renamed or removed internal degrades rather than
 * throwing into the parser callback that triggered it.
 */
import type { Terminal } from '@xterm/xterm';
import { KITTY_APC_IDENT } from './protocol.js';

/**
 * The slice of xterm's private input handler the cursor advance drives.
 *
 * `lineFeed` is the same entry point the parser uses for a `\n`, so it scrolls
 * at the bottom of the screen and keeps the buffer consistent. `_moveCursor` is
 * optional: losing it costs the horizontal half of the movement, not the rows.
 */
interface InputHandlerLike {
  lineFeed(): void;
  _moveCursor?(x: number, y: number): void;
}

/** A subscription that can be undone, matching xterm's own IDisposable. */
export interface XtermDisposable {
  dispose(): void;
}

/** The private surface of xterm the kitty overlay is allowed to use. */
export interface XtermAdapter {
  /**
   * Route the kitty APC (`ESC _ G ... ESC \`) to `handler`.
   *
   * Touches `term.parser.registerApcHandler`. Returning true from the handler
   * tells xterm the sequence was consumed. Call `supportsApc` first: on a build
   * without the method this throws, since there is no useful way to run the
   * overlay when nothing can deliver a command to it.
   */
  registerApc(handler: (data: string) => boolean): XtermDisposable;

  /**
   * Consume `rows` rows and `cols` columns of the buffer at the current cursor.
   *
   * Touches `term._core._inputHandler`. Falls back to writing the equivalent
   * escape sequence, which lands a chunk late; see the module header.
   */
  advanceCursor(cols: number, rows: number): void;

  /**
   * The cell box in CSS pixels.
   *
   * Touches `term._core._renderService.dimensions.css.cell`, then measures the
   * rendered screen element, then estimates from the font size.
   */
  cellPixels(): { width: number; height: number };
}

/**
 * True when the running xterm build exposes the APC parser hook.
 *
 * Kept separate from the adapter so a consumer can decide whether to install
 * the overlay at all without constructing anything.
 */
export function supportsApc(term: Terminal): boolean {
  return typeof (term.parser as { registerApcHandler?: unknown }).registerApcHandler === 'function';
}

/**
 * Register the kitty APC handler across the two shapes xterm has shipped.
 *
 * Older builds take the identifier as a number and hand the callback the
 * payload including the ident byte. Current builds take an IFunctionIdentifier
 * (`{ final: 'G' }`) and strip the ident first. splitApc tolerates both, so all
 * that differs here is the argument. The number form is tried second because
 * the object form is what the API is documented as taking now.
 */
function registerKittyApc(
  term: Terminal,
  handler: (data: string) => boolean,
): XtermDisposable {
  const parser = term.parser as unknown as {
    registerApcHandler(id: unknown, callback: (data: string) => boolean): XtermDisposable;
  };
  try {
    return parser.registerApcHandler({ final: String.fromCharCode(KITTY_APC_IDENT) }, handler);
  } catch {
    return parser.registerApcHandler(KITTY_APC_IDENT, handler);
  }
}

/** Build the adapter for `term`. The private lookups are cached on first use. */
export function createXtermAdapter(term: Terminal): XtermAdapter {
  let inputHandler: InputHandlerLike | null = null;
  let inputHandlerChecked = false;

  /** xterm's input handler, when this build exposes it. */
  const getInputHandler = (): InputHandlerLike | null => {
    if (inputHandlerChecked) return inputHandler;
    inputHandlerChecked = true;
    try {
      const candidate = (term as unknown as { _core?: { _inputHandler?: InputHandlerLike } })._core
        ?._inputHandler;
      if (candidate && typeof candidate.lineFeed === 'function') inputHandler = candidate;
    } catch {
      inputHandler = null;
    }
    return inputHandler;
  };

  return {
    registerApc(handler) {
      return registerKittyApc(term, handler);
    },

    advanceCursor(cols, rows) {
      const handler = getInputHandler();
      if (!handler) {
        // No private input handler on this build. Queueing the movement still
        // consumes the rows, which is much closer to right than not moving at
        // all; it only lands after the remainder of the current chunk.
        const seq = '\n'.repeat(Math.max(0, rows)) + (cols > 0 ? `\x1b[${cols}C` : '');
        if (seq) term.write(seq);
        return;
      }
      for (let i = 0; i < rows; i++) handler.lineFeed();
      if (cols > 0) handler._moveCursor?.(cols, 0);
    },

    cellPixels() {
      // The private render service is the accurate answer and stays correct
      // through font, size and device pixel ratio changes, but it is not public
      // API and can be renamed in any release. The fallback measures the
      // rendered screen element against the grid, which is public and real
      // rather than an estimate from the font size; only when there is no
      // element yet does it fall back to a ratio, which will misplace images on
      // a font whose metrics differ.
      try {
        const dims = (
          term as unknown as {
            _core: {
              _renderService: { dimensions: { css: { cell: { width: number; height: number } } } };
            };
          }
        )._core._renderService.dimensions.css.cell;
        if (dims && dims.width && dims.height) return { width: dims.width, height: dims.height };
      } catch {
        // Private path gone or renamed; fall through to the measured one.
      }

      const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null;
      if (screen && term.cols > 0 && term.rows > 0) {
        const width = screen.clientWidth / term.cols;
        const height = screen.clientHeight / term.rows;
        if (width > 0 && height > 0) return { width, height };
      }

      const fontSize = term.options.fontSize ?? 14;
      return { width: fontSize * 0.6, height: fontSize * 1.2 };
    },
  };
}
