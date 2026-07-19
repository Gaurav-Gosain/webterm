import type { ITheme, Terminal } from '@xterm/xterm';
import type { ThemeName } from './themes.js';

export type RendererKind = 'webgl' | 'canvas' | 'dom';

/** A face to load through the FontFace API before the Terminal is constructed. */
export interface FontSpec {
  /** Defaults to the first family named in `fontFamily`. */
  family?: string;
  /** A `url(...)` descriptor or a `data:` URI, as the FontFace constructor takes. */
  source: string;
  weight?: string;
  style?: string;
}

export interface RendererOptions {
  /** 'auto' probes webgl2/webgl, then canvas, then dom. Default 'auto'. */
  prefer?: 'auto' | RendererKind;
  /** Fall through to the next renderer on WebGL context loss. Default true. */
  fallbackOnContextLoss?: boolean;
}

export interface ClipboardOptions {
  /** Handle OSC 52 writes. Default true. */
  osc52?: boolean;
  /**
   * Answer OSC 52 read requests (payload '?'). Default false and it should stay
   * false: answering echoes the user's system clipboard back to the remote.
   */
  osc52Read?: boolean;
  /** Copy on mouseup when a selection exists. Default false. */
  copyOnSelect?: boolean;
  /** Replace the whole write path (Electron, a native host, a test double). */
  write?(text: string): void | Promise<void>;
}

export interface UnicodeOptions {
  /**
   * 'graphemes' dynamically imports @xterm/addon-unicode-graphemes and layers
   * `overrides` on top of it. 'v6' leaves xterm's built-in wcwidth provider in
   * place. 'none' installs nothing. Default 'graphemes'.
   */
  provider?: 'graphemes' | 'v6' | 'none';
  /** Codepoint to width. Default `{ 0x200b: 0 }`. Pass `{}` to disable. */
  overrides?: Record<number, 0 | 1 | 2>;
}

export interface KittyOptions {
  /**
   * 'scrollback' anchors a placement to its buffer row so it scrolls away with
   * the text, which is what a shell running chafa expects. It suits a
   * full-screen application too, since the alternate screen has no scrollback
   * and the anchoring row is the screen row there. 'viewport' pins a placement
   * to the visible grid, for an inline compositor on the main screen that
   * re-emits its placements every frame. Default 'scrollback'.
   */
  anchor?: 'scrollback' | 'viewport';
  /** Decoded bitmaps retained before the least recently used is evicted. Default 128. */
  storageLimit?: number;
  /** zIndex of the overlay layer. Default 5. */
  zIndex?: number;
}

export interface GraphicsOptions {
  /** Kitty graphics via the DOM overlay. Default true. */
  kitty?: boolean | KittyOptions;
  /**
   * Sixel and iTerm inline images via @xterm/addon-image. Default false: the
   * addon is around 76 KB and is dynamically imported only when this is set.
   * Its own kitty support is always forced off, because the overlay owns that.
   */
  sixel?: boolean | Record<string, unknown>;
}

export interface KeyboardOptions {
  /**
   * Take navigator.keyboard.lock for Ctrl+W and friends. The API is only ever
   * granted to a fullscreen document, so this does nothing outside fullscreen.
   * Default true.
   */
  captureReservedKeys?: boolean;
  /** Codes to lock. Default ['KeyW','KeyT','KeyN','KeyR','KeyL','Tab','Escape']. */
  reservedKeys?: string[];
  /**
   * The kitty keyboard protocol, which reports keys as CSI u sequences so an
   * application can tell ctrl+i from Tab, see key release, and read modifiers
   * on keys that have no legacy encoding for them. Default true.
   *
   * Enabling it changes nothing on its own. The protocol is entirely
   * application-driven: until a program pushes a non-zero flag set with
   * `CSI > flags u`, every key is encoded exactly as it was before, by xterm.
   * Turning this off means a program's request to enable it goes unanswered and
   * the terminal reports no support, which is the correct way to opt out.
   */
  kitty?: boolean;
  /**
   * Inspect every key event before the terminal does. Returning false stops the
   * key reaching the kitty protocol and xterm both.
   *
   * xterm's own `attachCustomKeyEventHandler` is a single slot that webterm
   * takes for the protocol, so this is the supported way to add a handler
   * without displacing it.
   */
  onKeyEvent?(event: KeyboardEvent): boolean;
}

