// What a finger on the terminal itself does.

import { checkNamespace, detectTouch } from './detect.js';
import { touchStyle } from './styles.js';

// How long a finger has to sit still on the terminal before moving it off
// becomes a mouse drag rather than a pan. Long enough that a swipe started
// from a standstill still scrolls, short enough that holding for a drag
// does not feel like waiting.
const TOUCH_HOLD_MS = 450;

// And how far it may wander while doing it. A finger is not a mouse: some
// travel is unavoidable and none of it is meant.
const TOUCH_SLOP_PX = 10;

// How long the one-time drag hint stays up. Where it is remembered depends
// on the namespace: `<ns>.touch.hint`.
const TOUCH_HINT_MS = 4000;

// What the hint says. One instruction, in the plainest words there are.
const TOUCH_HINT_TEXT = 'Hold, then drag to move or select.';

// The events xterm.js's gesture recognizer dispatches on its screen
// element. They are non-bubbling CustomEvents, so the only way for anyone
// else on the page to see one is an ancestor's capture listener.
const GESTURE_CHANGE = '-xterm-gesturechange';
const GESTURE_TAP = '-xterm-gesturetap';
const GESTURE_CONTEXT_MENU = '-xterm-gesturecontextmenu';

/** What the touch layer needs from the page. */
export interface TouchMouseHost {
  /**
   * The element the terminal is drawn on. For xterm.js that is
   * .xterm-screen, which is the element its gesture recognizer was pointed
   * at and the element its mouse handlers measure against. Without one
   * nothing installs.
   */
  screen: HTMLElement | null | undefined;
  /**
   * Called inside the tap gesture, before the click goes out, for a page
   * that wants to raise the software keyboard when the terminal is tapped.
   */
  onTap?(): void;
}

export interface TouchMouseOptions {
  /** False to stop a tap becoming a click and a long press a right click. Default true. */
  tap?: boolean;
  /** False to stop press-hold-then-move becoming a mouse drag. Default true. */
  drag?: boolean;
  /** How long a finger must sit still before a move off it is a drag. Default 450. */
  longPressMs?: number;
  /** How far a finger may wander and still count as still, in CSS pixels. Default 10. */
  slopPx?: number;
  /** False to draw nothing that teaches the drag: no ring and no one-time hint. Default true. */
  hint?: boolean;
  /**
   * The stem of the ids, styles and storage key the layer emits. Defaults to
   * 'webterm'. sip passes 'sip'.
   */
  namespace?: string;
}

export interface TouchMouseController {
  /** Whether it installed at all (touch devices only). */
  readonly enabled: boolean;
  destroy(): void;
}

interface Point {
  x: number;
  y: number;
}

interface Press extends Point {
  id: number;
  held: boolean;
  dragging: boolean;
}

/** The fields of a gesture event the layer reads and repairs. */
type GestureEvent = Event & {
  clientX?: number;
  clientY?: number;
  pageX?: number;
  pageY?: number;
};

/**
 * Make a finger on the terminal act like a mouse.
 *
 * Out of the box it does not, and the reason is worth writing down because
 * nothing about it is visible from the outside.
 *
 * xterm.js recognizes touch with a Gesture class inherited from VS Code.
 * It registers touchstart and touchmove on the *document* with
 * {passive:false} and ends every handler with preventDefault() followed by
 * stopPropagation(). The first half means the browser never synthesizes
 * the compatibility mousedown / mouseup / click a tap normally produces;
 * the second means the touch events themselves never reach the window's
 * bubble phase. So a page sitting on top of xterm sees nothing at all: tap
 * to focus, tap to place the cursor, drag to select, long press and any
 * press-motion-release gesture are all dead, and a program in mouse mode
 * gets zero bytes for any of them.
 *
 * What the recognizer does produce is five CustomEvents on the screen
 * element, and xterm subscribes to two of them: gesturestart and
 * gesturechange, which is how a pan becomes wheel reports. gesturetap and
 * gesturecontextmenu are dispatched to the same element and dropped on the
 * floor. That is most of the fix, and it needs no new gesture recognition:
 * a tap is a click and a long press is a right click.
 *
 * The rest is one gesture the recognizer has no event for, because a
 * press, a hold, and then a move is a pan as far as it is concerned. It is
 * how a finger drags a scrollbar, pulls a split, moves a window or selects
 * a region, and nothing else on a phone can do it, so it is recognized
 * here: hold still for TOUCH_HOLD_MS and the pan you would have got
 * becomes a press at the origin, motion, and a release.
 *
 * Everything is expressed as a MouseEvent dispatched at the screen
 * element, never as bytes. That is deliberate. xterm already owns the
 * encoding, and there is more of it than a touch layer has any business
 * reimplementing: which of X10, VT200, urxvt, SGR and SGR-pixels the
 * program asked for, whether it wants motion at all, whether the report is
 * suppressed because the user is holding the modifier that forces
 * selection, and the per-cell deduplication of motion. Synthesizing the
 * event a mouse would have produced gets all of it, and gets the right
 * behaviour for a program in no mouse mode at all for free: the same
 * press-hold-drag runs xterm's selection service instead, which is how a
 * finger selects text.
 *
 * The listeners go on the window in the capture phase. The gesture events
 * are dispatched *at* the screen element, and at the target itself capture
 * and bubble listeners run in registration order, so a capture listener
 * added to the screen element would still run after xterm's own, which
 * consumes the event with stopPropagation. An ancestor's capture listener
 * runs before the target's whatever the order of registration, and the
 * events do not bubble, so capture is also the only phase in which they
 * are visible from outside at all.
 */
