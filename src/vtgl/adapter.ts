// The one file in this package that reaches into xterm's internals to drive
// vtgl as xterm's renderer, matching the policy src/kitty/xterm-adapter.ts sets:
// everything private lives here, in one place, exhaustively documented. The
// other half, src/vtgl/source.ts, is ordinary code against xterm's public
// buffer API.
//
// vtgl keeps xterm as the VT parser, buffer, input handler, clipboard, keyboard
// protocol and kitty graphics owner; it takes over only the drawing, so it can
// bring its own Arabic shaper. It is never the default: RendererManager reaches
// for it only when a consumer asks for `prefer: 'vtgl'`, because it drops the
// features listed below rather than degrading gracefully.
//
// ---------------------------------------------------------------------------
// The private surface this depends on, exhaustively
// ---------------------------------------------------------------------------
//
//   1. `terminal._core`
//      The internal Terminal. Every other reach goes through it. Stable in
//      practice: every renderer addon xterm ships uses it, and the addon API
//      offers nothing else.
//
//   2. `terminal._core._renderService.setRenderer(renderer)`
//      The install point. There is no public equivalent: `IRenderer` is not in
//      xterm's published typings, so the interface implemented below is
//      reconstructed from what RenderService actually calls on it. If xterm
//      adds a required method, this shim silently stops receiving that signal
//      rather than failing loudly, which is the sharpest edge here.
//
//   3. `terminal._core._renderService.handleResize(cols, rows)`
//      Called on teardown to hand the grid back to the renderer we restore, the
//      same thing @xterm/addon-webgl does in its own disposal path.
//
//   4. `terminal._core._createRenderer()`
//      Rebuilds xterm's own DOM renderer on teardown. Private, and the only way
//      to put the terminal back the way we found it.
//
//   5. `terminal._core._themeService`
//      For `.colors.ansi` (256 IColor entries), `.colors.foreground`,
//      `.background`, `.cursor`, the selection colours, and `.onChangeColors`.
//      xterm accepts a theme publicly but never reads one back, and vtgl needs
//      resolved RGB because it does no palette lookup of its own. This is the
//      reach that would be easiest for xterm to make public and the one whose
//      absence is least defensible.
//
//   6. `terminal._core.onWillOpen`
//      Deferred activation when the addon is loaded before `open()`. Same as
//      the WebGL addon.
//
// If xterm renames any of these the addon breaks at load. Items 2 and 4 are the
// ones with no public substitute even in principle.

import type { ITerminalAddon, Terminal } from '@xterm/xterm';
import {
  Canvas2DRenderer,
  WebGL2Renderer,
  arabicShaper,
  supportsWebGL2,
  type Renderer,
  type ShaperHook,
  type Theme,
} from 'vtgl';

import { XtermVtSource, type Palette } from './source.js';

// ---------------------------------------------------------------------------
// The shape of xterm's private internals, as far as this file needs them
// ---------------------------------------------------------------------------

interface XtermColor {
  css: string;
  rgba: number;
}

interface XtermDisposable {
  dispose(): void;
}

type XtermEvent<T> = (listener: (arg: T) => unknown) => XtermDisposable;

interface XtermThemeService {
  colors: {
    foreground: XtermColor;
    background: XtermColor;
    cursor: XtermColor;
    cursorAccent: XtermColor;
    // The selection highlight, alpha intact, as xterm's own DOM renderer paints
    // it: text shows through it. `selectionBackgroundOpaque` is that colour
    // pre-blended onto the background and hides the glyphs, which is the wrong
    // one to overlay. The `Inactive` variants are used while the terminal is
    // blurred, matching xterm.
    selectionBackgroundTransparent: XtermColor;
    selectionInactiveBackgroundTransparent: XtermColor;
    selectionBackgroundOpaque: XtermColor;
    ansi: XtermColor[];
  };
  onChangeColors: XtermEvent<unknown>;
}

interface XtermRenderService {
  setRenderer(renderer: XtermRenderer): void;
  handleResize(cols: number, rows: number): void;
}

interface XtermCore {
  _renderService: XtermRenderService;
  _themeService: XtermThemeService;
  _createRenderer(): XtermRenderer;
  _store?: { _isDisposed?: boolean };
  onWillOpen: XtermEvent<unknown>;
}

