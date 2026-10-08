// The styles the touch layer injects. Every name in them comes from the
// namespace the caller picked, so two layers with different namespaces never
// collide, and a page that already styles a namespace keeps working. With the
// namespace 'sip' the output is exactly what sip's mobile.js injected.

/**
 * The key bar's styles.
 *
 * The colours read the namespace's custom properties (`--<ns>-border`,
 * `--<ns>-surface`, `--<ns>-fg`, `--<ns>-warn`, `--<ns>-bg`,
 * `--<ns>-border-strong`, `--<ns>-bar-bg-rgb`) and fall back to a dark
 * palette, so a page can theme the bar without touching this file.
 */
export function keyBarStyle(ns: string): string {
  return `
:root {
  /* env() is the VirtualKeyboard API's own answer and the right default. JS
     overwrites both of these whenever it has a measurement of its own. */
  --${ns}-kb-inset: env(keyboard-inset-height, 0px);
  --${ns}-keybar-h: 0px;
  /* The bar's own measurements. A thumb is not a mouse pointer: Android asks
     for 48dp targets and iOS for 44pt, and the 38px keys with 3px between
     them that this shipped with were sized for neither. The gap is what stops
     a thumb landing across two keys, and the padding is what keeps the outer
     keys off the screen edge, where a case or a gesture strip gets in first. */
  --${ns}-keybar-pad: 6px;
  --${ns}-keybar-gap: 5px;
  --${ns}-keybar-key-h: 42px;
}
body.${ns}-touch {
  overscroll-behavior: none;
  -webkit-text-size-adjust: 100%;
}
#${ns}-keybar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: var(--${ns}-kb-inset);
  z-index: 1004;
  display: flex;
  align-items: stretch;
  gap: var(--${ns}-keybar-gap);
  /* The side padding grows to the safe-area inset on a phone held sideways,
     so the first key is not under the notch and the last is not under the
     home strip. env() is 0 everywhere that has neither. */
  padding:
    var(--${ns}-keybar-pad)
    max(var(--${ns}-keybar-pad), env(safe-area-inset-right, 0px))
    calc(var(--${ns}-keybar-pad) + env(safe-area-inset-bottom, 0px))
    max(var(--${ns}-keybar-pad), env(safe-area-inset-left, 0px));
  background: rgba(var(--${ns}-bar-bg-rgb, 24, 24, 37), 0.96);
  border-top: 1px solid var(--${ns}-border, #45475a);
  /* The bar is chrome, and none of it is the browser's to interpret: no
     zooming, no callouts, no page scrolling, and above all no native scrolling
     of the strip itself, which is what used to take the software keyboard down
     with it. The strip is panned by hand instead; see installBarTouch. */
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
body.${ns}-kb-open #${ns}-keybar {
  padding-bottom: var(--${ns}-keybar-pad);
}
/* Wide enough that every row fits without panning, which is a tablet and a
   phone held sideways: the rows are centred and the pinned keys sit beside
   them rather than at the far edge of the screen. A strip of twelve keys
   pressed into the left corner of a 1100px window with the keyboard key alone
   at the right is the layout this replaces. The class is set from measurement
   (refreshScrollHints), because CSS cannot ask whether a scroller overflows,
   and the moment a row stops fitting it goes back to a left-anchored scroller
   so that nothing is centred out of reach. */
#${ns}-keybar.fits {
  justify-content: center;
}
#${ns}-keybar.fits #${ns}-keybar-rows {
  flex: 0 1 auto;
}
/* Only when the whole bar fits. One row centred over another that is
   anchored left and panning reads as a mistake, not a layout. */
#${ns}-keybar.fits .${ns}-keybar-scroll {
  justify-content: center;
}
/* The rows stack, and they stack upwards: the last row declared sits at the
   bottom, nearest the thumb, and folding a row above it leaves it where it
   was. A row that moved when another one folded would put the key under the
   finger somewhere else between one tap and the next. */
#${ns}-keybar-rows {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: var(--${ns}-keybar-gap);
}
/* Each scroller is wrapped so the edge fades can be positioned against
   something that does not scroll with the buttons. */
.${ns}-keybar-row {
  position: relative;
  min-width: 0;
}
#${ns}-keybar.folded .${ns}-keybar-row.collapsible {
  display: none;
}
/* hidden, not auto: this box is scrolled, but only ever by assigning
   scrollLeft. An overflow: hidden box still honours that, while offering the
   browser no gesture to take over and no scroll container to attach its own
   keyboard-dismissing behaviour to. It also keeps touch-action: none applying
   to the whole bar, since both engines reset the inherited touch-action at an
   element that is scrollable by the user and this one is not. */
.${ns}-keybar-scroll {
  display: flex;
  align-items: center;
  gap: var(--${ns}-keybar-gap);
  overflow: hidden;
  touch-action: none;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.${ns}-keybar-scroll::-webkit-scrollbar {
  display: none;
}
/* Something is off the edge in that direction. Set on build and on every pan,
   so a bar that overflows says so on the first frame rather than only once it
   has been touched. */
.${ns}-keybar-row::before,
.${ns}-keybar-row::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 22px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 120ms ease;
}
.${ns}-keybar-row::before {
  left: 0;
  background: linear-gradient(to right, rgba(24, 24, 37, 0.98), rgba(24, 24, 37, 0));
}
.${ns}-keybar-row::after {
  right: 0;
  background: linear-gradient(to left, rgba(24, 24, 37, 0.98), rgba(24, 24, 37, 0));
}
.${ns}-keybar-row.more-left::before,
.${ns}-keybar-row.more-right::after {
  opacity: 1;
}
#${ns}-keybar .sep {
  flex: 0 0 auto;
  width: 1px;
  align-self: center;
  height: 24px;
  margin: 0 2px;
  background: var(--${ns}-border-strong, #585b70);
}
#${ns}-keybar button {
  flex: 0 0 auto;
  min-width: 44px;
  height: var(--${ns}-keybar-key-h);
  border: 1px solid var(--${ns}-border, #45475a);
  border-radius: 8px;
  background: var(--${ns}-surface, #313244);
  color: var(--${ns}-fg, #cdd6f4);
  font-family: 'JetBrainsMono Nerd Font Mono', ui-monospace, monospace;
  font-size: 13px;
  line-height: 1;
  padding: 0 8px;
  cursor: pointer;
  white-space: nowrap;
  -webkit-tap-highlight-color: transparent;
  /* A tap that selects the label, or that the browser treats as a possible
     double-tap or the start of a scroll, is a tap that can move focus off the
     element the software keyboard is riding on. Swiping across the buttons
     still works: the bar pans itself. */
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
#${ns}-keybar button.narrow {
  min-width: 38px;
  padding: 0 5px;
}
/* Actions are not keys: they do not type, and one of them may well close
   something. Tinting them apart is the cheapest way to say so in a strip this
   small. */
#${ns}-keybar button.action {
  background: #292a3d;
  border-color: var(--${ns}-border-strong, #585b70);
  color: #b4befe;
}
/* .pressed is the touch half of :active. A touch sequence that is cancelled at
   touchstart, which is what keeps the keyboard up, is also a touch sequence the
   browser will not draw an active state for, so the bar draws its own. */
#${ns}-keybar button:active,
#${ns}-keybar button.pressed {
  background: var(--${ns}-border, #45475a);
}
/* Pinned, so these survive however far any row is scrolled. They stack in the
   same direction the rows do, so the keyboard key stays on the bottom line
   next to the typing row whether or not anything above it is folded. */
#${ns}-keybar-pin {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: var(--${ns}-keybar-gap);
  padding-left: var(--${ns}-keybar-gap);
  border-left: 1px solid var(--${ns}-border, #45475a);
  touch-action: none;
}
#${ns}-keybar button.fold {
  font-size: 16px;
}
/* Folded, the pin lies down. Left stacked it would hold the bar at its
   two-row height and the fold would give no space back, which is the whole
   reason to fold. */
#${ns}-keybar.folded #${ns}-keybar-pin {
  flex-direction: row;
}
#${ns}-keybar button.active {
  background: var(--${ns}-border, #45475a);
  color: var(--${ns}-warn, #f9e2af);
  border-color: var(--${ns}-warn, #f9e2af);
}
/* Armed for one keystroke: outlined. Locked until tapped off: filled. The two
   have to be told apart at a glance or a locked Ctrl silently eats the rest of
   what gets typed. */
#${ns}-keybar button.armed {
  background: var(--${ns}-surface, #313244);
  color: var(--${ns}-warn, #f9e2af);
  border-color: var(--${ns}-warn, #f9e2af);
}
#${ns}-keybar button.locked {
  background: var(--${ns}-warn, #f9e2af);
  color: var(--${ns}-bg, #1e1e2e);
  border-color: var(--${ns}-warn, #f9e2af);
}
`;
}

