// Main-thread input for the worker engine. It turns DOM events into small
// messages; the worker encodes them with Ghostty's key and mouse encoders,
// which read the terminal's modes directly, and writes the bytes to the
// socket. Nothing here knows about escape sequences.

const SHIFT = 1, CTRL = 2, ALT = 4, SUPER = 8;
const ACTION = { release: 0, press: 1, repeat: 2 };

export function mods(ev) {
  return (ev.shiftKey ? SHIFT : 0) | (ev.ctrlKey ? CTRL : 0) | (ev.altKey ? ALT : 0) | (ev.metaKey ? SUPER : 0);
}

// The codepoint the key gives without shift, for the kitty protocol's
// "unshifted key" field and for ctrl chords.
function unshifted(ev, text) {
  if (ev.code.startsWith('Key')) return ev.code.charCodeAt(3) + 32;
  if (ev.code.startsWith('Digit')) return ev.code.charCodeAt(5);
  return text ? text.toLowerCase().codePointAt(0) : 0;
}

/**
 * Attach keyboard, IME, paste, focus, pointer and wheel handling.
 * post(msg) sends a message to the worker. cell() returns { cw, ch } in CSS
 * pixels. Returns a detach function.
 */
export function attachInput(host, canvas, post, opts = {}) {
  const ac = new AbortController();
  const on = (el, type, fn, o = {}) => el.addEventListener(type, fn, { ...o, signal: ac.signal });

  // A transparent textarea receives keys and IME composition. It sits over
  // the terminal so the IME window opens near the text.
  const ta = document.createElement('textarea');
  ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('autocomplete', 'off');
  ta.setAttribute('autocorrect', 'off');
  ta.setAttribute('spellcheck', 'false');
  ta.setAttribute('aria-label', 'Terminal input');
  Object.assign(ta.style, { position: 'absolute', left: '0', top: '0', width: '1px', height: '1px', opacity: '0', border: '0', padding: '0', resize: 'none', outline: 'none', overflow: 'hidden', zIndex: '-1' });
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.append(ta);

  let composing = false;
  const held = new Set(); // codes whose keydown we sent, so keyup follows

  on(ta, 'keydown', (ev) => {
    if (composing || ev.isComposing || ev.key === 'Process' || ev.key === 'Dead') return;
    if (opts.onKey && opts.onKey(ev) === false) return;
    // Paste shortcuts produce a paste event; leave them to the browser.
    if ((ev.metaKey || (ev.ctrlKey && ev.shiftKey)) && ev.code === 'KeyV') return;
    // Keep browser and OS shortcuts that use the platform key.
    if (ev.metaKey) return;
    ev.preventDefault();
    const text = [...ev.key].length === 1 ? ev.key : '';
    held.add(ev.code);
    post({ type: 'key', code: ev.code, mods: mods(ev), action: ev.repeat ? ACTION.repeat : ACTION.press, text, unshifted: unshifted(ev, text), t: ev.timeStamp });
  });
  on(ta, 'keyup', (ev) => {
    if (!held.delete(ev.code)) return;
    post({ type: 'key', code: ev.code, mods: mods(ev), action: ACTION.release, text: '', unshifted: 0 });
  });
  on(ta, 'compositionstart', () => { composing = true; });
  on(ta, 'compositionend', (ev) => {
    composing = false;
    if (ev.data) post({ type: 'text', text: ev.data });
    ta.value = '';
  });
  // Soft keyboards and some IMEs insert text without a usable keydown.
  on(ta, 'input', (ev) => {
    if (composing || ev.inputType === 'insertCompositionText' || ev.inputType === 'insertFromComposition') return;
    if (ev.data) post({ type: 'text', text: ev.data });
    ta.value = '';
  });
  on(ta, 'paste', (ev) => {
    ev.preventDefault();
    const text = ev.clipboardData?.getData('text/plain');
    if (text) post({ type: 'paste', text });
  });
  on(ta, 'focus', () => post({ type: 'focus', focused: true }));
  on(ta, 'blur', () => { held.clear(); post({ type: 'focus', focused: false }); });

  // Pointer: mouse reports in CSS pixels relative to the canvas. The
  // worker decides whether the program wants them.
  let buttons = 0;
  const pos = (ev) => { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  const button = (b) => (b === 0 ? 1 : b === 1 ? 3 : b === 2 ? 2 : b + 5);
  on(canvas, 'pointerdown', (ev) => {
    ta.focus({ preventScroll: true });
    buttons |= 1 << ev.button;
    canvas.setPointerCapture?.(ev.pointerId);
    post({ type: 'mouse', action: 0, button: button(ev.button), mods: mods(ev), ...pos(ev), pressed: 1 });
  });
  on(canvas, 'pointerup', (ev) => {
    buttons &= ~(1 << ev.button);
    post({ type: 'mouse', action: 1, button: button(ev.button), mods: mods(ev), ...pos(ev), pressed: buttons ? 1 : 0 });
  });
  // Motion is sent at most once per animation frame.
  let move = null;
  on(canvas, 'pointermove', (ev) => {
    const b = buttons ? button(Math.log2(buttons & -buttons)) : 0;
    if (!move) requestAnimationFrame(() => { post(move); move = null; });
    move = { type: 'mouse', action: 2, button: b, mods: mods(ev), ...pos(ev), pressed: buttons ? 1 : 0 };
  });
  on(canvas, 'contextmenu', (ev) => ev.preventDefault());
  let wheelAcc = 0;
  on(canvas, 'wheel', (ev) => {
    ev.preventDefault();
    const px = ev.deltaMode === 1 ? ev.deltaY * opts.cell().ch : ev.deltaMode === 2 ? ev.deltaY * opts.cell().ch * 20 : ev.deltaY;
    wheelAcc += px / opts.cell().ch;
    const lines = Math.trunc(wheelAcc);
    if (!lines) return;
    wheelAcc -= lines;
    post({ type: 'wheel', lines, mods: mods(ev), ...pos(ev) });
  }, { passive: false });

  return { textarea: ta, focus: () => ta.focus({ preventScroll: true }), detach: () => { ac.abort(); ta.remove(); } };
}
