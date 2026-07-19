import type {
  ITerminalInitOnlyOptions,
  ITerminalOptions,
  ITheme,
  Terminal as XtermTerminal,
} from '@xterm/xterm';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ImageAddon } from '@xterm/addon-image';

import { Clipboard, installCopyOnSelect, registerOsc52 } from './clipboard.js';
import { Emitter } from './emitter.js';
import { DEFAULT_FONT_FAMILY, loadFonts } from './fonts.js';
import {
  DEFAULT_CHUNK_BYTES,
  DEFAULT_RESERVED_KEYS,
  MotionFilter,
  binaryStringToBytes,
  chunkBytes,
  installContextMenuPolicy,
  installReservedKeyCapture,
} from './input.js';
import { KittyGraphics } from './kitty/overlay.js';
import { withPlaceholderFont } from './kitty/placeholder-glyph.js';
import { KittyKeyboard } from './keyboard/keyboard.js';
import { RendererManager } from './renderer.js';
import { resolveTheme, type ThemeName } from './themes.js';
import { DEFAULT_OVERRIDES, installUnicodeOverrides } from './unicode.js';
import { BatchedWriter } from './writer.js';
import type {
  KittyOptions,
  RendererKind,
  Transport,
  TransportSink,
  WebTermEvents,
  WebTermOptions,
} from './types.js';

const DEFAULT_FIT_DEBOUNCE_MS = 50;

export class WebTerm {
  private options: WebTermOptions;
  private readonly emitter = new Emitter<WebTermEvents>();
  private readonly encoder = new TextEncoder();
  private readonly motion = new MotionFilter();

  private terminal?: Terminal;
  private fitAddon?: FitAddon;
  private writer?: BatchedWriter;
  private rendererManager?: RendererManager;
  private clipboard?: Clipboard;
  private overlay?: KittyGraphics;
  private keyboardProtocol?: KittyKeyboard;
  private imageAddon?: ImageAddon;
  private container?: HTMLElement;

  private transport?: Transport;
  private opening?: Promise<this>;
  private disposed = false;
  private autoFit = true;
  private fitTimer?: ReturnType<typeof setTimeout>;
  private resizeObserver?: ResizeObserver;
  private readonly teardown: Array<() => void> = [];

  constructor(options: WebTermOptions = {}) {
    this.options = { ...options };
  }

  // --- Lifecycle ------------------------------------------------------------

  /**
   * Load fonts, construct the Terminal, install providers and addons, and
   * attach to the container.
   *
   * Asynchronous because the font load must complete before construction.
   * Idempotent: a second call resolves to the same instance rather than opening
   * a second terminal into the container.
   */
  open(container: HTMLElement): Promise<this> {
    if (this.opening) return this.opening;
    this.opening = this.doOpen(container);
    return this.opening;
  }

  private async doOpen(container: HTMLElement): Promise<this> {
    const o = this.options;
    this.container = container;

    const fontFamily = o.fontFamily ?? DEFAULT_FONT_FAMILY;
    // Before construction, always: xterm measures the cell box once and caches
    // it, so a face that lands later is measured as the fallback forever.
    await loadFonts(o.fonts ?? [], fontFamily);
    if (this.disposed) return this;

    const term = new Terminal(this.terminalOptions());
    this.terminal = term;
    o.onTerminalCreated?.(term);

    await this.installUnicode(term);

    this.fitAddon = new FitAddon();
    term.loadAddon(this.fitAddon);

    term.open(container);
    this.writer = new BatchedWriter(term);

    await this.installRenderer(term);
    await this.installGraphics(term, container);
    if (o.links) await this.installLinks(term);

    this.installClipboard(term, container);
    this.installInputPolicy(term, container);
    this.wireEvents(term);
    this.installFit(container);

    if (o.cols && o.rows) this.resize(o.cols, o.rows);
    else if (this.autoFit) this.fit();

    return this;
  }

