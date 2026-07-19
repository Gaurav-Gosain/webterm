export { KittyGraphics, type KittyGraphicsOptions } from './overlay.js';
export { installPlaceholderGlyph, withPlaceholderFont } from './placeholder-glyph.js';
export { scanPlaceholders, PLACEHOLDER_CODE, type PlaceholderRun } from './placeholders.js';
export {
  createXtermAdapter,
  supportsApc,
  type XtermAdapter,
  type XtermDisposable,
} from './xterm-adapter.js';
export {
  KITTY_APC_IDENT,
  base64Decode,
  clampSourceRect,
  fitRgba,
  parseControl,
  rgbToRgba,
  splitApc,
  type KittyCommand,
} from './protocol.js';