class TouchMouse implements TouchMouseController {
  enabled = false;
  private readonly host: TouchMouseHost;
  private readonly screen: HTMLElement;
  private readonly ns: string;
  private readonly hintKey: string;
  private readonly tap: boolean;
  private readonly drag: boolean;
  private readonly holdMs: number;
  private readonly slop: number;
  private readonly hint: boolean;
  private off: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | 0 = 0;
  private hintTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private ring: HTMLElement | null = null;
  private hintEl: HTMLElement | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private hintShown = false;
  // The last place a finger was actually seen, in viewport pixels.
  private anchor: Point | null = null;
  // The touch being tracked, or null.
  private press: Press | null = null;
  // Set once a touch has become a drag, and cleared by the next
  // touchstart: everything the recognizer says about that touch
  // afterwards, including the tap it thinks ended it and the inertia
  // it thinks follows it, belongs to the drag and is not repeated.
  private claimed = false;

  constructor(host: TouchMouseHost & { screen: HTMLElement }, options: TouchMouseOptions | undefined, ns: string) {
    const o = options || {};
    this.host = host;
    this.screen = host.screen;
    this.ns = ns;
    this.hintKey = `${ns}.touch.hint`;
    this.tap = o.tap !== false;
    this.drag = o.drag !== false;
    this.holdMs = positive(o.longPressMs, TOUCH_HOLD_MS);
    this.slop = positive(o.slopPx, TOUCH_SLOP_PX);
    this.hint = o.hint !== false;
  }

  private on<E extends Event>(
    target: EventTarget,
    type: string,
    fn: (e: E) => void,
    opts?: AddEventListenerOptions | boolean,
  ): void {
    const listener = fn as unknown as EventListener;
    target.addEventListener(type, listener, opts);
    this.off.push(() => target.removeEventListener(type, listener, opts));
  }

  install(): this {
    this.on<GestureEvent>(window, GESTURE_CHANGE, (e) => this.onChange(e), true);
    if (this.tap) {
      this.on<GestureEvent>(window, GESTURE_TAP, (e) => this.onTap(e, 0), true);
      this.on<GestureEvent>(window, GESTURE_CONTEXT_MENU, (e) => this.onTap(e, 2), true);
    }
    if (this.drag) {
      const opts = { capture: true, passive: true };
      this.on<TouchEvent>(this.screen, 'touchstart', (e) => this.onTouchStart(e), opts);
      this.on<TouchEvent>(this.screen, 'touchmove', (e) => this.onTouchMove(e), opts);
      this.on<TouchEvent>(this.screen, 'touchend', (e) => this.onTouchEnd(e), opts);
      this.on<TouchEvent>(this.screen, 'touchcancel', (e) => this.onTouchEnd(e), opts);
      if (this.hint) {
        this.styleEl = document.createElement('style');
        this.styleEl.id = `${this.ns}-touch-style`;
        this.styleEl.textContent = touchStyle(this.ns);
        document.head.appendChild(this.styleEl);
      }
    }
    this.enabled = true;
    return this;
  }

  destroy(): void {
    this.clearTimer();
    this.hideRing();
    this.hideHint();
    if (this.styleEl) this.styleEl.remove();
    this.styleEl = null;
    this.off.forEach((fn) => fn());
    this.off = [];
    this.enabled = false;
  }

  // --- what teaches the drag ------------------------------------------