  private terminalOptions(): ITerminalOptions & ITerminalInitOnlyOptions {
    const o = this.options;
    const base: ITerminalOptions & ITerminalInitOnlyOptions = {
      fontFamily: o.fontFamily ?? DEFAULT_FONT_FAMILY,
      fontSize: o.fontSize ?? 14,
      fontWeight: 'normal',
      fontWeightBold: 'bold',
      // No multiplier. The font's own line box already includes its line gap,
      // so scaling it again renders glyph ink taller than the cell and leaves
      // a background-coloured seam between stacked rows.
      lineHeight: o.lineHeight ?? 1.0,
      letterSpacing: 0,
      // A blinking cursor is a persistent animation, so it repaints an
      // otherwise idle terminal forever.
      cursorBlink: o.cursorBlink ?? false,
      cursorStyle: o.cursorStyle ?? 'block',
      cursorInactiveStyle: 'outline',
      scrollback: o.scrollback ?? 5000,
      tabStopWidth: 8,
      // Required for registerApcHandler and the unicode provider registry.
      allowProposedApi: true,
      allowTransparency: false,
      smoothScrollDuration: 0,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: true,
      drawBoldTextInBrightColors: false,
      fastScrollSensitivity: 5,
      minimumContrastRatio: 1,
      theme: resolveTheme(o.theme),
    };
    // Only when both are given: xterm validates cols and rows as numeric and
    // rejects an explicit undefined, so the keys have to be absent rather than
    // present and empty.
    if (o.cols !== undefined && o.rows !== undefined) {
      base.cols = o.cols;
      base.rows = o.rows;
    }
    // The escape hatch is merged last, so it wins over everything above.
    return { ...base, ...(o.xterm as ITerminalOptions | undefined) };
  }

  private async installUnicode(term: Terminal): Promise<void> {
    const provider = this.options.unicode?.provider ?? 'graphemes';
    if (provider !== 'graphemes') return;
    const overrides = this.options.unicode?.overrides ?? DEFAULT_OVERRIDES;
    try {
      const { UnicodeGraphemesAddon } = await import('@xterm/addon-unicode-graphemes');
      const addon = new UnicodeGraphemesAddon();
      const version = installUnicodeOverrides(term, addon, overrides);
      if (!version) {
        // The addon registered nothing recognisable, so leave it to stand on
        // its own rather than pinning a version string it may not have.
        console.warn('webterm: unicode overrides not installed, the addon registered no provider');
      }
    } catch (error) {
      console.warn('webterm: unicode graphemes addon failed to load', error);
    }
  }

  private async installRenderer(term: Terminal): Promise<void> {
    this.rendererManager = new RendererManager(
      term,
      {
        prefer: this.options.renderer?.prefer ?? 'auto',
        fallbackOnContextLoss: this.options.renderer?.fallbackOnContextLoss ?? true,
      },
      (renderer) => this.emitter.emit('renderer', renderer),
    );
    await this.rendererManager.install();
  }

  private async installGraphics(term: Terminal, container: HTMLElement): Promise<void> {
    const graphics = this.options.graphics ?? {};

    const kitty = graphics.kitty ?? true;
    if (kitty) {
      if (KittyGraphics.supported(term)) {
        const kittyOptions: KittyOptions = typeof kitty === 'object' ? kitty : {};
        this.overlay = new KittyGraphics(term, container, {
          ...kittyOptions,
          // A capability probe is only answered if the reply reaches the
          // application, so it takes the same route and the same read-only
          // gate a keystroke does.
          respond: (data) => {
            if (this.options.input?.readOnly) return;
            this.emitData(this.encoder.encode(data));
          },
        });
      } else {
        // @xterm/xterm 6.0.0 shipped without the APC parser this depends on;
        // 6.1.0 restored it. Warn rather than throw, so a consumer on such a
        // build still gets a working terminal without kitty graphics.
        console.warn(
          'webterm: kitty graphics disabled, this @xterm/xterm build has no parser.registerApcHandler',
        );
      }
    }

    if (graphics.sixel) {
      try {
        const { ImageAddon } = await import('@xterm/addon-image');
        const addon = new ImageAddon({
          enableSizeReports: true,
          sixelSupport: true,
          sixelScrolling: true,
          sixelPaletteLimit: 4096,
          sixelSizeLimit: 25_000_000,
          storageLimit: 128,
          ...(typeof graphics.sixel === 'object' ? graphics.sixel : {}),
          // Always off. The addon's own kitty implementation bakes placements
          // into the cell buffer, which cannot be repositioned, and it would
          // race the overlay for the same APC identifier.
          kittySupport: false,
        } as never);
        term.loadAddon(addon);
        this.imageAddon = addon;
        this.teardown.push(() => addon.dispose());
      } catch (error) {
        console.warn('webterm: image addon failed to load', error);
      }
    }
  }

