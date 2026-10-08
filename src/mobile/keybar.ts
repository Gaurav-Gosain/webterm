// The touch key bar and the keyboard-aware layout.
//
// A phone keyboard has no Esc, no Tab, no Ctrl and no arrows, which is most of
// what a terminal is driven with, and when it opens it covers the bottom half
// of the terminal it was opened for. This module fixes both. It imports nothing
// from the terminal, injects its own styles, builds its own DOM, and talks to
// the terminal through one plain host object, so it works on any page that has
// a terminal in it.
//
// It publishes two CSS custom properties on the document element:
//
//   --<ns>-kb-inset    height of the software keyboard, or 0px.
//   --<ns>-keybar-h    height of the key bar, or 0px.
//
// The page decides what to do with them. The obvious thing is
//
//   #terminal-container { padding-bottom: calc(var(--<ns>-kb-inset) + var(--<ns>-keybar-h)); }
//
// which makes the terminal's own ResizeObserver fire, which is how the grid
// gets resized. Nothing in this module knows about the terminal.
//
// Body classes for page styling: <ns>-touch while the bar is up, <ns>-kb-open
// while the software keyboard is open. <ns> is the `namespace` option,
// 'webterm' unless the caller picks another.

import { checkNamespace, detectTouch } from './detect.js';
import {
  BARE_CSI,
  BARE_MODIFIERS,
  DEFAULT_KEYS,
  ctrlByte,
  encodeKeySpec,
  modifierParam,
  type EncodableKey,
  type KeyChord,
  type KeyMods,
  type MobileKey,
  type MobileModifier,
} from './keys.js';
import { keyBarStyle } from './styles.js';

// A swipe across the bar has to travel further than this before it stops
// being a tap. The bar is a scroller, so the finger is expected to move,
// and a button that fires while the user is flicking past it is worse than
// one that needs a second try.
const BAR_TAP_SLOP_PX = 12;

// The bar keeps moving after a flick, and this is how it stops: velocity
// times this every frame. About a third of a second of travel from a hard
// flick, which crosses the bar without feeling like it is drifting.
const BAR_GLIDE_DECAY = 0.94;

// Pixels per millisecond below which a glide has stopped.
const BAR_GLIDE_MIN_V = 0.02;

// A keyboard that vanishes within this long of a bar gesture ending, while
// the focus target still holds focus, was taken away by the browser rather
// than by the user, and is asked for again. See armKeyboardRescue.
const KB_RESCUE_MS = 700;

// Below this an inset is browser chrome moving, not a keyboard. Acting on
// those would make the terminal twitch every time the URL bar slides.
const INSET_MIN_PX = 48;

// And no keyboard is taller than this share of the window. A larger reading
// is a bad measurement, and clamping it means a wrong guess costs some
// wasted space rather than a terminal squeezed to nothing.
const INSET_MAX_FRACTION = 0.72;

/** What the key bar needs from the page. */
export interface KeyBarHost {
  /** Write terminal input bytes, as a string. */
  send(text: string): unknown;
  /**
   * The element that holds the software keyboard up, or null. For xterm.js
   * that is term.textarea. Without one there is no keyboard to raise, so the
   * bar leaves out its keyboard key and never tries to keep focus.
   */
  focusTarget?(): HTMLElement | null | undefined;
  /** False while the terminal is not accepting input. Defaults to always ready. */
  isReady?(): boolean;
  /**
   * Encode one key spec as input bytes, or null for a key that produces
   * nothing. Hosts that own a key encoder pass it here. Everyone else gets
   * encodeKeySpec, which covers the default key set.
   */
  encodeKey?(spec: EncodableKey, mods: KeyMods): string | null;
}

/** A page control on the bar: run() is called inside the tap gesture. */
export interface MobileAction {
  label: string;
  title?: string;
  run(bar: KeyBarController): void;
  id?: string;
  narrow?: boolean;
}

/** One strip of the bar. */
export interface MobileRow {
  label?: string;
  keys: MobileKey[];
  /** A collapsible row can be folded away, and whether it is folded is remembered. */
  collapsible?: boolean;
  id?: string;
}

export interface KeyBarOptions {
  /** The typing row. Defaults to DEFAULT_KEYS. Ignored when `rows` is given. */
  keys?: readonly MobileKey[] | null;
  /**
   * Full control of the layout: rows drawn top to bottom, with the typing row
   * conventionally last because it is the one nearest the thumb.
   */
  rows?: readonly MobileRow[] | null;
  /** Appended to the last row behind a divider and tinted apart. */
  actions?: readonly MobileAction[] | null;
  /**
   * The leader chord this deployment is driven by. It powers `prefix` and
   * `prefixed` keys. Without it, both degrade to nothing rather than to
   * something wrong.
   */
  prefix?: KeyChord | null;
  /** False to leave out the pinned show/hide keyboard key. */
  keyboardKey?: boolean;
  /**
   * False to leave the strip out altogether and keep only the keyboard-aware
   * layout and the sticky modifiers, for a page that draws its own controls.
   */
  keyBar?: boolean;
  /** Namespace for what the bar remembers. Defaults to `namespace`. */
  storagePrefix?: string;
  /**
   * The stem of every id, class, custom property and storage key the bar
   * emits. Defaults to 'webterm'. sip passes 'sip'.
   */
  namespace?: string;
  /** Where the bar is appended. Defaults to document.body. */
  container?: HTMLElement | null;
}

/** A modifier's state: 0 off, 1 armed for one key, 2 locked. */
export type ModState = 0 | 1 | 2;

/** What installKeyBar returns. On a desktop every method is a no-op. */
export interface KeyBarController {
  /** Whether the bar installed at all (touch devices only). */
  readonly enabled: boolean;
  readonly mods: Record<MobileModifier, ModState>;
  /** Whether the leader has been sent and the program waits for the second key. */
  readonly prefixPending: boolean;
  /** Whether transformInput has anything to do. */
  readonly pending: boolean;
  /** Fold the armed modifiers into input the host is about to send. */
  transformInput(text: string): string;
  /** The same, one level up, for hosts that encode key events themselves. */
  wrapKey<T extends KeyLike>(event: T): T | WrappedKey;
  /** Mark a bar button '', 'active', 'armed' or 'locked'. */
  setState(id: string, state: '' | 'active' | 'armed' | 'locked'): void;
  /** Fold or unfold the collapsible rows. */
  setRowsOpen(open: boolean): void;
  /** Send the leader chord. False when none is configured. */
  sendPrefix(): boolean;
  /** Raise the software keyboard. Must be called inside a user gesture. */
  focusInput(): void;
  destroy(): void;
}

