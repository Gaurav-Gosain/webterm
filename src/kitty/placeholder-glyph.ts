/*
 * Stop the terminal drawing kitty's unicode placeholder character.
 *
 * The overlay covers the reserved placeholder cells with the image, and it
 * covers them exactly, but that is still not enough on its own. A tofu box is
 * wider than the cell it stands in, so the ink of the last column's glyph
 * bleeds past the image's edge and shows as a line of half-boxes down its
 * side. Widening the canvas to swallow the overspill would paint over whatever
 * the application put in the next column, which is worse.
 *
 * The glyph is drawn because no shipping font covers U+10EEEE. Supplying a font
 * that does, and that draws nothing for it, is the whole fix: the character
 * stops being rendered at all, at every device pixel ratio and font size, and
 * whether or not an image happens to be covering it. A placeholder grid whose
 * image never arrives now shows blank cells rather than a field of tofu.
 *
 * The face covers the placeholder character and the row/column diacritics that
 * follow it, because a browser shapes a placeholder cell as one cluster in one
 * font and passes over a face that does not cover all of it. The family is
 * appended to the terminal's font stack rather than prepended, so it is reached
 * only after every font the embedder configured has declined the character.
 */
import type { Terminal } from '@xterm/xterm';

import {
  PLACEHOLDER_FONT_BASE64,
  PLACEHOLDER_FONT_FAMILY,
  PLACEHOLDER_FONT_UNICODE_RANGE,
} from './placeholder-font.js';

const STYLE_ID = 'webterm-kitty-placeholder-font';
const PLACEHOLDER = '\u{10EEEE}';

/** Add the face to the document, once per document. */
function installFace(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent =
    `@font-face{font-family:'${PLACEHOLDER_FONT_FAMILY}';` +
    `src:url(data:font/ttf;base64,${PLACEHOLDER_FONT_BASE64}) format('truetype');` +
    `unicode-range:${PLACEHOLDER_FONT_UNICODE_RANGE};font-display:block}`;
  document.head.appendChild(style);
}

/**
 * Append the family to a font stack, if it is not already there.
 *
 * Exported because the stack is rebuilt whenever an embedder changes
 * `fontFamily` at runtime, and the placeholder face has to survive that.
 */
export function withPlaceholderFont(fontFamily: string): string {
  if (fontFamily.includes(PLACEHOLDER_FONT_FAMILY)) return fontFamily;
  return `${fontFamily}, '${PLACEHOLDER_FONT_FAMILY}'`;
}

/**
 * Register the face and put it at the end of the terminal's font stack.
 *
 * The stack is only extended once the face has actually loaded: xterm caches a
 * glyph atlas, and changing `fontFamily` is what invalidates it, so doing that
 * after the font is available is what makes the blank glyph take effect rather
 * than the tofu already in the atlas.
 */
export function installPlaceholderGlyph(term: Terminal): void {
  installFace();
  const apply = () => {
    const current = term.options.fontFamily;
    if (!current) return;
    const next = withPlaceholderFont(current);
    if (next !== current) term.options.fontFamily = next;
  };
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts?.load) {
    apply();
    return;
  }
  fonts.load(`1em '${PLACEHOLDER_FONT_FAMILY}'`, PLACEHOLDER).then(apply, apply);
}