  private async installLinks(term: Terminal): Promise<void> {
    try {
      const { WebLinksAddon } = await import('@xterm/addon-web-links');
      const addon = new WebLinksAddon();
      term.loadAddon(addon);
      this.teardown.push(() => addon.dispose());
    } catch (error) {
      console.warn('webterm: web links addon failed to load', error);
    }
  }

  private installClipboard(term: Terminal, container: HTMLElement): void {
    const options = this.options.clipboard ?? {};
    this.clipboard = new Clipboard(options, (event) => this.emitter.emit('clipboard', event));

    if (options.osc52 ?? true) {
      const handler = registerOsc52(term, this.clipboard, {
        read: options.osc52Read ?? false,
        reply: (text) => this.input(text),
      });
      if (handler) this.teardown.push(() => handler.dispose());
    }

    this.teardown.push(
      installCopyOnSelect(
        term,
        container,
        this.clipboard,
        // Read live, so setOptions takes effect without rebinding.
        () => this.options.clipboard?.copyOnSelect ?? false,
      ),
    );
  }

  private installInputPolicy(term: Terminal, container: HTMLElement): void {
    this.teardown.push(
      installContextMenuPolicy(container, () => ({
        suppressContextMenu: this.options.mouse?.suppressContextMenu ?? true,
      })),
    );

    if (this.options.keyboard?.kitty ?? true) {
      this.keyboardProtocol = new KittyKeyboard(term, {
        // Read live, so setOptions can turn the terminal read-only without the
        // protocol having to be torn down and reinstalled.
        enabled: () => !this.options.input?.readOnly,
        onKeyEvent: (event) => this.options.keyboard?.onKeyEvent?.(event) ?? true,
      });
    } else if (this.options.keyboard?.onKeyEvent) {
      // Without the protocol nothing else has claimed xterm's single custom key
      // handler slot, so a consumer's handler can take it directly.
      term.attachCustomKeyEventHandler(
        (event) => this.options.keyboard?.onKeyEvent?.(event) ?? true,
      );
    }

    const keys = installReservedKeyCapture({
      enabled: () => this.options.keyboard?.captureReservedKeys ?? true,
      keys: () => this.options.keyboard?.reservedKeys ?? DEFAULT_RESERVED_KEYS,
    });
    this.syncReservedKeys = keys.sync;
    this.teardown.push(() => keys.dispose());
  }

  private syncReservedKeys?: () => void;

  /**
   * The single outbound path for anything the terminal sends to the
   * application: keystrokes, pastes and protocol responses alike. Chunked, then
   * both announced to `data` listeners and written to the transport, so a
   * consumer that wires its own protocol by hand and one that calls `attach`
   * see exactly the same bytes.
   */
  private emitData(bytes: Uint8Array): void {
    for (const chunk of chunkBytes(bytes, this.options.input?.chunkBytes ?? DEFAULT_CHUNK_BYTES)) {
      this.emitter.emit('data', chunk);
      void this.transport?.send(chunk);
    }
  }

