import type { Terminal } from '@xterm/xterm';
import { forceRepaint } from './kitty/xterm-adapter.js';
import type { SyncOutputOptions } from './types.js';

const DEFAULT_TIMEOUT_MS = 150;

/**
 * Keeps a terminal repainting while an application holds DEC mode 2026,
 * synchronized output, set faster than the renderer can get a frame in.
 *
 * Mode 2026 asks the terminal not to show a half-drawn frame. xterm.js honours
 * it in two places: `RenderService.refreshRows` buffers the damaged rows when
 * the mode is set, and `RenderService._renderRows` re-checks the mode inside
 * the animation frame and declines to draw if it is set again by then. The
 * second check is the problem. An end-of-update schedules a frame, parsing
 * continues in the same task, the next begin-of-update sets the mode again
 * microseconds later, and the frame that lands up to 16 ms afterwards finds the
 * mode set and draws nothing. The debouncer has already cleared its pending
 * range, so the refresh is not deferred, it is lost.
 *
 * Under output whose synchronized updates arrive more often than once per
 * frame, every frame lands inside an update and the terminal stops painting
 * outright. Measured against a sip session replaying a btop capture at
 * 12 MiB/s: 0.0 renders per second and one distinct framebuffer over five
 * seconds, against 43.9 renders per second for the same bytes with only the
 * mode 2026 sequences removed.
 *
 * xterm carries a 1000 ms safety timeout for exactly this, but it is armed when
 * rows are buffered and cleared in the handler's `flush()`, which runs on every
 * end-of-update. The event it protects against missing is the event that
 * disarms it, so under sustained updates it never fires.
 *
 * The policy here is not to ignore the mode. Tearing every frame would be a
 * regression for the applications the mode exists to serve. It is to put a
 * ceiling on how long a repaint can be withheld: if the mode is set and nothing
 * has painted for `timeoutMs`, paint once, then let the mode go back to
 * suppressing frames. An application that finishes its updates promptly, which
 * is every correct user of the mode, never reaches the ceiling and never tears.
 *
 * Forcing a repaint runs through the code that cancels xterm's 1000 ms timeout,
 * so the watchdog also takes over the case that timeout was there for: an
 * application that stops mid-update and never sends its end-of-update. One
 * timeout after the last byte, with the mode still set, the mode is left clear
 * rather than handed back, and the terminal is live again.
 */
export class SyncOutputWatchdog {
  private readonly term: Terminal;
  private readonly timeoutMs: number;
  private readonly onRender: { dispose(): void };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastPaintAt = 0;
  // Set by every write, cleared by every paint. It is what separates "the
  // application is producing and is mid-update" from "the application stopped
  // mid-update", which need opposite things done with the mode.
  private dirty = false;
  private disposed = false;
  private unavailable = false;
  /** Forced repaints so far. Read by the browser tests. */
  public forced = 0;

  constructor(term: Terminal, options: SyncOutputOptions = {}) {
    this.term = term;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.lastPaintAt = performance.now();
    this.onRender = term.onRender(() => {
      this.lastPaintAt = performance.now();
      this.dirty = false;
    });
  }

  /**
   * Called for every write that reaches the terminal.
   *
   * Arming from writes rather than from a mode 2026 parser hook keeps the
   * watchdog off entirely when nothing is arriving, which is the at-rest case,
   * and means it does not depend on the parser handler chain to notice a mode
   * it can read directly.
   */
  noteWrite(): void {
    if (this.disposed || this.unavailable || this.timeoutMs <= 0) return;
    this.dirty = true;
    this.arm();
  }

  private arm(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tick();
    }, this.timeoutMs);
  }

  private tick(): void {
    if (this.disposed) return;
    // Public API. When the mode is clear, xterm is drawing on its own schedule
    // and there is nothing here to fix, whatever the paint interval looks like:
    // a terminal that is not painting for some other reason is not this bug and
    // forcing a frame would only mask it.
    if (!this.term.modes.synchronizedOutputMode) return;
    if (performance.now() - this.lastPaintAt < this.timeoutMs) {
      this.arm();
      return;
    }

    // Data has arrived since the last paint, so the application is still
    // producing and is genuinely mid-update. Paint once and hand the mode back,
    // because its end-of-update has to find the mode where it left it.
    //
    // Nothing has arrived, and the mode is still set a full timeout after the
    // last paint: the application stopped mid-update and the end-of-update is
    // not coming. Leave the mode clear. This is what xterm's own 1000 ms
    // timeout is for, and the watchdog owes it, because forcing a repaint runs
    // through the code that cancels that timeout.
    const restoreMode = this.dirty;

    // Clearing the mode and rendering in the same tick is what makes this work
    // where xterm's timeout does not. xterm's clears the mode and then
    // schedules a frame, which the next begin-of-update re-arms the mode ahead
    // of, so the forced frame is declined exactly like every other one.
    if (!forceRepaint(this.term, restoreMode)) {
      // The mode was set two lines above, so the only way the repaint declines
      // is that this xterm build no longer exposes what it drives. Nothing will
      // change that within the session, so stop rather than run a timer that
      // can only fail.
      this.unavailable = true;
      return;
    }

    this.forced++;
    this.lastPaintAt = performance.now();
    this.dirty = false;
    // The mode is clear now, and only a new begin-of-update can set it again,
    // which only a write can carry. Stop until then.
    if (!restoreMode) return;
    this.arm();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.onRender.dispose();
  }
}
