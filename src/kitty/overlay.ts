/*
 * A kitty graphics protocol implementation that renders images as
 * absolutely-positioned DOM canvases in an overlay above xterm.js, instead of
 * baking them into the cell buffer the way @xterm/addon-image does. That is the
 * whole reason this exists: a placement in the cell buffer cannot be moved, and
 * moving placements is what an application that redraws, scrolls or repositions
 * an image needs.
 *
 *   - Update a placement in place (re-emit a=p with the same i,p and the canvas
 *     moves, rather than a second canvas stacking on the first).
 *   - Delete one placement (d=p,i=N,p=M) without discarding the image bytes, so
 *     a later re-place still works.
 *   - Source-region clipping (x,y,w,h) through drawImage arguments.
 *   - Track scroll, resize and font change, and reposition everything live.
 *
 * Placements are anchored to a buffer row through an xterm marker, so they
 * scroll with their text, survive scrollback trimming and are dropped when the
 * row they belong to falls out of history. After a placement the cursor is
 * moved past the image as the protocol requires, so the cells it covers are
 * genuinely consumed in the buffer rather than only painted over.
 *
 * Supported subset:
 *
 *   Actions:  a=t, a=T, a=p, a=d, a=q
 *   Medium:   t=d (direct base64) only
 *   Formats:  f=24 (RGB), f=32 (RGBA), f=100 (PNG)
 *   Compress: o=z (zlib through DecompressionStream)
 *   Chunks:   m=0, m=1, accumulated per image id until m=0
 *   Keys:     i, I, p, s, v, c, r, x, y, w, h, X, Y, z, C, q
 *   Delete:   d=a|A (all), d=i|I (by image id), d=p|P (by placement id)
 *
 * Deliberately out of scope:
 *   - Animation (a=f, a=a, a=c)
 *   - File, temp file and shared memory transmission (t=f, t=t, t=s). A browser
 *     cannot read the sender's filesystem; a server that wants these to work
 *     re-encodes them into direct transmissions before they reach the page.
 *   - Unicode placeholder placement (U=1)
 */
import type { IMarker, Terminal } from '@xterm/xterm';
import type { KittyOptions } from '../types.js';
import {
  KITTY_APC_IDENT,
  base64Decode,
  clampSourceRect,
  fitRgba,
  inflate,
  rgbToRgba,
  splitApc,
  type KittyCommand,
} from './protocol.js';

/**
 * The slice of xterm's private input handler the cursor advance drives.
 *
 * `lineFeed` is the same entry point the parser uses for a `\n`, so it scrolls
 * at the bottom of the screen and keeps the buffer consistent. `_moveCursor` is
 * optional: losing it costs the horizontal half of the movement, not the rows.
 */
interface InputHandlerLike {
  lineFeed(): void;
  _moveCursor?(x: number, y: number): void;
}

interface StoredImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** Monotonic counter for least-recently-used eviction. */
  used: number;
}

/**
 * Where a placement was anchored, kept beside the command rather than merged
 * into it: KittyCommand is an index-signature bag of protocol keys, and a
 * marker is neither a string nor a number.
 */
interface PlaceAnchor {
  cellX: number;
  /** Under 'scrollback' this is an absolute buffer row; under 'viewport' a screen row. */
  row: number;
  marker?: IMarker;
  alt: boolean;
}

interface PlaceSpec {
  cmd: KittyCommand;
  anchor: PlaceAnchor;
  /** The rectangle in cells the cursor advance consumed, when it ran. */
  cells?: { cols: number; rows: number };
}

interface Placement {
  imageId: number;
  placementId: number;
  canvas: HTMLCanvasElement;
  cellX: number;
  row: number;
  cols: number;
  rows: number;
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
  z: number;
  /**
   * A marker on the anchoring line, under the 'scrollback' anchor.
   *
   * xterm keeps a marker's `line` correct as the scrollback fills and old lines
   * are trimmed off the top, and disposes it when its line is trimmed away
   * entirely. A bare absolute row cannot do either: it silently drifts by the
   * trim count once the scrollback saturates, and nothing ever tells the
   * overlay the row it was anchored to no longer exists.
   */
  marker?: IMarker;
  /** True when the placement was made on the alternate screen. */
  alt: boolean;
}

export interface KittyGraphicsOptions extends KittyOptions {
  /** Overlay class name, so a consumer can style or find the layer. */
  className?: string;
  /**
   * Sends a protocol response back to the application, by the same route a
   * keystroke takes.
   *
   * Kitty graphics is request/response for capability detection: a client
   * emits `a=q` probes and refuses to send any image at all if none of them
   * come back. Leaving this unset renders images from a sender that transmits
   * unconditionally, and makes every well-behaved client conclude the terminal
   * has no graphics support. `WebTerm` wires it to the `data` event.
   */
  respond?(data: string): void;
}