/** The fields of a KeyboardEvent that wrapKey reads. */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

/** An event-shaped object with the armed modifiers folded in. */
export interface WrappedKey {
  key: string;
  code: string | undefined;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** Everything a bar button can be, internally. */
interface BarSpec extends Partial<Omit<MobileKey, 'label'>> {
  label?: string;
  sep?: boolean;
  action?: boolean;
  keyboard?: boolean;
  fold?: boolean;
  run?: (bar: KeyBarController) => void;
}

interface BarRow {
  el: HTMLElement;
  scroll: HTMLElement;
  collapsible: boolean;
}

interface VirtualKeyboardLike extends EventTarget {
  overlaysContent: boolean;
  readonly boundingRect: DOMRectReadOnly | null;
}

type Listener = [EventTarget, string, EventListener, AddEventListenerOptions | boolean | undefined];

// Pinned to the right of the bar, outside the scrollers: the way back to
// the software keyboard has to be reachable from wherever any row is
// scrolled to.
const KEYBOARD_KEY: BarSpec = {
  label: 'abc', title: 'Show or hide the software keyboard', keyboard: true,
};

// Pinned above it, and folds the collapsible rows away.
//
// A second row over a software keyboard costs about three rows of terminal
// on a phone, and for a user who only types it is a row they never touch.
// Only the rows a deployment marks collapsible fold: the typing row is why
// the bar exists at all, and a chord row is still reachable through the
// prefix key and the software keyboard.
const FOLD_KEY: BarSpec = {
  label: '▾', title: 'Hide the extra rows', fold: true, narrow: true,
};

class KeyBar implements KeyBarController {
  readonly host: KeyBarHost;
  readonly options: KeyBarOptions;
  readonly ns: string;
  enabled = false;
  mods: Record<MobileModifier, ModState> = { ctrl: 0, alt: 0 };
  // The leader chord this deployment is driven by, and whether it is
  // currently armed. See sendPrefix.
  prefix: KeyChord | null;
  prefixPending = false;
  inset = 0;
  // Whether the software keyboard is believed to be up. See markKeyboard
  // for who gets to say.
  kbOpen = false;
  private vk: VirtualKeyboardLike | null = null;
  private vv: VisualViewport | null = null;
  private vkInset = 0;
  private vvInset = 0;
  private insetPending = false;
  private listeners: Listener[] = [];
  private buttons = new Map<string, HTMLButtonElement>();
  // The bar's rows, top first.
  private rows: BarRow[] = [];
  private rowsOpen = true;
  // The frame a flick is being carried on, and the deadline after a
  // gesture within which a keyboard that vanishes is assumed to have
  // been taken rather than dismissed. See installBarTouch and
  // armKeyboardRescue.
  private glideFrame = 0;
  private rescueUntil = 0;
  private readonly encode: (spec: EncodableKey, mods: KeyMods) => string | null;
  private readonly storeKey: string;
  private styleEl?: HTMLStyleElement;
  private bar?: HTMLElement;
  private barObserver?: ResizeObserver;
  private barHeight?: number;
  private modButtons: Partial<Record<MobileModifier, HTMLButtonElement>> = {};
  private specs = new Map<HTMLButtonElement, BarSpec>();
  private keyboardBtn?: HTMLButtonElement;
  private foldBtn?: HTMLButtonElement;
  private prefixBtn?: HTMLButtonElement;

  constructor(host: KeyBarHost, options: KeyBarOptions | undefined, ns: string) {
    this.host = host;
    this.options = options || {};
    this.ns = ns;
    this.prefix = this.options.prefix || null;
    this.encode =
      typeof host.encodeKey === 'function'
        ? (spec, mods) => host.encodeKey!(spec, mods)
        : encodeKeySpec;
    this.storeKey = `${this.options.storagePrefix || ns}.keybar.rows`;
  }

  install(): this {
    this.enabled = true;
    document.body.classList.add(`${this.ns}-touch`);
    this.injectStyle();
    // keyBar: false leaves out the strip but keeps everything else: a
    // page with touch controls of its own still wants the software
    // keyboard measured and reserved, and still wants the sticky
    // modifiers it can drive from those controls.
    if (this.options.keyBar !== false) this.buildBar();
    this.installViewport();
    this.measureBar();
    return this;
  }

  private on<E extends Event>(
    target: EventTarget,
    type: string,
    fn: (e: E) => void,
    opts?: AddEventListenerOptions | boolean,
  ): void {
    const listener = fn as unknown as EventListener;
    target.addEventListener(type, listener, opts);
    this.listeners.push([target, type, listener, opts]);
  }

  private injectStyle(): void {
    const el = document.createElement('style');
    el.id = `${this.ns}-mobile-style`;
    el.textContent = keyBarStyle(this.ns);
    document.head.appendChild(el);
    this.styleEl = el;
  }

  private ready(): boolean {
    return typeof this.host.isReady === 'function' ? !!this.host.isReady() : true;
  }

  /**
   * Whether transformInput has anything to do.
   *
   * A host that decodes its outbound bytes to call transformInput needs
   * a way to skip that on the common path, and this is it. It lives here
   * rather than in the host because the list of things the bar might be
   * holding is the bar's to know: the host that re-derived it missed the
   * leader latch when that was added, and swallowed it silently.
   */
  get pending(): boolean {
    return this.mods.ctrl > 0 || this.mods.alt > 0 || this.prefixPending;
  }

  private focusEl(): HTMLElement | null {
    return typeof this.host.focusTarget === 'function' ? this.host.focusTarget() || null : null;
  }

  // --- sticky modifiers -----------------------------------------------

