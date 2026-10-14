/*
 * The cursor shape an application sets with DECSCUSR, delivered to the renderer
 * addons that do not read it.
 *
 * xterm.js applies `CSI Ps SP q` by writing `coreService.decPrivateModes`
 * (`cursorStyle`, `cursorBlink`) and leaves the options alone, so the embedder's
 * configured shape can come back on DECSCUSR 0. Its own DOM renderer reads the
 * private mode first and the option second, on every frame. The two addons
 * webterm ships do not:
 *
 *   - The WebGL addon reads the shape correctly, but decides whether to run its
 *     blink clock only when an option changes. `CSI 5 SP q` drew a bar that
 *     never blinked, and `CSI 6 SP q` after a blinking shape kept blinking.
 *
 *   - The canvas addon is the xterm 5 one, older than the private mode, and
 *     reads `rawOptions.cursorStyle` and `rawOptions.cursorBlink` alone. Every
 *     shape an application asked for drew as the configured block.
 *
 * Writing the shape into the options instead would reach both, but the WebGL
 * addon answers any option change by refreshing its glyph atlas and
 * re-uploading every atlas texture, which is far too much for a shape an
 * editor changes on every mode switch, and its next frames left a stale cursor
 * behind. So the options stay the embedder's, and each addon is told directly.
 *
 * Both reach into private addon state, the way `installRoundedCellWidth` does.
 * Every step checks what it reaches for and does nothing when it is absent, so
 * an xterm that renames a member loses the fix and keeps working.
 */

/** The DECSCUSR modes as xterm keeps them. Undefined is "not set". */
interface CursorModes {
  cursorStyle?: 'block' | 'underline' | 'bar';
  cursorBlink?: boolean;
}

interface WebglRendererLike {
  _updateCursorBlink?(): void;
}

interface CanvasCursorLayerLike {
  _cursorRenderers?: unknown;
  _optionsService?: { rawOptions?: Record<string, unknown> };
  _coreService?: { decPrivateModes?: CursorModes };
  _handleOptionsChanged?(): void;
}

/**
 * Tell the WebGL addon to re-read whether the cursor blinks. Returns the sync
 * to call after each DECSCUSR, or undefined when the addon has no such hook.
 */
export function webglCursorSync(addon: unknown): (() => void) | undefined {
  const renderer = (addon as { _renderer?: WebglRendererLike })?._renderer;
  if (typeof renderer?._updateCursorBlink !== 'function') return undefined;
  return () => renderer._updateCursorBlink?.();
}

/**
 * Make the canvas addon's cursor layer draw the shape the application set.
 *
 * The layer reads `this._optionsService.rawOptions`. It gets a stand-in whose
 * `rawOptions` answers `cursorStyle` and `cursorBlink` from the private mode
 * first and the real options second, which is the rule xterm's DOM renderer
 * follows. Every other read passes through to the real service. Returns the
 * sync to call after each DECSCUSR, which runs the layer's own option handler
 * so the blink clock starts or stops and the cursor row redraws.
 */
export function canvasCursorSync(addon: unknown): (() => void) | undefined {
  const layers = (addon as { _renderer?: { _renderLayers?: unknown[] } })?._renderer?._renderLayers;
  if (!Array.isArray(layers)) return undefined;
  const layer = layers.find(
    (candidate) => (candidate as CanvasCursorLayerLike)?._cursorRenderers !== undefined,
  ) as CanvasCursorLayerLike | undefined;
  const service = layer?._optionsService;
  const raw = service?.rawOptions;
  const modes = layer?._coreService?.decPrivateModes;
  if (!layer || !service || !raw || !modes || typeof layer._handleOptionsChanged !== 'function') {
    return undefined;
  }

  // Read the modes object through the core service each time: xterm replaces
  // it on a full reset.
  const current = (): CursorModes => layer._coreService?.decPrivateModes ?? {};
  const rawOptions = new Proxy(raw, {
    get(target, property, receiver) {
      if (property === 'cursorStyle') return current().cursorStyle ?? target.cursorStyle;
      if (property === 'cursorBlink') return current().cursorBlink ?? target.cursorBlink;
      return Reflect.get(target, property, receiver === rawOptions ? target : receiver);
    },
  });
  const stand = new Proxy(service as object, {
    get(target, property, receiver) {
      if (property === 'rawOptions') return rawOptions;
      const value = Reflect.get(target, property, receiver === stand ? target : receiver);
      // Methods and event emitters keep the real service as their `this`.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  layer._optionsService = stand as CanvasCursorLayerLike['_optionsService'];
  const sync = (): void => layer._handleOptionsChanged?.();
  // The layer already chose its blink clock from the real options.
  sync();
  return sync;
}