/**
 * The dimensions record xterm passes around. Reconstructed from
 * `createRenderDimensions()` in the bundle; not in the published typings.
 */
interface XtermRenderDimensions {
  css: { canvas: { width: number; height: number }; cell: { width: number; height: number } };
  device: {
    canvas: { width: number; height: number };
    cell: { width: number; height: number };
    char: { width: number; height: number; left: number; top: number };
  };
}

/**
 * Everything RenderService calls on a renderer. Derived by reading the compiled
 * RenderService rather than from a type, because xterm publishes no type for it.
 */
interface XtermRenderer {
  readonly dimensions: XtermRenderDimensions;
  onRequestRedraw: XtermEvent<{ start: number; end: number; sync?: boolean }>;
  renderRows(start: number, end: number): void;
  handleSelectionChanged(
    start: [number, number] | undefined,
    end: [number, number] | undefined,
    columnSelectMode: boolean,
  ): void;
  handleDevicePixelRatioChange(): void;
  handleResize(cols: number, rows: number): void;
  handleCharSizeChanged(): void;
  handleBlur(): void;
  handleFocus(): void;
  handleCursorMove(): void;
  handleViewportVisibilityChange?(visible: boolean): void;
  clear(): void;
  clearTextureAtlas?(): void;
  dispose(): void;
}

/** A one-listener-list emitter in the shape xterm's IEvent expects. */
function emitter<T>(): { event: XtermEvent<T>; fire(arg: T): void; clear(): void } {
  let listeners: ((arg: T) => unknown)[] = [];
  return {
    event: (listener) => {
      listeners.push(listener);
      return {
        dispose() {
          listeners = listeners.filter((l) => l !== listener);
        },
      };
    },
    fire(arg) {
      for (const listener of listeners.slice()) listener(arg);
    },
    clear() {
      listeners = [];
    },
  };
}

function packRgb(color: XtermColor | undefined, fallback: number): number {
  if (!color) return fallback;
  // IColor.rgba is 0xRRGGBBAA; vtgl wants 0xRRGGBB.
  return (color.rgba >>> 8) & 0xffffff;
}

export interface VtglAddonOptions {
  /**
   * Turn on vtgl's Arabic contextual shaper. Off by default because the shaper
   * reorders cells inside a run, so hit testing and selection stop naming the
   * cell whose character is under the pointer. vtgl's own docs call this a
   * trade a host must choose, and inside xterm the host is xterm, which does
   * not know the reordering happened.
   */
  arabicShaping?: boolean;
  /**
   * A pre-built shaper to install, taking precedence over `arabicShaping`. Used
   * for the HarfBuzz shaper, which is loaded asynchronously (a wasm module) and
   * so is constructed by the caller and handed in ready.
   */
  shaper?: ShaperHook;
  /** Force the Canvas2D backend, for comparing the two paths. */
  backend?: 'webgl2' | 'canvas2d';
}

/**
 * Installs vtgl as xterm's renderer.
 *
 * Load it like any addon: `terminal.loadAddon(new VtglRendererAddon())`. It
 * replaces whatever renderer is installed, mounts a canvas inside xterm's
 * screen element, and drives vtgl from the row ranges xterm's RenderService
 * already computes. `activate` throws if vtgl cannot start (no WebGL2 and no
 * Canvas2D), so a caller can catch and fall back to another renderer.
 */
export class VtglRendererAddon implements ITerminalAddon {
  private terminal?: Terminal;
  private renderer?: VtglXtermRenderer;
  private readonly options: VtglAddonOptions;
  private disposables: XtermDisposable[] = [];

  constructor(options: VtglAddonOptions = {}) {
    this.options = options;
  }

  activate(terminal: Terminal): void {
    const core = (terminal as unknown as { _core: XtermCore })._core;
    if (!terminal.element) {
      // Loaded before open(). Same deferral the WebGL addon uses.
      this.disposables.push(core.onWillOpen(() => this.activate(terminal)));
      return;
    }
    this.terminal = terminal;
    this.renderer = new VtglXtermRenderer(terminal, core, this.options);
    core._renderService.setRenderer(this.renderer as unknown as XtermRenderer);
  }