  /**
   * Fold the armed modifiers into terminal input on its way out.
   *
   * On a touch screen you cannot hold Ctrl and press a letter, so Ctrl is
   * a state rather than a held key: one tap arms it for the next
   * keystroke, a second tap locks it until tapped off. A host whose
   * terminal does its own key encoding has no key event left to modify by
   * the time it can see the keystroke, so it modifies the bytes instead,
   * which is what this does. With nothing armed it returns what it was
   * given.
   *
   * Only a single character and a single bare cursor key are rewritten,
   * and only those consume the armed modifier. Everything else that
   * reaches the input path is not a keystroke at all: a mouse report, a
   * paste, a reply to a device query. Spending an armed Ctrl on one of
   * those would take it away from the key the user is about to press.
   */
  transformInput(text: string): string {
    if (!this.mods.ctrl && !this.mods.alt && !this.prefixPending) return text;
    if (typeof text !== 'string' || text.length === 0) return text;
    const mods = { ctrl: this.mods.ctrl > 0, alt: this.mods.alt > 0, shift: false };

    // The same test decides both questions. What counts as a keystroke
    // for spending an armed modifier is what counts as the key that
    // finishes a leader chord, and everything else on this path is a
    // mouse report, a paste or a device-query reply.
    const chars = Array.from(text);
    if (chars.length === 1) {
      this.consumeOneShot();
      this.setPrefixPending(false);
      const ch = mods.ctrl ? ctrlByte(chars[0]) : chars[0];
      return (mods.alt ? '\x1b' : '') + ch;
    }
    const bare = BARE_CSI.exec(text);
    if (bare) {
      this.consumeOneShot();
      this.setPrefixPending(false);
      return `\x1b[1;${modifierParam(mods)}${bare[1]}`;
    }
    return text;
  }

  /**
   * The same fold one level up, for a host that encodes key events
   * itself: returns an event-shaped object with the armed modifiers in
   * it. Returns the event unchanged when nothing is armed, so on a
   * desktop it costs two property reads.
   */
  wrapKey<T extends KeyLike>(e: T): T | WrappedKey {
    if (BARE_MODIFIERS.has(e.key)) return e;
    // Before the early exit, so a key typed on the software keyboard
    // clears the leader light whether or not a modifier is armed.
    if (this.prefixPending) this.setPrefixPending(false);
    if (!this.mods.ctrl && !this.mods.alt) return e;
    const shim: WrappedKey = {
      key: e.key,
      code: e.code,
      ctrlKey: !!e.ctrlKey || this.mods.ctrl > 0,
      altKey: !!e.altKey || this.mods.alt > 0,
      shiftKey: !!e.shiftKey,
      metaKey: !!e.metaKey,
    };
    this.consumeOneShot();
    return shim;
  }

  private consumeOneShot(): void {
    let changed = false;
    for (const name of ['ctrl', 'alt'] as const) {
      if (this.mods[name] === 1) {
        this.mods[name] = 0;
        changed = true;
      }
    }
    if (changed) this.refreshMods();
  }

  private cycleMod(name: MobileModifier): void {
    this.mods[name] = ((this.mods[name] + 1) % 3) as ModState;
    this.refreshMods();
  }

  private clearMods(): void {
    this.mods.ctrl = 0;
    this.mods.alt = 0;
    this.refreshMods();
  }

  private refreshMods(): void {
    for (const [name, btn] of Object.entries(this.modButtons) as [MobileModifier, HTMLButtonElement][]) {
      btn.classList.toggle('armed', this.mods[name] === 1);
      btn.classList.toggle('locked', this.mods[name] === 2);
    }
  }

  // --- the bar ---------------------------------------------------------

  /**
   * The rows to draw, as declared or as inferred from the older
   * single-row options.
   *
   * A caller that says nothing gets one row of DEFAULT_KEYS. Whatever the
   * source, the page's own `actions` join the last row behind a divider,
   * because that row is the one at thumb height.
   */
  private resolveRows(): { label?: string; collapsible?: boolean; keys: BarSpec[] }[] {
    const declared: readonly { label?: string; collapsible?: boolean; keys?: readonly BarSpec[] }[] =
      Array.isArray(this.options.rows) && this.options.rows.length
        ? this.options.rows
        : [{ keys: this.options.keys || DEFAULT_KEYS }];
    const rows = declared
      .map((row) => ({ ...row, keys: (row.keys || []).filter((s) => this.usable(s)) }))
      .filter((row) => row.keys.length);
    const actions = this.options.actions || [];
    if (actions.length) {
      const last = rows[rows.length - 1] || { keys: [] as BarSpec[] };
      if (!rows.length) rows.push(last);
      last.keys = last.keys.concat(
        [{ sep: true }],
        actions.map((s) => ({ ...s, action: true })),
      );
    }
    return rows;
  }

  /**
   * Whether a button can do anything here.
   *
   * A prefix key with no prefix configured is the one button that would
   * be a lie: it would light up and arm a chord that is never sent. It
   * is left out instead, so a key set written for a leader-driven
   * program degrades to its plain keys rather than to a dead control.
   */
  private usable(spec: BarSpec): boolean {
    return !(spec.prefix && !this.prefix);
  }