  private wireEvents(term: Terminal): void {
    const subs = [
      term.onData((data) => {
        if (this.options.input?.readOnly) return;
        this.emitData(this.encoder.encode(data));
      }),
      term.onBinary((data) => {
        if (this.options.input?.readOnly) return;
        if ((this.options.mouse?.dedupeMotion ?? true) && !this.motion.accept(data)) return;
        const bytes = binaryStringToBytes(data);
        this.emitter.emit('binary', bytes);
        void this.transport?.send(bytes);
      }),
      term.onTitleChange((title) => this.emitter.emit('title', title)),
      term.onBell(() => this.emitter.emit('bell')),
      term.onSelectionChange(() => this.emitter.emit('selection', term.getSelection())),
      term.onResize(({ cols, rows }) =>
        this.emitter.emit('resize', { cols, rows, pixel: this.pixelSize }),
      ),
    ];
    this.teardown.push(() => {
      for (const sub of subs) sub.dispose();
    });
  }

  private installFit(container: HTMLElement): void {
    const fit = this.options.fit ?? true;
    this.autoFit = fit !== false;
    if (!this.autoFit) return;

    const debounceMs = typeof fit === 'object' ? (fit.debounceMs ?? DEFAULT_FIT_DEBOUNCE_MS) : DEFAULT_FIT_DEBOUNCE_MS;
    const schedule = () => {
      if (!this.autoFit || this.disposed) return;
      if (this.fitTimer) clearTimeout(this.fitTimer);
      this.fitTimer = setTimeout(() => this.fit(), debounceMs);
    };

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(schedule);
      this.resizeObserver.observe(container);
    }
    window.addEventListener('resize', schedule, { passive: true });
    this.teardown.push(() => window.removeEventListener('resize', schedule));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.detach();
    if (this.fitTimer) clearTimeout(this.fitTimer);
    this.resizeObserver?.disconnect();
    for (const fn of this.teardown) {
      try {
        fn();
      } catch {
        // A disposal that races the terminal's own teardown is not a failure.
      }
    }
    this.teardown.length = 0;

    this.overlay?.dispose();
    this.keyboardProtocol?.dispose();
    this.rendererManager?.dispose();
    this.clipboard?.dispose();
    this.writer?.dispose();
    this.terminal?.dispose();
    this.emitter.clear();