  /**
   * The ring under the finger, drawn the moment a hold has landed.
   *
   * The drag is a gesture nothing on the screen announces: a finger
   * that moves at once pans, and the only way to learn that holding it
   * first makes it a drag is to be told. The ring is that telling, and
   * it is timed to the fact rather than to a guess: it appears exactly
   * when TOUCH_HOLD_MS has elapsed, which is exactly when moving the
   * finger would start a drag, and it follows the finger for as long
   * as the drag lasts. It is the same signal in every mouse mode, since
   * a hold-and-drag on a plain shell is how a finger selects. A short
   * vibration goes with it where the platform has one, so the hold can
   * be felt without looking.
   */
  private showRing(p: Point | null): void {
    if (!this.hint) return;
    if (!this.ring) {
      this.ring = document.createElement('div');
      this.ring.id = `${this.ns}-touch-ring`;
      this.ring.setAttribute('aria-hidden', 'true');
      document.body.appendChild(this.ring);
      // Let the initial transform land before the transition to it.
      this.ring.getBoundingClientRect();
    }
    this.moveRing(p);
    this.ring.classList.add('on');
    try {
      if (navigator.vibrate) navigator.vibrate(8);
    } catch {
      /* not a phone, or not allowed */
    }
  }

  private moveRing(p: Point | null): void {
    if (!this.ring || !p) return;
    this.ring.style.left = `${Math.round(p.x)}px`;
    this.ring.style.top = `${Math.round(p.y)}px`;
  }

  private hideRing(): void {
    if (this.ring) this.ring.classList.remove('on');
  }

  /**
   * The one line, shown once.
   *
   * A finger that moved before the hold landed panned, which is what a
   * user who wanted to move something tries first, and nothing on the
   * screen tells them why it did not work. This is the one time the
   * page speaks up: the first pan ever, one sentence, gone after a few
   * seconds, never again. It is remembered in localStorage, so a
   * private window sees it once per session, which is the honest
   * fallback.
   */
  private maybeHint(): void {
    if (!this.hint) return;
    let seen = false;
    try {
      seen = localStorage.getItem(this.hintKey) === '1';
    } catch {
      seen = this.hintShown === true;
    }
    if (seen) return;
    this.hintShown = true;
    try {
      localStorage.setItem(this.hintKey, '1');
    } catch {
      /* private mode */
    }
    if (!this.hintEl) {
      this.hintEl = document.createElement('div');
      this.hintEl.id = `${this.ns}-touch-hint`;
      this.hintEl.setAttribute('role', 'status');
      this.hintEl.textContent = TOUCH_HINT_TEXT;
      document.body.appendChild(this.hintEl);
      this.hintEl.getBoundingClientRect();
    }
    this.hintEl.classList.add('on');
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => this.hideHint(), TOUCH_HINT_MS);
  }

  private hideHint(): void {
    clearTimeout(this.hintTimer);
    this.hintTimer = 0;
    if (this.hintEl) this.hintEl.classList.remove('on');
  }

  /** Whether an event landed on the terminal this instance is watching. */
  private owns(e: Event): boolean {
    const t = e.target;
    return t === this.screen || (t instanceof Node && this.screen.contains(t));
  }

  // --- the coordinates an inertial scroll forgets -----------------------

  /**
   * Repair a gesturechange that carries no coordinates, and drop it if
   * the drag already spoke for this touch.
   *
   * This is a live data-corruption bug in xterm.js, not a nicety.
   * Gesture._inertia builds its CHANGE events out of translationX and
   * translationY alone; unlike the ones touchmove builds, they carry no
   * pageX/pageY and no clientX/clientY. xterm's own handler passes them
   * to getMouseReportCoords, which subtracts the element's rect from an
   * undefined clientX and returns {col: NaN, row: NaN}, an object, so
   * truthy, so the encoder ships it. In mouse mode every flick therefore
   * types `\x1b[<65;NaN;NaNM` into the program: measured at 489 of 534
   * reports over three flings, which fills a shell with NaN;NaNMaN;NaNM.
   *
   * The last place a finger was actually seen is the honest answer for
   * where the scroll it threw is happening, so that is what is filled
   * in. With no such place, which should not happen since inertia only
   * follows a real touch, the event is dropped rather than guessed at.
   * The assignment is checked rather than assumed, because a future
   * bundle that dispatched a real MouseEvent here would have read-only
   * coordinates and this module is strict-mode.
   */
  private onChange(e: GestureEvent): void {
    if (!this.owns(e)) return;
    if (this.claimed || (this.press && this.press.held)) {
      // The finger is dragging, not panning. Scrolling underneath it
      // as well would move the thing being dragged out from under it.
      e.stopImmediatePropagation();
      return;
    }
    if (isFiniteNum(e.clientX) && isFiniteNum(e.clientY)) {
      this.anchor = { x: e.clientX, y: e.clientY };
      return;
    }
    if (!this.anchor || !fillCoords(e, this.anchor)) e.stopImmediatePropagation();
  }

  // --- tap, long press --------------------------------------------------

  /** A recognized tap or long press, as a press and release of button. */
  private onTap(e: GestureEvent, button: number): void {
    if (!this.owns(e) || this.claimed) return;
    const p = this.pointOf(e);
    if (!p) return;
    this.mouse('mousedown', p, button, button === 2 ? 2 : 1);
    this.mouse('mouseup', p, button, 0);
    // A tap on a terminal means "I want to type here". The recognizer
    // dispatches this from its touchend handler, so this call is still
    // inside the user gesture a software keyboard needs.
    if (button === 0 && this.host.onTap) this.host.onTap();
  }

  /** Where a gesture event happened, in viewport pixels. */
  private pointOf(e: GestureEvent): Point | null {
    if (!isFiniteNum(e.pageX) || !isFiniteNum(e.pageY)) return this.anchor;
    return {
      x: e.pageX - (window.scrollX || 0),
      y: e.pageY - (window.scrollY || 0),
    };
  }

  // --- press, hold, drag ------------------------------------------------

  private onTouchStart(e: TouchEvent): void {
    // A second finger arriving mid-drag ends it rather than leaving the
    // program holding a button down forever.
    this.release();
    this.claimed = false;
    this.clearTimer();
    this.press = null;
    const t = e.touches.length === 1 ? e.touches[0] : null;
    if (!t) return;
    this.anchor = { x: t.clientX, y: t.clientY };
    this.press = {
      id: t.identifier,
      x: t.clientX,
      y: t.clientY,
      held: false,
      dragging: false,
    };
    this.timer = setTimeout(() => {
      this.timer = 0;
      if (!this.press) return;
      this.press.held = true;
      this.showRing(this.anchor);
    }, this.holdMs);
  }

  private onTouchMove(e: TouchEvent): void {
    const p = this.press;
    const t = touchById(e.touches, p);
    if (!t || !p) return;
    const at = { x: t.clientX, y: t.clientY };
    this.anchor = at;
    const far = Math.hypot(at.x - p.x, at.y - p.y) > this.slop;
    if (p.dragging) {
      this.moveRing(at);
      this.mouse('mousemove', at, 0, 1);
      return;
    }
    if (!p.held) {
      // Moved before the hold landed, so this is a pan and xterm's
      // own handler is what turns it into scrollback. The first
      // time that happens the page says what a hold would have
      // done, once.
      if (far) {
        this.clearTimer();
        this.press = null;
        this.maybeHint();
      }
      return;
    }
    if (!far) return;
    p.dragging = true;
    this.claimed = true;
    // The press belongs where the finger went down, not where it had
    // got to by the time the move crossed the slop: that is the cell
    // the user aimed at.
    this.mouse('mousedown', { x: p.x, y: p.y }, 0, 1);
    this.mouse('mousemove', at, 0, 1);
  }

  private onTouchEnd(e: TouchEvent): void {
    const p = this.press;
    // Another finger lifting says nothing about the one being tracked.
    const t = touchById(e.changedTouches, p);
    if (!t) return;
    this.clearTimer();
    this.anchor = { x: t.clientX, y: t.clientY };
    this.release();
  }

  /** End a drag in progress, if there is one. */
  private release(): void {
    const p = this.press;
    this.press = null;
    this.hideRing();
    if (!p || !p.dragging || !this.anchor) return;
    this.mouse('mouseup', this.anchor, 0, 0);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = 0;
  }

  private mouse(type: string, p: Point, button: number, buttons: number): void {
    this.screen.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      detail: 1,
      clientX: p.x,
      clientY: p.y,
      screenX: p.x,
      screenY: p.y,
      button,
      buttons,
    }));
  }
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