  private buildBar(): void {
    const ns = this.ns;
    const bar = document.createElement('div');
    bar.id = `${ns}-keybar`;
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Terminal keys');
    this.modButtons = {};
    // Which button is which key. The touch handling is one delegated
    // set of listeners on the bar rather than a set per button, because
    // a pan starts wherever the thumb lands: on a button, on the
    // divider, in a 3px gap.
    this.specs = new Map();

    const rowsEl = document.createElement('div');
    rowsEl.id = `${ns}-keybar-rows`;
    const declared = this.resolveRows();
    declared.forEach((row, i) => this.buildRow(rowsEl, row, i));
    bar.appendChild(rowsEl);

    const pin = document.createElement('div');
    pin.id = `${ns}-keybar-pin`;
    if (this.rows.some((r) => r.collapsible)) {
      pin.appendChild(this.buildButton(FOLD_KEY));
    }
    if (this.options.keyboardKey !== false && this.focusEl()) {
      pin.appendChild(this.buildButton(KEYBOARD_KEY));
    }
    if (pin.childElementCount) bar.appendChild(pin);

    // Anything inside the bar that manages to take focus takes the
    // software keyboard down with it, and this fires inside the gesture
    // that did it, so asking for focus back still counts as
    // user-initiated.
    this.on(bar, 'focusin', () => this.keepFocus());
    // The default action of a press is "focus what was pressed, or
    // clear focus if it is not focusable", and that is the keyboard
    // gone. The buttons cancel it themselves; this is for everything
    // else in the bar, which is to say the dividers, the gaps and the
    // padding around the strip. Capture, because a stray listener that
    // stops propagation must not be able to open the hole again.
    const swallow = (e: Event) => e.preventDefault();
    this.on(bar, 'mousedown', swallow, { capture: true });
    this.on(bar, 'contextmenu', swallow, { capture: true });
    this.on(bar, 'dragstart', swallow, { capture: true });

    (this.options.container || document.body).appendChild(bar);
    this.bar = bar;
    this.installBarTouch();
    if (typeof ResizeObserver === 'function') {
      this.barObserver = new ResizeObserver(() => {
        this.measureBar();
        this.refreshScrollHints();
      });
      this.barObserver.observe(bar);
    }
    for (const row of this.rows) {
      this.on(row.scroll, 'scroll', () => this.refreshScrollHints(), { passive: true });
      // A trackpad or a mouse wheel on a touch laptop, where the bar
      // exists but nothing ever touches it. The box has no scrollbar
      // and no native scrolling of its own, so this is the only way
      // it moves without a finger.
      this.on<WheelEvent>(row.scroll, 'wheel', (e) => {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (!d) return;
        e.preventDefault();
        this.panBy(row.scroll, d);
      }, { passive: false });
      if (this.barObserver) this.barObserver.observe(row.scroll);
    }
    this.applyRowsOpen(this.readRowsOpen());
    this.refreshScrollHints();
  }

  /**
   * One row: a wrapper the edge fades hang off, and the box that is
   * panned.
   *
   * The buttons are appended flat rather than in group elements: a
   * wrapper would need display:contents to keep the flex layout, and a
   * box with no box of its own is exactly the thing screen readers
   * disagree about. The grouping is carried by the row, the divider, the
   * tint and the labels.
   */
  private buildRow(
    parent: HTMLElement,
    row: { label?: string; collapsible?: boolean; keys: BarSpec[] },
    index: number,
  ): void {
    const wrap = document.createElement('div');
    wrap.className = `${this.ns}-keybar-row`;
    if (row.collapsible) wrap.classList.add('collapsible');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', row.label || `Row ${index + 1}`);

    const scroll = document.createElement('div');
    scroll.className = `${this.ns}-keybar-scroll`;
    for (const spec of row.keys) {
      if (spec.sep) {
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.setAttribute('aria-hidden', 'true');
        scroll.appendChild(sep);
        continue;
      }
      const btn = this.buildButton(spec);
      // A chord is not a keystroke into whatever is being typed: it
      // is a command, and one of them may well close something. The
      // tint is the cheapest way to say so in a strip this small,
      // and it is the same one the page's own actions get.
      if (spec.action || spec.prefix || spec.prefixed) btn.classList.add('action');
      scroll.appendChild(btn);
    }

    wrap.appendChild(scroll);
    parent.appendChild(wrap);
    this.rows.push({ el: wrap, scroll, collapsible: !!row.collapsible });
  }

  /**
   * One bar button. The touch path is not here: see installBarTouch.
   *
   * What is here is the mouse, and pointer events drive that case only.
   * On a touch device they duplicate the touch sequence, and acting on
   * both would fire every button twice.
   */
  private buildButton(spec: BarSpec): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = spec.label ?? '';
    btn.title = spec.title || spec.label || '';
    btn.setAttribute('aria-label', spec.title || spec.label || '');
    if (spec.narrow) btn.classList.add('narrow');
    if (spec.fold) btn.classList.add('fold');
    if (spec.mod) this.modButtons[spec.mod] = btn;
    if (spec.keyboard) this.keyboardBtn = btn;
    if (spec.fold) this.foldBtn = btn;
    if (spec.prefix) this.prefixBtn = btn;
    if (spec.id) this.buttons.set(spec.id, btn);
    // Nothing in the bar is in the focus order. A button that can be
    // focused is a button that can hold the focus the software keyboard
    // is riding on.
    btn.tabIndex = -1;
    this.specs.set(btn, spec);

    const mouseTap = (e: MouseEvent) => {
      const pointerType = (e as PointerEvent).pointerType;
      if (pointerType && pointerType !== 'mouse' && pointerType !== 'pen') return;
      e.preventDefault();
      this.tapBarKey(spec);
      if (!spec.keyboard) this.keepFocus();
    };
    if (typeof PointerEvent === 'function') {
      this.on(btn, 'pointerdown', mouseTap);
    } else {
      this.on(btn, 'mousedown', mouseTap);
    }
    this.on(btn, 'click', (e) => e.preventDefault());
    return btn;
  }