    if (this.container) this.container.textContent = '';
    this.terminal = undefined;
    this.container = undefined;
  }

  // --- Geometry -------------------------------------------------------------

  /** Measure the container and resize the grid to fit it. */
  fit(): void {
    try {
      this.fitAddon?.fit();
    } catch {
      // fit() throws when the container has no layout yet, which happens while
      // it is still hidden. The next observation will retry.
    }
  }

  /**
   * Set the grid explicitly and stop fitting automatically.
   *
   * One-way for the life of the instance: fit() still refits once when called,
   * but it does not re-arm the ResizeObserver path.
   */
  resize(cols: number, rows: number): void {
    this.autoFit = false;
    this.terminal?.resize(cols, rows);
  }

  get cols(): number {
    return this.terminal?.cols ?? 0;
  }

  get rows(): number {
    return this.terminal?.rows ?? 0;
  }

  /**
   * The rendered grid size in CSS pixels.
   *
   * This is what a winsize report needs: applications that ask for the cell
   * size in pixels (kitty graphics sizing, sixel scaling) get a real answer
   * instead of zeros.
   */
  get pixelSize(): { width: number; height: number } {
    const screen = this.terminal?.element?.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen) return { width: 0, height: 0 };
    return { width: Math.round(screen.clientWidth), height: Math.round(screen.clientHeight) };
  }

  get renderer(): RendererKind {
    return this.rendererManager?.current ?? 'dom';
  }

  get element(): HTMLElement | undefined {
    return this.terminal?.element ?? undefined;
  }

  /**
   * The underlying xterm Terminal. Deliberately public: no wrapper anticipates
   * everything, and a consumer who needs term.parser, term.registerMarker or a
   * third-party addon should not have to fork the package to get it.
   */
  get xterm(): XtermTerminal {
    if (!this.terminal) throw new Error('webterm: the terminal is not open yet');
    return this.terminal;
  }

  /** The kitty overlay, when graphics.kitty is enabled and supported. */
  get kitty(): KittyGraphics | undefined {
    return this.overlay;
  }

  /**
   * The kitty keyboard protocol, when keyboard.kitty is enabled.
   *
   * Exposed so a consumer can read the flags an application has enabled, which
   * is the one piece of terminal state that changes how keys are encoded and is
   * otherwise invisible.
   */
  get keyboard(): KittyKeyboard | undefined {
    return this.keyboardProtocol;
  }

  /**
   * The @xterm/addon-image instance, when graphics.sixel loaded it.
   *
   * Exposed for the same reason `xterm` is: the addon has its own API for
   * storage limits and clearing, and it is dynamically imported here, so a
   * consumer has no other way to reach the instance that is actually attached.
   */
  get image(): ImageAddon | undefined {
    return this.imageAddon;
  }

  // --- IO -------------------------------------------------------------------

  focus(): void {
    this.terminal?.focus();
  }

  blur(): void {
    this.terminal?.blur();
  }

  clear(): void {
    this.terminal?.clear();
  }

  reset(): void {
    this.terminal?.reset();
    this.overlay?.reset();
    this.keyboardProtocol?.reset();
    this.motion.reset();
  }

  /** Feed bytes from the far end into the emulator. Batched to one frame. */
  write(data: Uint8Array | string): void {
    this.writer?.write(data);
  }

  /** Flush batched writes and resolve once the emulator has consumed them. */
  flush(): Promise<void> {
    return this.writer?.flush() ?? Promise.resolve();
  }

  /** Inject input as if it had been typed. Chunked per input.chunkBytes. */
  input(data: string): void {
    this.terminal?.input(data, true);
  }

  /** Insert text through the paste path, bracketed when the application asked. */
  paste(text: string): void {
    this.terminal?.paste(text);
  }

  // --- Transport ------------------------------------------------------------

  /** Attach a transport, replacing any current one. Returns a detach function. */
  attach(transport: Transport): () => void {
    this.detach();
    this.transport = transport;
    const sink: TransportSink = {
      data: (bytes) => this.write(bytes),
      closed: () => {
        if (this.transport === transport) this.transport = undefined;
      },
    };
    void Promise.resolve(transport.start(sink)).catch((error) => {
      console.warn('webterm: transport failed to start', error);
      if (this.transport === transport) this.transport = undefined;
    });
    return () => {
      if (this.transport === transport) this.detach();
    };
  }

  detach(): void {
    const transport = this.transport;
    this.transport = undefined;
    try {
      transport?.close();
    } catch {
      // A transport that is already closed is not an error at this point.
    }
  }

  // --- Options --------------------------------------------------------------

  setOptions(options: Partial<WebTermOptions>): void {
    this.options = { ...this.options, ...options };
    const term = this.terminal;
    if (!term) return;

    if (options.fontSize !== undefined) term.options.fontSize = options.fontSize;
    if (options.fontFamily !== undefined) {
      // The placeholder face lives at the end of the stack and has to survive
      // an embedder replacing the stack wholesale; see kitty/placeholder-glyph.
      term.options.fontFamily = this.overlay
        ? withPlaceholderFont(options.fontFamily)
        : options.fontFamily;
    }
    if (options.lineHeight !== undefined) term.options.lineHeight = options.lineHeight;
    if (options.cursorBlink !== undefined) term.options.cursorBlink = options.cursorBlink;
    if (options.cursorStyle !== undefined) term.options.cursorStyle = options.cursorStyle;
    if (options.scrollback !== undefined) term.options.scrollback = options.scrollback;
    if (options.theme !== undefined) this.setTheme(options.theme);
    if (options.xterm) Object.assign(term.options, options.xterm);
    if (options.keyboard) this.syncReservedKeys?.();
    if (options.fontSize !== undefined || options.fontFamily !== undefined) this.fit();
  }

  setTheme(theme: ITheme | ThemeName): void {
    this.options.theme = theme;
    if (this.terminal) this.terminal.options.theme = resolveTheme(theme);
  }

  // --- Events ---------------------------------------------------------------

  on<K extends keyof WebTermEvents>(event: K, listener: WebTermEvents[K]): () => void {
    return this.emitter.on(event, listener);
  }

  off<K extends keyof WebTermEvents>(event: K, listener: WebTermEvents[K]): void {
    this.emitter.off(event, listener);
  }
}
