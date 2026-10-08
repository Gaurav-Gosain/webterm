// Touch support for a browser terminal: a key bar, a keyboard-aware layout, a
// mouse for a finger, and draggable page controls.
//
// Nothing here imports the terminal. Each part talks to the page through one
// small host object, so it works with a WebTerm, a bare xterm.js Terminal or
// any other terminal that takes input as text. Every part installs only on a
// touch device (or with ?mobile=1 in the page URL) and returns an inert
// controller everywhere else, so a desktop pays nothing.

export {
  installKeyBar,
  type KeyBarController,
  type KeyBarHost,
  type KeyBarOptions,
  type KeyLike,
  type MobileAction,
  type MobileRow,
  type ModState,
  type WrappedKey,
} from './keybar.js';
export {
  installTouchMouse,
  type TouchMouseController,
  type TouchMouseHost,
  type TouchMouseOptions,
} from './touch-mouse.js';
export { installDraggable, type DraggableOptions } from './draggable.js';
export { DEFAULT_NAMESPACE, detectTouch, pickFontSize } from './detect.js';
export {
  DEFAULT_KEYS,
  encodeKeySpec,
  type EncodableKey,
  type KeyChord,
  type KeyMods,
  type MobileKey,
  type MobileModifier,
} from './keys.js';