export interface MouseOptions {
  /** Suppress the browser context menu; shift always shows it. Default true. */
  suppressContextMenu?: boolean;
  /** Drop SGR motion reports that repeat the last cell and button. Default true. */
  dedupeMotion?: boolean;
}

export interface InputOptions {
  /** Split outgoing writes larger than this across several sends. Default 65536. */
  chunkBytes?: number;
  /** Ignore all user input while still rendering output. Default false. */
  readOnly?: boolean;
}

export interface WebTermOptions {
  /** Font stack. The first family is what `fonts` entries are loaded as. */
  fontFamily?: string;
  fontSize?: number;
  /**
   * Faces to load through the FontFace API and await before the Terminal is
   * constructed. Skipping this and relying on a CSS @font-face races the
   * measurement: xterm caches the fallback face's cell box.
   */
  fonts?: FontSpec[];
  /**
   * The font's own line box already includes its line gap. Anything other than
   * 1 renders glyph ink taller than the cell and leaves a background-coloured
   * seam between stacked block glyphs. Exposed because someone will want it,
   * defaulted to the value that is correct.
   */
  lineHeight?: number;

  theme?: ITheme | ThemeName;
  /** Default false: a blinking cursor repaints an otherwise idle terminal forever. */
  cursorBlink?: boolean;
  cursorStyle?: 'block' | 'underline' | 'bar';
  scrollback?: number;

  /** Initial grid. Omit under `fit: true`, which measures the container. */
  cols?: number;
  rows?: number;
  /** Refit on container resize through a ResizeObserver. Default true. */
  fit?: boolean | { debounceMs?: number };

  /** Load @xterm/addon-web-links. Default false. */
  links?: boolean;

  renderer?: RendererOptions;
  clipboard?: ClipboardOptions;
  unicode?: UnicodeOptions;
  graphics?: GraphicsOptions;
  keyboard?: KeyboardOptions;
  mouse?: MouseOptions;
  input?: InputOptions;

  /** Escape hatch: merged into the xterm ITerminalOptions last, so it wins. */
  xterm?: Record<string, unknown>;
  /** Escape hatch: called with the Terminal after construction, before open. */
  onTerminalCreated?(term: Terminal): void;
}

export interface ResizeEvent {
  cols: number;
  rows: number;
  /** Rendered grid size in CSS pixels, for a winsize report. */
  pixel: { width: number; height: number };
}

export interface ClipboardEvent {
  text: string;
  /** False when every write strategy was refused. */
  written: boolean;
}

export interface WebTermEvents {
  /** User input, UTF-8 encoded, already chunked. */
  data: (bytes: Uint8Array) => void;
  /** Mouse and other binary reports, after motion dedup. */
  binary: (bytes: Uint8Array) => void;
  resize: (size: ResizeEvent) => void;
  title: (title: string) => void;
  bell: () => void;
  selection: (text: string) => void;
  /** OSC 52 or copy-on-select produced a clipboard write. */
  clipboard: (event: ClipboardEvent) => void;
  /** The active renderer changed, including a WebGL context-loss fallback. */
  renderer: (renderer: RendererKind) => void;
}

/**
 * How bytes reach the terminal and leave it.
 *
 * There is deliberately no framing here. A consumer with an existing protocol
 * implements these three methods and the package never learns anything about
 * their message headers, length prefixes or keepalives.
 */
export interface Transport {
  /**
   * Called on attach. Resolving means connected; rejecting means the attach
   * failed and any fallback should be tried.
   */
  start(sink: TransportSink): void | Promise<void>;
  /** Bytes headed outward. Already chunked per `input.chunkBytes`. */
  send(bytes: Uint8Array): void | Promise<void>;
  close(): void;
  readonly name?: string;
}

export interface TransportSink {
  data(bytes: Uint8Array): void;
  /** Reports a clean or unclean close. Drives the reconnecting wrapper. */
  closed(error?: Error): void;
}