  /**
   * The bar's scrolling, done by hand.
   *
   * The obvious way to make a row of buttons scroll is overflow-x: auto
   * and let the browser do it, and that costs the software keyboard. A
   * native touch scroll is a gesture the page has already lost by the time
   * it can see it: touchmove and touchend arrive with cancelable false,
   * the browser owns the sequence, and browsers do things to the software
   * keyboard when a scroll starts under it. Emulation shows none of that.
   * The two fixes look irreconcilable from there, because cancelling the
   * touch sequence is exactly what keeps the keyboard up, and cancelling
   * it is exactly what stops a native scroll.
   *
   * They are only irreconcilable while the browser is the one scrolling.
   * So it is not: the strip is overflow: hidden, the whole bar is
   * touch-action: none, every touch on it is cancelled at touchstart, and
   * the pan is done here by assigning scrollLeft, which an overflow:
   * hidden box still honours. The browser is left with no gesture to
   * interpret, so it has no scroll to dismiss the keyboard for, and focus
   * never moves because the sequence that would have moved it never
   * completed.
   *
   * Do not replace this with compat-mouse-event suppression. That theory
   * was measured and was wrong; the non-cancellable native scroll is the
   * mechanism.
   *
   * The tap guard comes with it: a tap is a touch that ended within
   * BAR_TAP_SLOP_PX of where it started, on the button it started on. A
   * flick past a button cannot fire it.
   */
  private installBarTouch(): void {
    const bar = this.bar!;
    interface Gesture {
      id: number;
      x0: number;
      y0: number;
      x: number;
      anchor: number;
      from: number;
      at: number;
      v: number;
      moved: boolean;
      btn: HTMLButtonElement | null;
      spec: BarSpec | null;
      scroller: HTMLElement | null;
    }
    let g: Gesture | null = null;

    const find = (e: TouchEvent): Touch | null => {
      for (const t of Array.from(e.changedTouches)) if (g && t.identifier === g.id) return t;
      return null;
    };
    const release = (): Gesture | null => {
      if (g && g.btn) g.btn.classList.remove('pressed');
      const a = g;
      g = null;
      return a;
    };

    this.on<TouchEvent>(bar, 'touchstart', (e) => {
      // Cancelling here is the whole fix. It is also what makes the
      // rest of this function necessary.
      if (e.cancelable) e.preventDefault();
      // A second finger on a toolbar is a mistake, not a gesture. The
      // first one keeps the pan.
      if (g) return;
      this.stopGlide();
      const t = e.changedTouches[0];
      const hit = e.target instanceof Element ? e.target : null;
      const btn = hit ? hit.closest('button') : null;
      // The row the finger landed on is the row that pans, so each
      // strip scrolls on its own. A touch that started on a pinned
      // key, or on the bar's own padding, is over no row at all and
      // is a press or nothing.
      const scroller = hit ? hit.closest<HTMLElement>(`.${this.ns}-keybar-scroll`) : null;
      g = {
        id: t.identifier,
        x0: t.clientX, y0: t.clientY, x: t.clientX,
        anchor: t.clientX, from: scroller ? scroller.scrollLeft : 0,
        at: performance.now(), v: 0, moved: false,
        btn, spec: btn ? this.specs.get(btn) || null : null,
        scroller,
      };
      if (btn) btn.classList.add('pressed');
    }, { passive: false });

    this.on<TouchEvent>(bar, 'touchmove', (e) => {
      if (!g) return;
      const t = find(e);
      if (!t) return;
      if (e.cancelable) e.preventDefault();
      if (!g.moved && Math.hypot(t.clientX - g.x0, t.clientY - g.y0) > BAR_TAP_SLOP_PX) {
        g.moved = true;
        // The pan starts from where the finger is now, not from
        // where it went down, or crossing the threshold would jump
        // the strip by the slop.
        g.anchor = t.clientX;
        g.from = g.scroller ? g.scroller.scrollLeft : 0;
        if (g.btn) g.btn.classList.remove('pressed');
      }
      const now = performance.now();
      const dt = now - g.at;
      if (dt > 0) {
        // Smoothed, because one sample of a finger is noise and the
        // flick is judged on the last of them.
        g.v = 0.7 * ((t.clientX - g.x) / dt) + 0.3 * g.v;
        g.at = now;
      }
      g.x = t.clientX;
      if (g.moved && g.scroller) this.panTo(g.scroller, g.from - (t.clientX - g.anchor));
    }, { passive: false });

    this.on<TouchEvent>(bar, 'touchend', (e) => {
      if (!g || !find(e)) return;
      if (e.cancelable) e.preventDefault();
      const a = release()!;
      if (!a.moved) {
        if (a.spec) this.tapBarKey(a.spec);
      } else if (a.scroller) {
        this.glide(a.scroller, -a.v);
      }
      // Inside the gesture, which is the only context in which asking
      // for focus brings the keyboard back rather than being ignored.
      // Skipped for the keyboard key itself, whose whole job is to
      // take focus away.
      if (!(a.spec && a.spec.keyboard)) {
        this.keepFocus();
        this.armKeyboardRescue();
      }
    }, { passive: false });

    this.on(bar, 'touchcancel', () => { release(); }, { passive: true });
  }

  /** Move a strip to an offset, clamped by the box itself. */
  private panTo(scroller: HTMLElement, left: number): void {
    if (!scroller) return;
    scroller.scrollLeft = left;
    this.refreshScrollHints();
  }

  private panBy(scroller: HTMLElement, dx: number): void {
    if (!scroller) return;
    scroller.scrollLeft += dx;
    this.refreshScrollHints();
  }