  /** The live vtgl renderer, for tests that want its metrics or stats. */
  get vtgl(): Renderer | undefined {
    return this.renderer?.vtgl;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    const terminal = this.terminal;
    this.terminal = undefined;
    this.renderer = undefined;
    if (!terminal) return;
    const core = (terminal as unknown as { _core: XtermCore })._core;
    if (core._store?._isDisposed) return;
    // Hand the terminal back its own renderer, exactly as addon-webgl does.
    core._renderService.setRenderer(core._createRenderer());
    core._renderService.handleResize(terminal.cols, terminal.rows);
  }
}

/**
 * The IRenderer implementation.
 *
 * Selection is drawn here rather than by vtgl. vtgl has no concept of it: there
 * is no `Theme.selection` in its contract and its docs state that a host that
 * wants selection draws its own overlay. So this paints absolutely positioned
 * divs over the canvas, which is what xterm's DOM renderer does, and which
 * costs a compositor layer that the GPU renderers do not need. The overlay uses
 * xterm's translucent selection colour so the selected glyphs read through it.
 */
class VtglXtermRenderer {
  readonly vtgl: Renderer;

  private readonly term: Terminal;
  private readonly core: XtermCore;
  private readonly source: XtermVtSource;
  private readonly canvas: HTMLCanvasElement;
  private readonly selectionLayer: HTMLDivElement;
  private readonly screen: HTMLElement;
  private readonly redraw = emitter<{ start: number; end: number; sync?: boolean }>();
  private readonly disposables: XtermDisposable[] = [];

  private dpr: number;
  private focused = true;
  private cursorBlinkOn = true;
  private cursorBlinkTimer?: ReturnType<typeof setInterval>;
  private selection: {
    start?: [number, number];
    end?: [number, number];
    columnSelectMode: boolean;
  } = { columnSelectMode: false };

  readonly onRequestRedraw = this.redraw.event;

  constructor(term: Terminal, core: XtermCore, options: VtglAddonOptions) {
    this.term = term;
    this.core = core;
    this.dpr = globalThis.devicePixelRatio || 1;

    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) throw new Error('vtgl: xterm screen element missing');
    this.screen = screen;

