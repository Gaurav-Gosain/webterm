// A fixed-position control that can be moved out of the way.

// Pointer travel that turns a press on a draggable control into a drag.
// Small enough that moving it feels immediate, large enough that a click
// with an unsteady hand is still a click.
const DRAG_SLOP_PX = 4;

export interface DraggableOptions {
  /** Where to remember the position. Omit for no persistence. */
  storageKey?: string;
  /** Pixels the control is kept clear of the viewport edge. Default 4. */
  margin?: number;
}

/**
 * Make a fixed-position control draggable, and remember where it was left.
 *
 * A control that floats over a terminal is in the way of something, and
 * which something depends on what is running: a full-screen program owns
 * every corner of the screen and the page has no way to know which one it
 * can spare. Rather than guess at a placement that is always free, this lets
 * the control be moved and keeps the answer in localStorage.
 *
 * The element keeps its own click handler and needs no other changes. The
 * pointer sequence is cancelled from pointerdown onwards, which keeps a
 * drag from selecting text, from reaching whatever is underneath, and from
 * moving focus off an element that is holding a software keyboard up; the
 * click that ends a drag is swallowed, so letting go does not also press
 * the thing.
 */
export function installDraggable(
  el: HTMLElement | null | undefined,
  opts: DraggableOptions = {},
): { destroy(): void } {
  if (!el) return { destroy() {} };
  const margin = opts.margin == null ? 4 : opts.margin;
  const key = opts.storageKey || '';

  const clamp = (x: number, y: number): [number, number] => {
    const w = el.offsetWidth || 0;
    const h = el.offsetHeight || 0;
    const maxX = Math.max(margin, window.innerWidth - w - margin);
    const maxY = Math.max(margin, window.innerHeight - h - margin);
    return [Math.min(Math.max(x, margin), maxX), Math.min(Math.max(y, margin), maxY)];
  };

  // Placing by left/top means the CSS defaults (which use right/bottom)
  // have to go, or the element would be stretched between the two.
  const place = (x: number, y: number): [number, number] => {
    const [cx, cy] = clamp(x, y);
    el.style.left = `${Math.round(cx)}px`;
    el.style.top = `${Math.round(cy)}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    return [cx, cy];
  };

  const save = (x: number, y: number) => {
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify({ x: Math.round(x), y: Math.round(y) }));
    } catch {
      /* private mode */
    }
  };

  let placed = false;
  if (key) {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || 'null');
      if (raw && Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
        place(raw.x, raw.y);
        placed = true;
      }
    } catch {
      /* corrupt or unavailable */
    }
  }

  let drag: { id: number; dx: number; dy: number; x0: number; y0: number; moved: boolean } | null = null;
  const listeners: [EventTarget, string, EventListener, AddEventListenerOptions | undefined][] = [];
  const on = <E extends Event>(target: EventTarget, type: string, fn: (e: E) => void, o?: AddEventListenerOptions) => {
    const listener = fn as unknown as EventListener;
    target.addEventListener(type, listener, o);
    listeners.push([target, type, listener, o]);
  };

  on<PointerEvent>(el, 'pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    drag = {
      id: e.pointerId,
      dx: e.clientX - r.left,
      dy: e.clientY - r.top,
      x0: e.clientX,
      y0: e.clientY,
      moved: false,
    };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety */
    }
  });

  on<PointerEvent>(el, 'pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < DRAG_SLOP_PX) return;
      drag.moved = true;
      el.classList.add('dragging');
    }
    e.preventDefault();
    place(e.clientX - drag.dx, e.clientY - drag.dy);
  });

  const end = (e?: PointerEvent) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const moved = drag.moved;
    drag = null;
    el.classList.remove('dragging');
    if (!moved) return;
    // A drag must not also be a click, or letting go would open the
    // panel it was being dragged out of the way of.
    const swallow = (ev: Event) => ev.stopPropagation();
    el.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => el.removeEventListener('click', swallow, { capture: true }), 0);
    const r = el.getBoundingClientRect();
    placed = true;
    save(r.left, r.top);
  };
  on<PointerEvent>(el, 'pointerup', end);
  on<PointerEvent>(el, 'pointercancel', end);
  // Dragging is not a text selection or a context menu, whatever the
  // browser would otherwise make of a press and a drag on a button.
  on(el, 'dragstart', (e) => e.preventDefault());
  on(el, 'contextmenu', (e) => {
    if (drag) e.preventDefault();
  });

  // A window that shrinks must not leave the control outside it, where
  // there is no way to get it back.
  on(window, 'resize', () => {
    if (!placed) return;
    const r = el.getBoundingClientRect();
    place(r.left, r.top);
  });

  return {
    destroy() {
      for (const [target, type, fn, o] of listeners) target.removeEventListener(type, fn, o);
      listeners.length = 0;
    },
  };
}