  /**
   * Carry a flick on after the finger has gone. v is px per millisecond.
   *
   * One glide at a time across the whole bar: flicking a second row
   * stops the first, because two strips moving under a stationary finger
   * is the layout shifting on its own.
   */
  private glide(scroller: HTMLElement, v: number): void {
    this.stopGlide();
    if (!scroller || Math.abs(v) < BAR_GLIDE_MIN_V) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(now - last, 32);
      last = now;
      const before = scroller.scrollLeft;
      this.panBy(scroller, v * dt);
      // The end of the strip stops the glide: the box clamped what it
      // was given, so nothing moved.
      if (scroller.scrollLeft === before) return;
      v *= Math.pow(BAR_GLIDE_DECAY, dt / 16);
      if (Math.abs(v) < BAR_GLIDE_MIN_V) return;
      this.glideFrame = requestAnimationFrame(step);
    };
    this.glideFrame = requestAnimationFrame(step);
  }

  private stopGlide(): void {
    if (this.glideFrame) cancelAnimationFrame(this.glideFrame);
    this.glideFrame = 0;
  }

  /**
   * Light each row's edge fade on whichever side has buttons off
   * screen, and say whether the rows fit at all.
   *
   * A row that fits is centred and a bar whose rows all fit pulls the
   * pinned keys in beside them; see the .fits rules in the styles. That is
   * decided here rather than in CSS because overflow is not something a
   * selector can ask about, and it is re-asked on every resize of the
   * bar or a row, so a rotation that stops a row fitting hands it back
   * to the left-anchored scroller before anything is centred out of
   * reach. A folded row has no width and counts as fitting.
   */
  private refreshScrollHints(): void {
    let all = true;
    for (const { el, scroll } of this.rows) {
      const max = scroll.scrollWidth - scroll.clientWidth;
      const fits = max <= 2;
      el.classList.toggle('more-left', scroll.scrollLeft > 2);
      el.classList.toggle('more-right', !fits && scroll.scrollLeft < max - 2);
      el.classList.toggle('fits', fits);
      if (!fits) all = false;
    }
    if (this.bar) this.bar.classList.toggle('fits', all);
  }

  // --- folding ----------------------------------------------------------

  /**
   * Whether the collapsible rows were left open. Anything but the stored
   * '0' means open, so a corrupt or unreadable value fails towards the
   * bar the deployment declared rather than towards a hidden one.
   */
  private readRowsOpen(): boolean {
    try {
      return localStorage.getItem(this.storeKey) !== '0';
    } catch {
      return true; // private mode
    }
  }

  setRowsOpen(open: boolean): void {
    this.applyRowsOpen(open);
    try {
      localStorage.setItem(this.storeKey, open ? '1' : '0');
    } catch {
      /* private mode: the fold still works, it is just not remembered */
    }
  }

  /** Fold or unfold without recording the answer, for the initial restore. */
  private applyRowsOpen(open: boolean): void {
    this.rowsOpen = !!open;
    if (this.bar) this.bar.classList.toggle('folded', !this.rowsOpen);
    const btn = this.foldBtn;
    if (btn) {
      btn.textContent = this.rowsOpen ? '▾' : '▴';
      btn.title = this.rowsOpen ? 'Hide the extra rows' : 'Show the extra rows';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-expanded', this.rowsOpen ? 'true' : 'false');
    }
    // The bar just changed height, and the terminal is sized from it.
    this.measureBar();
    this.refreshScrollHints();
  }

  private measureBar(): void {
    if (!this.bar) return;
    const h = Math.round(this.bar.getBoundingClientRect().height);
    if (h === this.barHeight) return;
    this.barHeight = h;
    document.documentElement.style.setProperty(`--${this.ns}-keybar-h`, `${h}px`);
  }

  /** Mark a button by id: '', 'active', 'armed' or 'locked'. */
  setState(id: string, state: '' | 'active' | 'armed' | 'locked'): void {
    const btn = this.buttons.get(id);
    if (!btn) return;
    for (const c of ['active', 'armed', 'locked']) btn.classList.toggle(c, state === c);
  }

  private tapBarKey(spec: BarSpec): void {
    if (spec.mod) {
      this.cycleMod(spec.mod);
      return;
    }
    if (spec.keyboard) {
      this.toggleKeyboard();
      return;
    }
    if (spec.fold) {
      this.setRowsOpen(!this.rowsOpen);
      return;
    }
    if (typeof spec.run === 'function') {
      spec.run(this);
      return;
    }
    if (spec.prefix) {
      this.tapPrefix();
      return;
    }
    if (spec.prefixed) {
      this.pressChord(spec);
      return;
    }
    this.pressKey(spec);
  }

  // --- the leader chord -------------------------------------------------

  /**
   * Send the configured leader, as a keystroke rather than as bytes.
   *
   * It goes through the same encoder every other button uses, so a host
   * that speaks a protocol of its own encodes the leader in it too
   * instead of receiving a hand-written control byte that its terminal
   * would have framed differently.
   *
   * Reports whether anything went out, which is false when no prefix is
   * configured.
   */
  sendPrefix(): boolean {
    if (!this.prefix || !this.ready()) return false;
    const bytes = this.encode(this.prefix, {
      ctrl: !!this.prefix.ctrl,
      alt: !!this.prefix.alt,
      shift: !!this.prefix.shift,
    });
    if (!bytes) return false;
    this.host.send(bytes);
    return true;
  }

  /**
   * The prefix button: send the leader and light up until the next key.
   *
   * This is what makes a chord the bar has no button for reachable at
   * all: tap it, then type the second half on the software keyboard.
   * The light is a mirror of what the program was told, which is why
   * tapping it a second time sends a second leader rather than quietly
   * going dark. Every program with a leader defines what a doubled one
   * means (tmux and tuios take it as cancel, or as the literal leader
   * for a nested session); none of them define what happens when the bar
   * lies about the state.
   */
  private tapPrefix(): void {
    if (!this.prefix) return;
    // A chord is a fixed sequence, so a locked Ctrl is cleared rather
    // than folded into it. Ctrl+B then Ctrl+C is a different chord
    // from Ctrl+B then C, and the user pressed one button.
    this.clearMods();
    if (!this.sendPrefix()) return;
    this.setPrefixPending(!this.prefixPending);
  }

  private setPrefixPending(on: boolean): void {
    this.prefixPending = !!on;
    if (this.prefixBtn) this.prefixBtn.classList.toggle('armed', this.prefixPending);
  }

  /**
   * One tap for a whole chord: the leader, then this key on its own.
   *
   * The leader is skipped when the user already armed it by hand, so
   * tapping prefix and then a chord button does not send it twice. That
   * is safe because the latch is cleared by every key that goes out, so
   * it can only still be set when nothing at all has been sent since the
   * tap that set it.
   *
   * With no prefix configured this sends the bare key, which is the
   * honest degradation: the button still means what its label says for a
   * program that binds the key directly.
   *
   * The modifiers the button declares are its own, and are sent with it.
   * The bar's armed ones are not: a chord is a fixed sequence and the
   * user pressed one button, so tmux's Ctrl+B then Ctrl+O has to be
   * reachable as {key: 'o', ctrl: true} and must not become Ctrl+B then
   * Ctrl+Ctrl+O because Ctrl happened to be latched. Those are two
   * different things and only the first is what the button says.
   */
  private pressChord(spec: BarSpec): void {
    if (!this.ready()) return;
    this.clearMods();
    if (!this.prefixPending) this.sendPrefix();
    this.setPrefixPending(false);
    const mods = {
      ctrl: !!spec.ctrl,
      alt: !!spec.alt,
      shift: !!spec.shift,
    };
    const bytes = this.encode({ key: spec.key, code: spec.code, ...mods }, mods);
    if (bytes) this.host.send(bytes);
  }

  /**
   * Synthesise a key press with the armed modifiers applied.
   *
   * A key that carries a modifier of its own, which is how a button says
   * "^C", gets it on top of whatever is armed rather than instead of it.
   */
  private pressKey(spec: BarSpec): void {
    if (!this.ready()) return;
    const mods = {
      ctrl: this.mods.ctrl > 0 || !!spec.ctrl,
      alt: this.mods.alt > 0 || !!spec.alt,
      shift: !!spec.shift,
    };
    const bytes = this.encode(spec, mods);
    this.consumeOneShot();
    if (!bytes) return;
    this.host.send(bytes);
    // A key went to the program, so it has consumed whatever leader
    // was pending.
    this.setPrefixPending(false);
  }

  // --- the software keyboard -------------------------------------------

  /**
   * Raise the software keyboard. Must be called inside a user gesture.
   *
   * Asking an element that already holds focus to focus is a no-op, and
   * no browser raises a keyboard for a no-op. That is the state a tap
   * on the terminal finds after the page loads: the terminal took focus
   * on its own, which is not a gesture, so the keyboard never came up,
   * and it is the state the Android back button leaves behind, which
   * takes the keyboard away and leaves focus where it was. In both the
   * only way to ask again is to leave and come back, so when the bar
   * believes the keyboard is down that is what this does. When it
   * believes the keyboard is up the plain focus is kept, because a
   * blur would take the keyboard down for a tap that meant to place
   * the cursor.
   */
  focusInput(): void {
    const el = this.focusEl();
    if (!el) return;
    if (document.activeElement === el && !this.inset && !this.kbOpen) {
      el.blur();
    }
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  }

  /** Put focus back on the focus target. Call inside a user gesture. */
  private keepFocus(): void {
    const el = this.focusEl();
    if (!el || document.activeElement === el) return;
    this.focusInput();
  }

  private toggleKeyboard(): void {
    const el = this.focusEl();
    if (!el) return;
    if (document.activeElement !== el) {
      this.focusInput();
      this.setKeyboardOpen(true);
      return;
    }
    // Focused with the keyboard down is the state the page loads in:
    // the terminal took focus on its own, which is not a gesture, and
    // no browser raises a keyboard for that. Asking an already
    // focused element to focus is a no-op, so the way to ask for the
    // keyboard from here is to leave and come back. Without this the
    // first tap on this key would only spend itself dropping focus
    // the user could not see.
    if (!this.kbOpen) {
      el.blur();
      this.focusInput();
      this.setKeyboardOpen(true);
      return;
    }
    // Asked for, so the keyboard going away is not something to rescue
    // it from. See armKeyboardRescue.
    this.rescueUntil = 0;
    el.blur();
    this.setKeyboardOpen(false);
  }

  private setKeyboardOpen(open: boolean): void {
    this.markKeyboard(open);
    // A keyboard that closes takes its inset with it, and not every
    // browser says so: iOS fires a visualViewport resize, but a blur
    // triggered from JS sometimes does not. Zero it here and let the
    // next measurement correct it.
    if (!open) {
      this.vkInset = 0;
      this.vvInset = 0;
      this.applyInset();
    }
    this.measureBar();
  }

  /**
   * Record whether the keyboard is up: the body class and the label on
   * the keyboard key. Nothing else. The class is what the page styles
   * by and the label is what the user reads, so both have to say what
   * is true, and what is true is decided in two places: focus gained
   * inside a gesture (the browser is about to raise the keyboard) and
   * the inset (the keyboard is measurably there, or measurably gone).
   * Focus alone is not enough. The page focuses the terminal on load,
   * which raises nothing, and the Android back button dismisses the
   * keyboard and leaves focus where it was.
   */
  private markKeyboard(open: boolean): void {
    this.kbOpen = !!open;
    document.body.classList.toggle(`${this.ns}-kb-open`, this.kbOpen);
    const btn = this.keyboardBtn;
    if (btn) {
      btn.classList.toggle('active', this.kbOpen);
      btn.textContent = this.kbOpen ? 'hide' : 'abc';
    }
  }

  /**
   * The net under keepFocus, for the browsers that take the keyboard away
   * without taking the focus with it.
   *
   * A browser that blurs the focus target is caught by keepFocus, because
   * focus is observable. A browser that leaves focus alone and merely
   * hides the keyboard is not: activeElement still names the element, and
   * asking an already focused element to focus is a no-op, so there is
   * nothing to notice. What is observable is the inset: the keyboard was
   * measurably covering part of the window before the gesture and
   * measurably is not after it, which no browser does on its own except
   * by hiding it.
   *
   * Armed only at the end of a bar gesture, only while the focus target
   * still holds focus, and only when there was an inset to lose, so a
   * browser that reports no inset at all can never trigger it and neither
   * can the key whose job is to put the keyboard away.
   */
  private armKeyboardRescue(): void {
    const el = this.focusEl();
    if (!el || document.activeElement !== el) return;
    if (!this.inset) return;
    this.rescueUntil = performance.now() + KB_RESCUE_MS;
  }

  /**
   * The inset just went to zero. Was it ours to lose? Reports whether
   * the keyboard was asked for again.
   */
  private maybeRescueKeyboard(): boolean {
    if (!this.rescueUntil || performance.now() > this.rescueUntil) return false;
    this.rescueUntil = 0;
    const el = this.focusEl();
    if (!el) return false;
    if (document.activeElement !== el) {
      // A blur that arrived after the gesture ended, too late for the
      // touchend to have caught it.
      this.focusInput();
      return true;
    }
    // Focus never moved, so the keyboard went without it. The only way
    // to ask for one on an already focused element is to leave and come
    // back.
    el.blur();
    this.focusInput();
    return true;
  }

  /**
   * Work out how much of the window the software keyboard is covering.
   *
   * Two APIs, because no one browser has both:
   *
   *   VirtualKeyboard API. Chromium on Android. Asking for
   *   overlaysContent means the browser stops resizing anything and
   *   instead reports the keyboard's rectangle, which is the only way to
   *   get an exact number.
   *
   *   visualViewport. What Safari on iOS has. The keyboard does not
   *   change the layout viewport there, only the visual one, so the
   *   difference between them is the keyboard.
   *
   * Whichever reports more wins, rather than whichever exists. They
   * cannot double-count, because it is a max and not a sum, and either
   * one reading zero is exactly what "this browser resized the layout for
   * me already" looks like: window.innerHeight has shrunk too, so the
   * difference is zero and there is nothing left to reserve.
   *
   * If both are absent or wrong the inset stays 0 and the terminal is the
   * size of the window, which is what it was before this module existed:
   * the keyboard covers the bottom rows, which is survivable. Everything
   * here is written so that a bad measurement costs space, never layout.
   */
  private installViewport(): void {
    this.vkInset = 0;
    this.vvInset = 0;

    const vk = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboardLike }).virtualKeyboard;
    if (vk && 'overlaysContent' in vk) {
      try {
        vk.overlaysContent = true;
        this.vk = vk;
        this.on(vk, 'geometrychange', () => {
          const r = vk.boundingRect;
          this.vkInset = r ? r.height : 0;
          this.applyInset();
        });
      } catch {
        this.vk = null;
      }
    }

    const vv = window.visualViewport;
    if (vv) {
      this.vv = vv;
      const onChange = () => {
        this.measureViewport();
        // iOS scrolls the layout viewport to reveal the focused
        // element when the keyboard opens. The page is a fixed
        // layout, so that only pushes the terminal off the top.
        if (window.scrollY !== 0) window.scrollTo(0, 0);
      };
      this.on(vv, 'resize', onChange);
      this.on(vv, 'scroll', onChange);
    }

    // The layout viewport changing size is the one event neither API
    // above delivers, and it is what a browser that resizes the layout
    // for the keyboard itself fires when the keyboard goes: Firefox on
    // Android, and Chromium honouring interactive-widget. The visual
    // viewport difference measured a moment earlier can then name a
    // keyboard that is no longer there, so everything is measured
    // again from the current numbers. Idempotent, so a browser that
    // fires both costs nothing.
    this.on(window, 'resize', () => this.remeasure());

    // Rotating the phone changes everything at once and neither API is
    // guaranteed to fire, so remeasure after the orientation settles.
    this.on(window, 'orientationchange', () => {
      setTimeout(() => this.remeasure(), 250);
    });

    const el = this.focusEl();
    if (el) {
      // Focus gained inside a gesture is a keyboard about to be
      // raised. Focus gained any other way, which is the page
      // focusing the terminal on load, raises nothing, and a bar
      // that said "hide" next to a keyboard that was never there
      // is what this used to do. A browser without userActivation
      // keeps the old reading.
      this.on(el, 'focus', () => {
        const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
        if (ua && !ua.isActive) return;
        this.markKeyboard(true);
      });
      this.on(el, 'blur', () => this.setKeyboardOpen(false));
    }
  }

  /** Read the visual viewport's share of the window. */
  private measureViewport(): void {
    const vv = this.vv;
    if (!vv) return;
    this.vvInset = window.innerHeight - vv.height - vv.offsetTop;
    this.applyInset();
  }

  /**
   * Measure everything again from the numbers as they stand now: both
   * keyboard readings, the bar and whether its rows fit.
   */
  private remeasure(): void {
    if (this.vk) {
      const r = this.vk.boundingRect;
      this.vkInset = r ? r.height : 0;
    }
    if (this.vv) {
      this.vvInset = window.innerHeight - this.vv.height - this.vv.offsetTop;
    }
    this.applyInset();
    this.measureBar();
    this.refreshScrollHints();
  }

  private applyInset(): void {
    this.setInset(Math.max(this.vkInset || 0, this.vvInset || 0));
  }

  private setInset(px: number): void {
    const max = (window.innerHeight || 0) * INSET_MAX_FRACTION;
    let v = Math.round(px || 0);
    if (!Number.isFinite(v) || v < INSET_MIN_PX) v = 0;
    if (v > max) v = Math.round(max);
    if (v === this.inset) return;
    // A keyboard that was there and is not any more. If a bar gesture
    // has just ended, it did not go of its own accord. Otherwise it
    // was dismissed, by the back button or the keyboard's own key,
    // and focus is still where it was: the only sign is this one, so
    // this is where the bar learns the keyboard is down. A keyboard
    // that is measurably there is up whatever focus said.
    const lost = this.inset > 0 && v === 0;
    this.inset = v;
    if (v > 0) {
      this.markKeyboard(true);
    } else if (lost && !this.maybeRescueKeyboard()) {
      this.markKeyboard(false);
    }
    if (this.insetPending) return;
    this.insetPending = true;
    requestAnimationFrame(() => {
      this.insetPending = false;
      document.documentElement.style.setProperty(`--${this.ns}-kb-inset`, `${this.inset}px`);
      this.measureBar();
    });
  }

  destroy(): void {
    for (const [target, type, fn, opts] of this.listeners) {
      target.removeEventListener(type, fn, opts);
    }
    this.listeners = [];
    this.stopGlide();
    this.rescueUntil = 0;
    this.rows = [];
    this.prefixPending = false;
    if (this.barObserver) this.barObserver.disconnect();
    if (this.bar) this.bar.remove();
    if (this.styleEl) this.styleEl.remove();
    document.body.classList.remove(`${this.ns}-touch`, `${this.ns}-kb-open`);
    document.documentElement.style.removeProperty(`--${this.ns}-kb-inset`);
    document.documentElement.style.removeProperty(`--${this.ns}-keybar-h`);
    this.enabled = false;
  }
}

/** The no-op returned on a desktop, so the caller needs no null checks. */
function inertKeyBar(): KeyBarController {
  return {
    enabled: false,
    mods: { ctrl: 0, alt: 0 },
    prefixPending: false,
    pending: false,
    transformInput: (t) => t,
    wrapKey: (e) => e,
    setState() {},
    setRowsOpen() {},
    sendPrefix: () => false,
    focusInput() {},
    destroy() {},
  };
}

/**
 * Put up the key bar on a touch device. On any other device it installs
 * nothing and returns an inert controller.
 *
 * The namespace is checked before the device, so a bad one fails on the
 * desktop too, where it would otherwise only surface on a phone.
 */
export function installKeyBar(host: KeyBarHost, options?: KeyBarOptions): KeyBarController {
  const ns = checkNamespace(options?.namespace);
  if (!detectTouch()) return inertKeyBar();
  return new KeyBar(host, options, ns).install();
}
