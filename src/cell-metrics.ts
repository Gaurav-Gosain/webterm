/*
 * Rounds the device cell width the atlas renderers rasterise glyphs into.
 *
 * Both @xterm/addon-webgl and @xterm/addon-canvas compute
 *
 *   dimensions.device.char.width = Math.floor(charSizeService.width * dpr)
 *
 * and the texture atlas rasterises every glyph into a box of exactly that
 * width. The floor throws away up to a device pixel per column. At a 14px font
 * the advance measures 8.4 CSS px, so on a dpr 2 display the true advance is
 * 16.8 device px and the cell comes out 16: every glyph drawn to the full
 * advance loses 0.8 device px off its right edge. Powerline separators, box and
 * block drawing and Nerd Font icons are the visible casualties, since they are
 * designed to meet the cell edge exactly. The DOM renderer does no rounding at
 * all and draws them correctly, so the same terminal looks different depending
 * on which renderer resolved.
 *
 * The rounding is upstream code in a `private _updateDimensions()` on each
 * renderer, and neither addon exposes an option that reaches it. `letterSpacing`
 * is not a substitute: it widens `device.cell.width` but leaves
 * `device.char.width`, the atlas box, exactly where it was, so it spaces
 * ordinary text out without recovering a single pixel of the clipped glyph.
 *
 * So the correction is applied where it can be: the renderer reads its advance
 * from a `_charSizeService` it holds a reference to, and that reference is
 * swapped for a proxy reporting an advance that floors to the rounded device
 * width. Only `width` is intercepted; height, `hasValidSize`, the change event
 * and everything else pass through to the real service untouched. The core's
 * own service is not modified, so layout, selection, the DOM renderer and the
 * kitty overlay all keep measuring the real advance.
 *
 * Rounding rather than ceiling is deliberate. Ceiling would widen every cell
 * whose advance has any fraction at all, loosening ordinary text on every
 * display to fix icons. Rounding only widens where the fraction is already past
 * half, which is where the clipping is worst. It is not free: an advance of
 * 8.6 CSS px at dpr 1 moves from 8 to 9 device px, one pixel of extra tracking.
 * That is the accepted cost of a cell that holds its glyph.
 *
 * Degradation: if a future xterm renames `_charSizeService`, or stops flooring,
 * `installRoundedCellWidth` finds nothing to swap and returns false. The
 * renderer is then left exactly as upstream built it, which is the behaviour
 * before this module existed.
 */

/** The slice of xterm's private char size service the correction reads. */
interface CharSizeLike {
  width: number;
  height: number;
}

/** The slice of a renderer addon that exposes the renderer it constructed. */
interface RendererHost {
  _renderer?: { _charSizeService?: CharSizeLike; handleCharSizeChanged?(): void };
}

/** The slice of xterm's core the device pixel ratio is read from. */
interface CoreWithBrowserService {
  _coreBrowserService?: { dpr?: number };
}

/**
 * The advance to report so that the renderer's floor lands on the rounded
 * device width.
 *
 * The quarter pixel is slack against floating point: `Math.round(w * dpr) / dpr`
 * multiplied back by `dpr` can land a hair under the integer on a fractional
 * ratio such as 1.1, and floor would then take the pixel straight back. A
 * quarter is far below the one whole device pixel that would push the floor up
 * to the next integer, so it cannot overshoot.
 */
export function roundedAdvance(cssWidth: number, dpr: number): number {
  if (!(cssWidth > 0) || !(dpr > 0)) return cssWidth;
  return (Math.round(cssWidth * dpr) + 0.25) / dpr;
}

/**
 * Swaps the renderer's char size service for one that rounds the advance.
 *
 * Must run after the addon has been loaded, since the renderer does not exist
 * until `activate`. Returns whether the swap took, so a caller can log or test
 * the degradation rather than assume it.
 */
export function installRoundedCellWidth(addon: unknown, term: unknown): boolean {
  const renderer = (addon as RendererHost)?._renderer;
  const real = renderer?._charSizeService;
  if (!renderer || !real) return false;

  const core = (term as { _core?: CoreWithBrowserService })?._core;
  const browserService = core?._coreBrowserService;
  if (!browserService) return false;

  const proxy = new Proxy(real as object, {
    get(target, property, receiver) {
      if (property === 'width') {
        return roundedAdvance((target as CharSizeLike).width, browserService.dpr ?? 1);
      }
      const value = Reflect.get(target, property, receiver === proxy ? target : receiver);
      // Methods and the event emitters xterm exposes as properties must keep
      // the real service as their `this`, or they read a half-proxied object.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  (renderer as { _charSizeService?: CharSizeLike })._charSizeService = proxy as CharSizeLike;
  // The renderer already sized itself from the real advance in its constructor.
  // This is the public entry point that recomputes the dimensions and rebuilds
  // the atlas against them.
  renderer.handleCharSizeChanged?.();
  return true;
}