function positive(v: unknown, fallback: number): number {
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : fallback;
}

/** The tracked touch in a TouchList, or null. */
function touchById(list: TouchList | null | undefined, press: Press | null): Touch | null {
  if (!press || !list) return null;
  for (let i = 0; i < list.length; i++) {
    if (list[i].identifier === press.id) return list[i];
  }
  return null;
}

/** Give an event a position it was dispatched without. Reports success. */
function fillCoords(e: GestureEvent, at: Point): boolean {
  try {
    e.clientX = at.x;
    e.clientY = at.y;
    e.pageX = at.x + (window.scrollX || 0);
    e.pageY = at.y + (window.scrollY || 0);
  } catch {
    return false;
  }
  return e.clientX === at.x && e.clientY === at.y;
}

/**
 * Make a finger on the terminal act like a mouse, on a touch device. On any
 * other device, or without a screen element, it installs nothing and
 * returns an inert controller.
 */
export function installTouchMouse(host: TouchMouseHost, options?: TouchMouseOptions): TouchMouseController {
  const ns = checkNamespace(options?.namespace);
  if (!host || !host.screen || !detectTouch()) return { enabled: false, destroy() {} };
  return new TouchMouse(host as TouchMouseHost & { screen: HTMLElement }, options, ns).install();
}