/**
 * The touch layer's own styles: the ring that says a hold has landed and the
 * one line that says what to do with it. Injected by installTouchMouse, which
 * can run without the key bar and so cannot ride on the key bar's styles.
 */
export function touchStyle(ns: string): string {
  return `
#${ns}-touch-ring {
  position: fixed;
  z-index: 1003;
  width: 44px;
  height: 44px;
  margin: -22px 0 0 -22px;
  border-radius: 50%;
  border: 2px solid rgba(249, 226, 175, 0.95);
  box-shadow: 0 0 0 5px rgba(249, 226, 175, 0.22);
  pointer-events: none;
  opacity: 0;
  transform: scale(1.5);
  transition: opacity 120ms ease, transform 160ms ease;
}
#${ns}-touch-ring.on {
  opacity: 1;
  transform: scale(1);
}
#${ns}-touch-hint {
  position: fixed;
  left: 50%;
  bottom: calc(var(--${ns}-kb-inset, 0px) + var(--${ns}-keybar-h, 0px) + 12px);
  transform: translateX(-50%);
  z-index: 1003;
  max-width: calc(100vw - 32px);
  padding: 8px 14px;
  border: 1px solid var(--${ns}-border, #45475a);
  border-radius: 8px;
  background: rgba(var(--${ns}-bar-bg-rgb, 24, 24, 37), 0.96);
  color: var(--${ns}-fg, #cdd6f4);
  font-family: 'JetBrainsMono Nerd Font Mono', ui-monospace, monospace;
  font-size: 13px;
  line-height: 1.3;
  text-align: center;
  pointer-events: none;
  opacity: 0;
  transition: opacity 200ms ease;
}
#${ns}-touch-hint.on {
  opacity: 1;
}
`;
}