/**
 * Register the kitty APC handler across the two shapes xterm has shipped.
 *
 * Older builds take the identifier as a number and hand the callback the
 * payload including the ident byte. Current builds take an IFunctionIdentifier
 * (`{ final: 'G' }`) and strip the ident first. splitApc tolerates both, so all
 * that differs here is the argument. The number form is tried second because
 * the object form is what the API is documented as taking now.
 */
function registerKittyApc(
  term: Terminal,
  handler: (data: string) => boolean,
): { dispose(): void } {
  const parser = term.parser as unknown as {
    registerApcHandler(id: unknown, callback: (data: string) => boolean): { dispose(): void };
  };
  try {
    return parser.registerApcHandler({ final: String.fromCharCode(KITTY_APC_IDENT) }, handler);
  } catch {
    return parser.registerApcHandler(KITTY_APC_IDENT, handler);
  }
}

export class KittyGraphics {
  private readonly anchor: 'scrollback' | 'viewport';
  private readonly storageLimit: number;

  /** Decoded images, keyed by the resolved image id. */
  private readonly images = new Map<number, StoredImage>();
  /**
   * Image ids assigned to client-chosen image numbers (`I`).
   *
   * `i` and `I` are different namespaces. `i` is an id the client picks and
   * the terminal must use as given; `I` is a number the client picks and the
   * terminal must map to an id of its own choosing, echo back in its
   * responses, and honour on any later command addressed by that number.
   * Without this map every `I`-addressed image lands on id 0 and they
   * overwrite each other, which is what `kitten icat` and yazi trip over
   * since both address by number.
   */
  private readonly idByNumber = new Map<number, number>();
  /**
   * Next id to hand out for an image number. Kept well above the range a
   * client is likely to choose for `i` so an assigned id cannot collide with
   * one the client names itself.
   */
  private nextAssignedId = 0x7000_0000;
  /**
   * The key of the transmission most recently opened, so continuation chunks
   * that carry no id keys at all still land on the right entry.
   */
  private lastTransmitKey: string | null = null;
  /**
   * Transmitted `s`/`v` pixel sizes, keyed by image id, recorded before the
   * decode settles so a placement can size itself synchronously.
   */
  private readonly pixelSizes = new Map<number, { width: number; height: number }>();
  /** Active placements, keyed by `imageId/placementId`. */
  private readonly placements = new Map<string, Placement>();
  /** Chunked transmissions in progress, keyed by image id. */
  private readonly pending = new Map<string, { params: KittyCommand; chunks: string[] }>();
  /** The placement an a=T stream will apply once its transmit phase finishes. */
  private readonly pendingPlacement = new Map<string, PlaceSpec>();
  /**
   * Place commands that arrived before the referenced image finished decoding.
   * createImageBitmap is asynchronous and a sender typically emits a=t then a=p
   * back to back in one burst, so the place lands on the parser before the
   * bitmap does. Keyed by image id.
   */
  private readonly deferredPlacements = new Map<number, PlaceSpec[]>();
  /**
   * Image ids with a decode in flight, so a place can tell "retry when it
   * lands" from "this was never transmitted, drop it".
   */
  private readonly decoding = new Set<number>();

  readonly element: HTMLDivElement;
  private disposed = false;
  private repositionPending = false;
  private handler: InputHandlerLike | null = null;
  private handlerChecked = false;
  private useCounter = 0;
  private readonly teardown: Array<() => void> = [];
  private readonly term: Terminal;
  private readonly respond?: (data: string) => void;

  constructor(term: Terminal, container: HTMLElement, options: KittyGraphicsOptions = {}) {
    this.term = term;
    this.anchor = options.anchor ?? 'scrollback';
    this.storageLimit = options.storageLimit ?? 128;
    this.respond = options.respond;

    this.element = document.createElement('div');
    this.element.className = options.className ?? 'webterm-kitty-overlay';
    Object.assign(this.element.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      overflow: 'hidden',
      zIndex: String(options.zIndex ?? 5),
    });
    // Absolute children need a positioned ancestor to anchor against.
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(this.element);