    this.canvas = document.createElement('canvas');
    this.canvas.classList.add('xterm-vtgl-canvas');
    Object.assign(this.canvas.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      zIndex: '0',
    });
    screen.appendChild(this.canvas);

    this.selectionLayer = document.createElement('div');
    this.selectionLayer.classList.add('xterm-vtgl-selection');
    Object.assign(this.selectionLayer.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      zIndex: '1',
      pointerEvents: 'none',
    });
    screen.appendChild(this.selectionLayer);

    const palette = this.readPalette();
    this.source = new XtermVtSource(term, palette, {
      isFocused: () => this.focused,
      // DECTCEM is public: `terminal.modes.showCursor`. Worth naming, because
      // it is the one piece of renderer state this adapter needed that xterm
      // already exposes.
      isCursorHidden: () => !term.modes.showCursor,
      isCursorBlinkOn: () => this.cursorBlinkOn,
    });

    const rendererOptions = {
      fontFamily: String(term.options.fontFamily ?? 'monospace'),
      fontSize: Number(term.options.fontSize ?? 14),
      lineHeight: Number(term.options.lineHeight ?? 1),
      letterSpacing: Number(term.options.letterSpacing ?? 0),
      dpr: this.dpr,
      theme: this.readTheme(palette),
      // The source hands vtgl attribute flags verbatim, INVERSE included, so
      // the renderer is the one that swaps.
      resolveInverse: true,
      ...(options.shaper
        ? { shaper: options.shaper }
        : options.arabicShaping
          ? { shaper: arabicShaper() }
          : {}),
    };

    this.vtgl =
      options.backend === 'canvas2d' || (options.backend !== 'webgl2' && !supportsWebGL2())
        ? new Canvas2DRenderer(rendererOptions)
        : new WebGL2Renderer(rendererOptions);
    this.vtgl.mount(this.canvas);
    this.vtgl.resize(term.cols, term.rows, this.dpr);
    this.applyCanvasCss();

    this.disposables.push(
      core._themeService.onChangeColors(() => {
        const next = this.readPalette();
        this.source.setPalette(next);
        this.vtgl.setTheme(this.readTheme(next));
        this.source.markAllDirty();
        this.redraw.fire({ start: 0, end: term.rows - 1 });
      }),
    );

    this.startCursorBlink();
  }

  // --- colours ------------------------------------------------------------

  private readPalette(): Palette {
    const colors = this.core._themeService.colors;
    return {
      ansi: colors.ansi.map((c) => packRgb(c, 0)),
      foreground: packRgb(colors.foreground, 0xffffff),
      background: packRgb(colors.background, 0x000000),
    };
  }

  private readTheme(palette: Palette): Theme {
    const colors = this.core._themeService.colors;
    return {
      foreground: palette.foreground,
      background: palette.background,
      cursor: packRgb(colors.cursor, palette.foreground),
      cursorText: packRgb(colors.cursorAccent, palette.background),
    };
  }

  // --- geometry -----------------------------------------------------------

  /**
   * vtgl sizes the canvas backing store and nothing else, so the CSS box is the
   * host's job.
   *
   * This is where the adapter's deepest structural problem shows. vtgl measures
   * the font itself and rounds the cell to whole device pixels; xterm measures
   * the font itself, through CharSizeService, and rounds differently. Reporting
   * vtgl's metrics as `dimensions` makes xterm agree with what is on screen,
   * which is what selection, mouse hit testing, the FitAddon and the kitty
   * overlay all read. But CharSizeService keeps its own answer, so anything
   * reading that instead sees the other number.
   */
  private applyCanvasCss(): void {
    const metrics = this.vtgl.getMetrics();
    this.canvas.style.width = `${metrics.cssCellWidth * metrics.cols}px`;
    this.canvas.style.height = `${metrics.cssCellHeight * metrics.rows}px`;
  }

  get dimensions(): XtermRenderDimensions {
    const m = this.vtgl.getMetrics();
    return {
      css: {
        canvas: { width: m.cssCellWidth * m.cols, height: m.cssCellHeight * m.rows },
        cell: { width: m.cssCellWidth, height: m.cssCellHeight },
      },
      device: {
        canvas: { width: m.canvasWidth, height: m.canvasHeight },
        cell: { width: m.cellWidth, height: m.cellHeight },
        char: { width: m.cellWidth, height: m.cellHeight, left: 0, top: 0 },
      },
    };
  }

  // --- the frame ----------------------------------------------------------

  renderRows(start: number, end: number): void {
    const viewportY = this.term.buffer.active.viewportY;
    this.source.markDirty(viewportY + start, viewportY + end);
    this.vtgl.render(this.source, viewportY);
    this.source.clearDirty();
    this.paintSelection();
  }

  handleResize(cols: number, rows: number): void {
    this.vtgl.resize(cols, rows, this.dpr);
    this.applyCanvasCss();
    this.source.markAllDirty();
  }

  handleDevicePixelRatioChange(): void {
    this.dpr = globalThis.devicePixelRatio || 1;
    this.vtgl.resize(this.term.cols, this.term.rows, this.dpr);
    this.applyCanvasCss();
    this.source.markAllDirty();
  }

  handleCharSizeChanged(): void {
    // vtgl owns its own measurement, so there is nothing to take from xterm's.
    // A font change arrives here, but vtgl has no setFont: the renderer would
    // have to be rebuilt. Recorded as a gap rather than papered over.
    this.source.markAllDirty();
  }

  handleBlur(): void {
    this.focused = false;
    this.refreshCursorRow();
    // The selection colour softens while blurred, matching xterm.
    this.paintSelection();
  }

  handleFocus(): void {
    this.focused = true;
    this.refreshCursorRow();
    this.paintSelection();
  }

  handleCursorMove(): void {
    this.source.markAllDirty();
  }

  handleViewportVisibilityChange(): void {
    // vtgl draws only when asked, so an invisible viewport costs nothing.
  }

  clear(): void {
    this.source.markAllDirty();
    this.vtgl.render(this.source, this.term.buffer.active.viewportY);
    this.source.clearDirty();
  }

  clearTextureAtlas(): void {
    // vtgl's atlas is private and rebuilds itself on resize and theme change.
    this.source.markAllDirty();
  }

  // --- selection ----------------------------------------------------------

  handleSelectionChanged(
    start: [number, number] | undefined,
    end: [number, number] | undefined,
    columnSelectMode: boolean,
  ): void {
    this.selection = { start, end, columnSelectMode };
    this.paintSelection();
  }

  /**
   * Draw the selection as DOM rectangles over the canvas.
   *
   * Three boxes at most: the tail of the first row, a full block for the rows
   * between, and the head of the last row. Column select mode is one box per
   * row instead. Selection coordinates from xterm are [col, absoluteRow].
   *
   * The fill is xterm's translucent selection colour, not the opaque one: the
   * overlay sits above the glyph canvas, so an opaque fill would black out the
   * selected text. xterm's own DOM renderer paints the same translucent colour
   * for the same reason, and softens to the inactive colour while blurred.
   */
  private paintSelection(): void {
    const layer = this.selectionLayer;
    const { start, end, columnSelectMode } = this.selection;
    if (!start || !end || (start[0] === end[0] && start[1] === end[1])) {
      if (layer.childElementCount) layer.replaceChildren();
      return;
    }
    const m = this.vtgl.getMetrics();
    const viewportY = this.term.buffer.active.viewportY;
    const selectionColors = this.core._themeService.colors;
    const color = this.focused
      ? selectionColors.selectionBackgroundTransparent.css
      : selectionColors.selectionInactiveBackgroundTransparent.css;
    const boxes: [number, number, number, number][] = [];
    const first = Math.max(start[1], viewportY);
    const last = Math.min(end[1], viewportY + this.term.rows - 1);

    if (columnSelectMode) {
      const left = Math.min(start[0], end[0]);
      const width = Math.abs(end[0] - start[0]);
      for (let row = first; row <= last; row++) boxes.push([left, row - viewportY, width, 1]);
    } else if (start[1] === end[1]) {
      if (first <= last) boxes.push([start[0], first - viewportY, end[0] - start[0], 1]);
    } else {
      if (start[1] >= viewportY && start[1] <= last)
        boxes.push([start[0], start[1] - viewportY, this.term.cols - start[0], 1]);
      const midFirst = Math.max(start[1] + 1, viewportY);
      const midLast = Math.min(end[1] - 1, viewportY + this.term.rows - 1);
      if (midLast >= midFirst)
        boxes.push([0, midFirst - viewportY, this.term.cols, midLast - midFirst + 1]);
      if (end[1] <= viewportY + this.term.rows - 1 && end[1] >= viewportY)
        boxes.push([0, end[1] - viewportY, end[0], 1]);
    }

    layer.replaceChildren(
      ...boxes.map(([col, row, cols, rows]) => {
        const box = document.createElement('div');
        Object.assign(box.style, {
          position: 'absolute',
          left: `${col * m.cssCellWidth}px`,
          top: `${row * m.cssCellHeight}px`,
          width: `${cols * m.cssCellWidth}px`,
          height: `${rows * m.cssCellHeight}px`,
          background: color,
        });
        return box;
      }),
    );
  }

  // --- cursor blink -------------------------------------------------------

  /**
   * vtgl runs no clock, by design: a host that wants a blinking cursor owns one
   * and toggles `CursorState.visible`. xterm has a cursor blink clock of its
   * own inside the renderers it ships, so replacing the renderer means
   * reimplementing it, which is what this is.
   */
  private startCursorBlink(): void {
    const blink = () => {
      if (!this.term.options.cursorBlink) {
        this.cursorBlinkOn = true;
        return;
      }
      this.cursorBlinkOn = !this.cursorBlinkOn;
      this.refreshCursorRow();
    };
    this.cursorBlinkTimer = setInterval(blink, 600);
  }

  private refreshCursorRow(): void {
    const buffer = this.term.buffer.active;
    const row = buffer.baseY + buffer.cursorY - buffer.viewportY;
    if (row < 0 || row >= this.term.rows) return;
    this.source.markDirty(buffer.baseY + buffer.cursorY, buffer.baseY + buffer.cursorY);
    this.redraw.fire({ start: row, end: row });
  }

  dispose(): void {
    if (this.cursorBlinkTimer) clearInterval(this.cursorBlinkTimer);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.redraw.clear();
    this.vtgl.dispose();
    this.canvas.remove();
    this.selectionLayer.remove();
    void this.screen;
  }
}