    this.install();
  }

  /** True when the running xterm build exposes the APC parser this depends on. */
  static supported(term: Terminal): boolean {
    return typeof (term.parser as { registerApcHandler?: unknown }).registerApcHandler === 'function';
  }

  private install(): void {
    const apc = registerKittyApc(this.term, (data) => this.onApc(data));
    this.teardown.push(() => apc.dispose());

    // Reposition on scroll and resize, batched to a microtask so a burst of
    // updates costs one layout pass rather than one per event.
    const schedule = () => {
      if (this.repositionPending || this.disposed) return;
      this.repositionPending = true;
      queueMicrotask(() => {
        this.repositionPending = false;
        if (!this.disposed) this.repositionAll();
      });
    };
    const onScroll = this.term.onScroll(schedule);
    const onResize = this.term.onResize(schedule);
    this.teardown.push(() => onScroll.dispose(), () => onResize.dispose());

    // Switching screens changes which placements are on screen at all, and the
    // alternate screen's own placements are discarded with its text.
    const onBufferChange = this.term.buffer.onBufferChange(() => {
      this.dropPlacements((p) => p.alt);
      schedule();
    });
    this.teardown.push(() => onBufferChange.dispose());

    // "The clear screen escape code (usually <ESC>[2J) should also clear all
    // images. This is so that the clear command works." The partial erases
    // (0J, 1J) must leave graphics alone, so only 2J and 3J are acted on.
    // The handler returns false so xterm still performs the erase itself.
    try {
      const onErase = this.term.parser.registerCsiHandler({ final: 'J' }, (params) => {
        const mode = Number(params[0] ?? 0);
        if (mode === 2 || mode === 3) this.dropPlacements(() => true);
        return false;
      });
      this.teardown.push(() => onErase.dispose());
    } catch {
      // A build without registerCsiHandler keeps images across a clear.
    }
    // A font size or device pixel ratio change also shifts the cell box.
    window.addEventListener('resize', schedule, { passive: true });
    this.teardown.push(() => window.removeEventListener('resize', schedule));
  }

  /** Remove the placements matching `predicate`, leaving the image data alone. */
  private dropPlacements(predicate: (p: Placement) => boolean): void {
    for (const [key, p] of [...this.placements]) {
      if (!predicate(p)) continue;
      this.detach(p);
      this.placements.delete(key);
    }
  }

  /** Drop every placement and image, as on a terminal reset. */
  reset(): void {
    for (const placement of this.placements.values()) this.detach(placement);
    this.placements.clear();
    for (const image of this.images.values()) this.closeBitmap(image.bitmap);
    this.images.clear();
    this.idByNumber.clear();
    this.pixelSizes.clear();
    this.pending.clear();
    this.pendingPlacement.clear();
    this.deferredPlacements.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const fn of this.teardown) {
      try {
        fn();
      } catch {
        // Disposal races a terminal that is already tearing down.
      }
    }
    this.teardown.length = 0;
    this.reset();
    this.element.remove();
  }

  get placementCount(): number {
    return this.placements.size;
  }

  get imageCount(): number {
    return this.images.size;
  }

  // --- APC dispatch ---------------------------------------------------------

  private onApc(data: string): boolean {
    const { control, payload } = splitApc(data);
    const action = (control.a as string) || 't';

    try {
      switch (action) {
        case 't':
          this.handleTransmit(control, payload, false);
          break;
        case 'T':
          this.handleTransmit(control, payload, true);
          break;
        case 'p':
          this.handlePlace(control);
          break;
        case 'd':
          this.handleDelete(control);
          break;
        case 'q':
          this.handleQuery(control);
          break;
        default:
          // Unknown action: swallow, so the payload does not leak to the screen.
          break;
      }
    } catch (error) {
      console.warn('webterm: kitty handler error', error, control);
    }
    return true;
  }

  // --- Query / response -----------------------------------------------------

  /**
   * Answer an `a=q` capability probe.
   *
   * kitten icat opens with three probes in one burst, then a primary device
   * attributes request as a sentinel:
   *
   *   ESC _ G a=q,f=24,s=1,v=1,S=3,i=1;MTIz          ESC \   direct
   *   ESC _ G a=q,f=24,t=t,s=1,v=1,S=47,i=2;<path>   ESC \   temp file
   *   ESC _ G a=q,f=24,t=s,s=1,v=1,S=18,i=3;<name>   ESC \   shared memory
   *   ESC [ c
   *
   * It picks a transfer mode from whichever probes come back OK, and if the
   * DA1 reply arrives with no graphics reply at all it decides the terminal
   * has no support and refuses to send the image.
   *
   * Only direct transmission is answered OK. The temp-file and shared-memory
   * media name paths in the far end's filesystem, which a browser cannot read,
   * so those are reported unsupported and the client settles on stream mode,
   * which is the direct base64 form this overlay decodes.
   */
  private handleQuery(cmd: KittyCommand): void {
    if ((cmd.t ?? 'd') === 'd') {
      this.sendResponse(cmd, 'OK');
    } else {
      this.sendResponse(cmd, 'ENOTSUPPORTED:transmission medium not supported by a browser client');
    }
  }

  /**
   * Emit `ESC _ G <id keys> ; <message> ESC \` back to the application.
   *
   * The id keys are echoed from the request so the client can match the reply
   * to its probe. A command carrying neither `i` nor `I` is unaddressable and
   * per the protocol gets no reply at all. Quiet mode suppresses replies: q=1
   * drops successes, q=2 drops everything. Errors are reported rather than
   * dropped, since a client that gets no answer waits out its timeout instead
   * of moving on.
   */
  private sendResponse(cmd: KittyCommand, message: string, assignedId?: number): void {
    if (!this.respond) return;

    const quiet = cmd.q ?? 0;
    const ok = message === 'OK';
    if (quiet >= 2) return;
    if (quiet >= 1 && ok) return;

    const keys: string[] = [];
    // When the client addressed the image by number, report the id its number
    // resolved to rather than the `i` it did not send.
    const id = cmd.i !== undefined && cmd.i !== 0 ? cmd.i : assignedId;
    if (id !== undefined && id !== 0) keys.push(`i=${id}`);
    if (cmd.I !== undefined && cmd.I !== 0) keys.push(`I=${cmd.I}`);
    if (keys.length === 0) return;
    if (cmd.p !== undefined && cmd.p !== 0) keys.push(`p=${cmd.p}`);

    try {
      this.respond(`\x1b_G${keys.join(',')};${message}\x1b\\`);
    } catch (error) {
      console.warn('webterm: kitty response failed', error);
    }
  }

  // --- Image ids ------------------------------------------------------------

  /**
   * The image id a command addresses.
   *
   * An explicit `i` wins, since the client named it. Otherwise `I` is resolved
   * through the number map, assigning an id on first sight when `assign` is
   * set. A command carrying neither addresses image 0, which is the protocol's
   * unaddressed default.
   */
  private resolveImageId(cmd: KittyCommand, assign: boolean): number {
    if (cmd.i !== undefined && cmd.i !== 0) return cmd.i;
    const number = cmd.I ?? 0;
    if (!number) return 0;
    const existing = this.idByNumber.get(number);
    if (existing !== undefined) return existing;
    if (!assign) return 0;
    const assigned = this.nextAssignedId++;
    this.idByNumber.set(number, assigned);
    return assigned;
  }

  /** Forget the number pointing at `imageId`, once its data is freed. */
  private forgetNumber(imageId: number): void {
    for (const [number, id] of this.idByNumber) {
      if (id === imageId) this.idByNumber.delete(number);
    }
  }

  // --- Transmit -------------------------------------------------------------

  private handleTransmit(cmd: KittyCommand, payload: string, andPlace: boolean): void {
    // Only direct base64 transmission is supported; see the header.
    if ((cmd.t ?? 'd') !== 'd') return;

    // A continuation chunk may carry no id keys at all, in which case it
    // belongs to the transmission already in flight rather than to image 0.
    const addressed = (cmd.i ?? 0) !== 0 || (cmd.I ?? 0) !== 0;
    const key =
      !addressed && this.lastTransmitKey && this.pending.has(this.lastTransmitKey)
        ? this.lastTransmitKey
        : `i:${this.resolveImageId(cmd, true)}`;
    this.lastTransmitKey = key;
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { params: { ...cmd }, chunks: [] };
      this.pending.set(key, entry);
      if (andPlace) {
        // The first chunk of an a=T stream carries the placement parameters.
        // The cursor position is captured now so the placement lands where the
        // sender expects even if the cursor moves during streaming.
        this.pendingPlacement.set(key, { cmd: { ...cmd }, anchor: this.cursorAnchor() });
      }
    } else {
      // Fill in keys that only appear on a later chunk, which some senders do
      // for placement parameters. Never clobber a key the first chunk set.
      for (const k of Object.keys(cmd)) {
        if (entry.params[k] === undefined) entry.params[k] = cmd[k];
      }
      if (andPlace && !this.pendingPlacement.has(key)) {
        this.pendingPlacement.set(key, { cmd: { ...entry.params }, anchor: this.cursorAnchor() });
      }
    }

    if (payload) entry.chunks.push(payload);
    // m=1 means more chunks follow.
    if (cmd.m === 1) return;

    const fullB64 = entry.chunks.join('');
    const params = entry.params;
    this.pending.delete(key);
    const placementSpec = this.pendingPlacement.get(key);
    this.pendingPlacement.delete(key);

    this.lastTransmitKey = null;
    const imageId = Number(key.slice(2));
    // Tell the client which id its image number was given. A client that
    // addresses by number has no other way to learn it, and one that is
    // waiting on the acknowledgement will not place the image until it lands.
    this.sendResponse({ ...params, i: params.i, I: params.I }, 'OK', imageId);
    if (params.s && params.v) {
      this.pixelSizes.set(imageId, { width: params.s, height: params.v });
    }
    // The cursor moves here, at the end of the transmission and while the
    // parser is still inside this APC, rather than when the decode settles: by
    // then the bytes that follow the image in the stream have already been
    // printed, and they would be printed over it.
    if (placementSpec) {
      placementSpec.cells = this.applyCursorPolicy(params, this.sourceSize(imageId)) ?? undefined;
    }
    this.decoding.add(imageId);
    this.decodeAndStore(imageId, params, fullB64)
      .then(() => {
        this.decoding.delete(imageId);
        if (this.disposed) return;
        if (placementSpec) this.placeImage(imageId, placementSpec);
        // Drain places that arrived while the decode was in flight.
        const queued = this.deferredPlacements.get(imageId);
        if (queued) {
          this.deferredPlacements.delete(imageId);
          for (const spec of queued) this.placeImage(imageId, spec);
        }
      })
      .catch((error) => {
        this.decoding.delete(imageId);
        this.deferredPlacements.delete(imageId);
        console.warn('webterm: kitty decode failed', error);
      });
  }

  private async decodeAndStore(
    imageId: number,
    params: KittyCommand,
    b64: string,
  ): Promise<void> {
    const raw = base64Decode(b64);
    const bytes = params.o === 'z' ? await inflate(raw) : raw;

    const format = params.f ?? 32;
    const width = params.s ?? 0;
    const height = params.v ?? 0;

    let bitmap: ImageBitmap;
    if (format === 100) {
      bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }));
    } else if (format === 24 || format === 32) {
      if (!width || !height) throw new Error('raw pixel transmission needs s and v');
      const rgba = format === 24 ? rgbToRgba(bytes, width, height) : bytes;
      const fitted = fitRgba(rgba, width, height);
      // A view, not a copy: the buffer is already the right bytes and a raw
      // frame can be several megabytes.
      const view = new Uint8ClampedArray(
        fitted.data.buffer as ArrayBuffer,
        fitted.data.byteOffset,
        fitted.data.byteLength,
      );
      const imageData = new ImageData(view, width, fitted.height);
      bitmap = await createImageBitmap(imageData);
    } else {
      throw new Error(`unsupported format f=${format}`);
    }

    if (this.disposed) {
      this.closeBitmap(bitmap);
      return;
    }

    // An image already under this id means a re-transmit, which is how
    // per-frame video playback works: the sender keeps i= constant and just
    // refreshes the data. Close the old bitmap to free its memory, then
    // re-render every placement referencing the id so the new frame is what is
    // shown rather than the stale bitmap already painted onto those canvases.
    const previous = this.images.get(imageId);
    if (previous) this.closeBitmap(previous.bitmap);

    const entry: StoredImage = {
      bitmap,
      width: bitmap.width,
      height: bitmap.height,
      used: ++this.useCounter,
    };
    this.images.set(imageId, entry);
    // The decoded size is the authoritative one; a PNG carries its own
    // dimensions and the transmitted s/v may have been absent or approximate.
    this.pixelSizes.set(imageId, { width: bitmap.width, height: bitmap.height });
    this.evict();

    if (previous) {
      for (const placement of this.placements.values()) {
        if (placement.imageId === imageId) this.renderPlacement(placement, entry);
      }
    }
  }

  /** Evict least recently used images past the storage limit, placements aside. */
  private evict(): void {
    if (this.images.size <= this.storageLimit) return;
    const placed = new Set<number>();
    for (const placement of this.placements.values()) placed.add(placement.imageId);
    const candidates = [...this.images.entries()]
      .filter(([id]) => !placed.has(id))
      .sort((a, b) => a[1].used - b[1].used);
    for (const [id, image] of candidates) {
      if (this.images.size <= this.storageLimit) break;
      this.closeBitmap(image.bitmap);
      this.images.delete(id);
      this.pixelSizes.delete(id);
    }
  }

  private closeBitmap(bitmap: ImageBitmap): void {
    try {
      bitmap.close?.();
    } catch {
      // Already closed, or a browser without ImageBitmap.close.
    }
  }

  // --- Place ----------------------------------------------------------------

  private handlePlace(cmd: KittyCommand): void {
    // Resolve only: a place naming a number never transmitted has nothing to
    // show, and assigning an id for it would strand the entry.
    const imageId = this.resolveImageId(cmd, false);
    const spec: PlaceSpec = { cmd, anchor: this.cursorAnchor() };

    // Before anything else, and whether or not the image has arrived: the
    // placement occupies those cells either way, and the stream after it is
    // written on the assumption that the cursor has moved past them.
    spec.cells = this.applyCursorPolicy(cmd, this.sourceSize(imageId)) ?? undefined;

    if (this.images.has(imageId)) {
      this.placeImage(imageId, spec);
      return;
    }

    if (this.decoding.has(imageId)) {
      // Queue it. If several places for the same placement id arrive before
      // the decode settles, only the most recent position matters, so replace
      // rather than append.
      let queue = this.deferredPlacements.get(imageId);
      if (!queue) {
        queue = [];
        this.deferredPlacements.set(imageId, queue);
      }
      const pid = (spec.cmd.p ?? 0) || 1;
      const existing = queue.findIndex((s) => ((s.cmd.p ?? 0) || 1) === pid);
      if (existing >= 0) queue[existing] = spec;
      else queue.push(spec);
      return;
    }

    // The image was never transmitted, or was evicted. Nothing to place.
  }

  private placeImage(imageId: number, spec: PlaceSpec): void {
    const img = this.images.get(imageId);
    if (!img) return;
    img.used = ++this.useCounter;

    const placementId = (spec.cmd.p ?? 0) || 1;
    const key = `${imageId}/${placementId}`;

    const srcW = (spec.cmd.w ?? 0) || img.width;
    const srcH = (spec.cmd.h ?? 0) || img.height;
    // The same derivation the cursor advance used, so the cells the canvas
    // covers and the cells the cursor consumed are the same cells.
    const size = spec.cells ?? this.placementCells(spec.cmd, img) ?? { cols: 1, rows: 1 };
    const { cols, rows } = size;

    let placement = this.placements.get(key);
    if (!placement) {
      const canvas = document.createElement('canvas');
      Object.assign(canvas.style, {
        position: 'absolute',
        pointerEvents: 'none',
        imageRendering: 'auto',
      });
      this.element.appendChild(canvas);
      placement = {
        imageId,
        placementId,
        canvas,
      } as Placement;
      this.placements.set(key, placement);
    }

    // Re-placing the same image and placement id moves it, so the marker that
    // held the old row is finished with. The field is reassigned before the old
    // marker is disposed, because disposing it runs onMarkerDisposed, which
    // drops every placement still pointing at it.
    const previousMarker = placement.marker;
    placement.marker = spec.anchor.marker;
    if (previousMarker && previousMarker !== spec.anchor.marker) this.disposeMarker(previousMarker);
    placement.alt = spec.anchor.alt;
    placement.cellX = spec.anchor.cellX | 0;
    placement.row = spec.anchor.row | 0;
    placement.cols = cols;
    placement.rows = rows;
    placement.srcX = spec.cmd.x ?? 0;
    placement.srcY = spec.cmd.y ?? 0;
    placement.srcW = srcW;
    placement.srcH = srcH;
    placement.z = spec.cmd.z ?? 0;

    this.renderPlacement(placement, img);
    this.positionPlacement(placement);
  }

  private renderPlacement(p: Placement, img: StoredImage): void {
    const cell = this.cellPixels();
    const dpr = window.devicePixelRatio || 1;
    // Clamp to the grid so an image does not overflow the terminal when it is
    // resized smaller than the placement.
    const screenRow = this.screenRow(p);
    const maxCols = Math.max(1, this.term.cols - p.cellX);
    const maxRows = Math.max(1, this.term.rows - Math.max(0, screenRow));
    const cssW = Math.min(p.cols, maxCols) * cell.width;
    const cssH = Math.min(p.rows, maxRows) * cell.height;

    const canvas = p.canvas;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.style.zIndex = String(p.z);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const src = clampSourceRect({ x: p.srcX, y: p.srcY, w: p.srcW, h: p.srcH }, img);
    if (src.w > 0 && src.h > 0) {
      ctx.drawImage(img.bitmap, src.x, src.y, src.w, src.h, 0, 0, cssW, cssH);
    }
  }

  private positionPlacement(p: Placement): void {
    const cell = this.cellPixels();
    const screenRow = this.screenRow(p);
    p.canvas.style.transform = `translate(${p.cellX * cell.width}px, ${screenRow * cell.height}px)`;
    // A placement belongs to the screen it was made on. The alternate screen is
    // a separate buffer with its own coordinates, so a main-screen placement
    // must not be painted over a full-screen application, nor the reverse.
    const onThisScreen = p.alt === (this.term.buffer.active.type === 'alternate');
    const visible = onThisScreen && screenRow + p.rows > 0 && screenRow < this.term.rows;
    p.canvas.style.display = visible ? 'block' : 'none';
  }

  private repositionAll(): void {
    // The cell box may have changed as well as the scroll position, so this
    // re-renders as well as repositioning.
    for (const p of this.placements.values()) {
      const img = this.images.get(p.imageId);
      if (img) this.renderPlacement(p, img);
      this.positionPlacement(p);
    }
  }

  // --- Delete ---------------------------------------------------------------

  private handleDelete(cmd: KittyCommand): void {
    const selector = (cmd.d as string) || 'a';
    // An uppercase selector means free the image data too, not just the
    // placement.
    const freeData = selector === selector.toUpperCase();

    switch (selector.toLowerCase()) {
      case 'a': {
        for (const p of this.placements.values()) this.detach(p);
        this.placements.clear();
        if (freeData) {
          for (const image of this.images.values()) this.closeBitmap(image.bitmap);
          this.images.clear();
          this.idByNumber.clear();
          this.pixelSizes.clear();
        }
        break;
      }
      // 'i' addresses by image id, 'n' by image number; both land on the same
      // resolved id, so they share this arm.
      case 'i':
      case 'n': {
        const id = this.resolveImageId(cmd, false);
        for (const [k, p] of [...this.placements]) {
          if (p.imageId !== id) continue;
          this.detach(p);
          this.placements.delete(k);
        }
        if (freeData) {
          const image = this.images.get(id);
          if (image) this.closeBitmap(image.bitmap);
          this.images.delete(id);
          this.pixelSizes.delete(id);
          this.forgetNumber(id);
        }
        break;
      }
      case 'p': {
        const key = `${this.resolveImageId(cmd, false)}/${cmd.p ?? 0}`;
        const p = this.placements.get(key);
        if (p) {
          this.detach(p);
          this.placements.delete(key);
        }
        break;
      }
      default:
        // Other selectors (n, z, x, y and the rest) are not implemented.
        break;
    }
  }

  private detach(p: Placement): void {
    p.canvas.remove();
    const marker = p.marker;
    p.marker = undefined;
    if (marker) this.disposeMarker(marker);
  }

  /** Dispose a marker, tolerating one xterm already disposed with its line. */
  private disposeMarker(marker: IMarker): void {
    try {
      if (!marker.isDisposed) marker.dispose();
    } catch {
      // The line was trimmed out from under it.
    }
  }

  // --- Cursor ---------------------------------------------------------------

  /**
   * The placement rectangle in cells.
   *
   * `c` and `r` win when the sender gives them. When only one is given the
   * other follows from the source aspect ratio, so the image is displayed
   * undistorted. When neither is given the rectangle is the source pixel size
   * measured against the cell box, which is the case that matters in practice:
   * `kitten icat` sends the pixel dimensions and no `c`/`r` at all, and leaves
   * the terminal to work out how many cells that is.
   *
   * Returns null when there is nothing to derive from, so a caller can tell
   * "zero cells" from "not known yet".
   */
  private placementCells(
    cmd: KittyCommand,
    source: { width: number; height: number } | undefined,
  ): { cols: number; rows: number } | null {
    let cols = cmd.c ?? 0;
    let rows = cmd.r ?? 0;
    if (cols > 0 && rows > 0) return { cols, rows };

    const srcW = (cmd.w ?? 0) || source?.width || 0;
    const srcH = (cmd.h ?? 0) || source?.height || 0;
    if (!srcW || !srcH) {
      if (cols > 0 || rows > 0) return { cols: Math.max(1, cols), rows: Math.max(1, rows) };
      return null;
    }

    const cell = this.cellPixels();
    if (cols > 0) {
      rows = Math.max(1, Math.round((cols * cell.width * srcH) / (srcW * cell.height)));
    } else if (rows > 0) {
      cols = Math.max(1, Math.round((rows * cell.height * srcW) / (srcH * cell.width)));
    } else {
      cols = Math.max(1, Math.ceil(srcW / cell.width));
      rows = Math.max(1, Math.ceil(srcH / cell.height));
    }
    return { cols, rows };
  }

  /**
   * The pixel size of an image, as far as it is known synchronously.
   *
   * Decoding is asynchronous but the cursor has to move at the moment the
   * placement is parsed, so the transmitted `s`/`v` are recorded up front and
   * used until the real bitmap dimensions replace them.
   */
  private sourceSize(imageId: number): { width: number; height: number } | undefined {
    return this.images.get(imageId) ?? this.pixelSizes.get(imageId);
  }

  /**
   * Move the cursor as the protocol requires once an image has been placed.
   *
   * The spec: "After placing an image on the screen the cursor must be moved to
   * the right by the number of cols in the image placement rectangle and down
   * by the number of rows". `kitten icat` depends on it completely, emitting
   * only a trailing CR LF of its own, so a terminal that does not move the
   * cursor draws the next prompt straight through the image.
   *
   * This has to happen at the exact point in the stream where the placement was
   * parsed. `term.write` cannot do it: xterm appends a write made from inside a
   * parser callback to the write buffer, so it is parsed after the rest of the
   * current chunk, and icat's trailing CR LF is in that same chunk. Driving the
   * input handler runs the same `lineFeed` the parser runs for a `\n`, in the
   * right place, so the rows are genuinely consumed in the buffer and the
   * scroll at the bottom of the screen happens exactly as it does for text.
   */
  private advanceCursor(cols: number, rows: number): void {
    const handler = this.inputHandler();
    if (!handler) {
      // No private input handler on this build. Queueing the movement still
      // consumes the rows, which is much closer to right than not moving at
      // all; it only lands after the remainder of the current chunk.
      const seq = '\n'.repeat(Math.max(0, rows)) + (cols > 0 ? `\x1b[${cols}C` : '');
      if (seq) this.term.write(seq);
      return;
    }
    for (let i = 0; i < rows; i++) handler.lineFeed();
    if (cols > 0) handler._moveCursor?.(cols, 0);
  }

  /**
   * Size the placement and apply the cursor movement policy, returning the
   * rectangle used so the canvas can be laid out over exactly the cells the
   * cursor just consumed rather than recomputing and risking a disagreement.
   */
  private applyCursorPolicy(
    cmd: KittyCommand,
    source: { width: number; height: number } | undefined,
  ): { cols: number; rows: number } | null {
    const size = this.placementCells(cmd, source);
    if (!size) return null;
    // C=1 is the sender asking for no movement at all. A virtual placement is
    // not at the cursor and a relative placement takes its position from its
    // parent, so neither moves the cursor either.
    const moves = (cmd.C ?? 0) !== 1 && (cmd.U ?? 0) !== 1 && (cmd.P ?? 0) === 0;
    if (moves) this.advanceCursor(size.cols, size.rows);
    return size;
  }

  /** xterm's input handler, when this build exposes it. */
  private inputHandler(): InputHandlerLike | null {
    if (this.handlerChecked) return this.handler;
    this.handlerChecked = true;
    try {
      const candidate = (this.term as unknown as { _core?: { _inputHandler?: InputHandlerLike } })
        ._core?._inputHandler;
      if (candidate && typeof candidate.lineFeed === 'function') this.handler = candidate;
    } catch {
      this.handler = null;
    }
    return this.handler;
  }

  // --- Geometry -------------------------------------------------------------

  /**
   * Where a placement emitted now should be anchored.
   *
   * Under 'scrollback' the absolute buffer row is stored, so the image scrolls
   * away with the text that introduced it, which is what a shell running an
   * image viewer expects. Under 'viewport' the screen row is stored and the
   * placement stays pinned to the visible grid, which is what a compositor that
   * re-emits every placement each frame needs: if it tracked absolute rows, any
   * newline the application emitted would advance the base and park the
   * placement in scrollback history where only a scrolled-up user could see it.
   */
  private cursorAnchor(): PlaceAnchor {
    const buffer = this.term.buffer.active;
    const cellX = buffer.cursorX | 0;
    const cursorY = buffer.cursorY | 0;
    const alt = buffer.type === 'alternate';

    if (this.anchor !== 'scrollback') return { cellX, row: cursorY, alt };

    // A marker tracks the line through scrollback trimming; the plain absolute
    // row is kept as the fallback for a build without registerMarker and as the
    // value used once a marker has been disposed.
    let marker: IMarker | undefined;
    try {
      marker = this.term.registerMarker(0) ?? undefined;
    } catch {
      marker = undefined;
    }
    if (marker) {
      marker.onDispose(() => this.onMarkerDisposed(marker as IMarker));
    }
    return { cellX, row: buffer.baseY + cursorY, marker, alt };
  }

  /**
   * Drop the placements whose anchoring line has been trimmed out of the
   * scrollback. The image is gone from the session's history, so keeping the
   * canvas would pin it to whatever row happens to sit at that index now.
   */
  private onMarkerDisposed(marker: IMarker): void {
    if (this.disposed) return;
    for (const [key, p] of [...this.placements]) {
      if (p.marker !== marker) continue;
      this.detach(p);
      this.placements.delete(key);
    }
  }

  /** The placement's row in screen coordinates, whatever it was anchored to. */
  private screenRow(p: Placement): number {
    if (this.anchor === 'viewport') return p.row;
    // The marker's line is the live absolute row: it is rewritten as the
    // scrollback trims, where p.row was only correct when it was captured.
    const absolute = p.marker && !p.marker.isDisposed ? p.marker.line : p.row;
    return absolute - this.term.buffer.active.viewportY;
  }

  /**
   * The cell box in CSS pixels.
   *
   * The private render service is the accurate answer and stays correct through
   * font, size and device pixel ratio changes, but it is not public API and can
   * be renamed in any release. The fallback measures the rendered screen
   * element against the grid, which is public and real rather than an estimate
   * from the font size; only when there is no element yet does it fall back to
   * a ratio, which will misplace images on a font whose metrics differ.
   */
  private cellPixels(): { width: number; height: number } {
    try {
      const dims = (
        this.term as unknown as {
          _core: { _renderService: { dimensions: { css: { cell: { width: number; height: number } } } } };
        }
      )._core._renderService.dimensions.css.cell;
      if (dims && dims.width && dims.height) return { width: dims.width, height: dims.height };
    } catch {
      // Private path gone or renamed; fall through to the measured one.
    }

    const screen = this.term.element?.querySelector('.xterm-screen') as HTMLElement | null;
    if (screen && this.term.cols > 0 && this.term.rows > 0) {
      const width = screen.clientWidth / this.term.cols;
      const height = screen.clientHeight / this.term.rows;
      if (width > 0 && height > 0) return { width, height };
    }

    const fontSize = this.term.options.fontSize ?? 14;
    return { width: fontSize * 0.6, height: fontSize * 1.2 };
  }
}
