import type { MouseOptions } from './types.js';

export const DEFAULT_CHUNK_BYTES = 64 * 1024;

/**
 * Split a byte array into chunks no larger than `chunkBytes`.
 *
 * A paste arrives from onData as one string, and a server that caps a single
 * input message drops an oversized one rather than killing the session, so
 * anything large is split across several sends. The far end sees one ordered
 * byte stream either way, so a split in the middle of a multi-byte character is
 * harmless.
 *
 * The returned chunks are subarrays of the input: no copy, and the caller must
 * not retain them past the send.
 */
export function chunkBytes(bytes: Uint8Array, chunkSize = DEFAULT_CHUNK_BYTES): Uint8Array[] {
  if (chunkSize <= 0 || bytes.length <= chunkSize) return [bytes];
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    out.push(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return out;
}

export interface MouseReport {
  button: number;
  col: number;
  row: number;
  isMotion: boolean;
  isRelease: boolean;
}

/** Parse an SGR mouse report, `ESC [ < b ; c ; r M|m`. */
export function parseMouseEvent(data: string): MouseReport | undefined {
  if (data.length < 6) return undefined;
  if (
    data.charCodeAt(0) !== 0x1b ||
    data.charCodeAt(1) !== 0x5b ||
    data.charCodeAt(2) !== 0x3c
  ) {
    return undefined;
  }

  const rest = data.substring(3);
  const terminator = rest[rest.length - 1];
  if (terminator !== 'M' && terminator !== 'm') return undefined;

  const parts = rest.substring(0, rest.length - 1).split(';');
  if (parts.length !== 3) return undefined;

  const button = parseInt(parts[0], 10);
  const col = parseInt(parts[1], 10);
  const row = parseInt(parts[2], 10);
  if (isNaN(button) || isNaN(col) || isNaN(row)) return undefined;

  return {
    button,
    col,
    row,
    isMotion: (button & 32) !== 0,
    isRelease: terminator === 'm',
  };
}

/**
 * Drops SGR motion reports that repeat the last cell and button. Motion within
 * the same cell tells the application nothing it does not already know, and a
 * busy TUI generates a lot of it.
 */
export class MotionFilter {
  private last = { col: -1, row: -1, button: -1 };
  filtered = 0;
  passed = 0;

  /** True when the report should be sent. */
  accept(data: string): boolean {
    const parsed = parseMouseEvent(data);
    if (!parsed) {
      this.passed++;
      return true;
    }

    if (
      parsed.isMotion &&
      parsed.col === this.last.col &&
      parsed.row === this.last.row &&
      parsed.button === this.last.button
    ) {
      this.filtered++;
      return false;
    }

    this.last = { col: parsed.col, row: parsed.row, button: parsed.button };
    if (parsed.isRelease) this.reset();
    this.passed++;
    return true;
  }

  reset(): void {
    this.last = { col: -1, row: -1, button: -1 };
  }
}

/** xterm's onBinary hands back a string of char codes 0-255. */
export function binaryStringToBytes(data: string): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Suppress the browser context menu over the terminal so a right click reaches
 * the program instead of being covered by a menu. Shift is the conventional
 * escape hatch: holding it always yields the browser menu, matching how the
 * same modifier bypasses mouse reporting for selection.
 */
export function installContextMenuPolicy(
  container: HTMLElement,
  options: () => Required<Pick<MouseOptions, 'suppressContextMenu'>>,
): () => void {
  const onContextMenu = (event: MouseEvent) => {
    if (!options().suppressContextMenu || event.shiftKey) return;
    event.preventDefault();
  };
  container.addEventListener('contextmenu', onContextMenu);
  return () => container.removeEventListener('contextmenu', onContextMenu);
}

export const DEFAULT_RESERVED_KEYS = [
  'KeyW',
  'KeyT',
  'KeyN',
  'KeyR',
  'KeyL',
  'Tab',
  'Escape',
];

/**
 * Ask for the keys the browser normally keeps for itself (Ctrl+W, Ctrl+T,
 * Ctrl+N, Ctrl+Tab and so on) so they reach the terminal.
 *
 * preventDefault cannot stop these: browsers reserve them deliberately so a
 * page cannot trap the user. The Keyboard Lock API is the only sanctioned
 * route, and it is granted only while the document is fullscreen, so the lock
 * is taken on entering fullscreen and dropped on leaving. Outside fullscreen
 * these keys keep their browser meaning and there is nothing to be done about
 * it.
 */
export function installReservedKeyCapture(options: {
  enabled: () => boolean;
  keys: () => string[];
}): { sync(): void; dispose(): void } {
  const keyboard = (navigator as Navigator & {
    keyboard?: { lock(keys?: string[]): Promise<void>; unlock(): void };
  }).keyboard;
  if (!keyboard || typeof keyboard.lock !== 'function') {
    return { sync() {}, dispose() {} };
  }

  const sync = () => {
    const wantLock = options.enabled() && !!document.fullscreenElement;
    void (async () => {
      try {
        if (wantLock) await keyboard.lock(options.keys());
        else keyboard.unlock();
      } catch (error) {
        console.warn('webterm: keyboard lock unavailable', error);
      }
    })();
  };

  document.addEventListener('fullscreenchange', sync);
  sync();
  return {
    sync,
    dispose() {
      document.removeEventListener('fullscreenchange', sync);
      try {
        keyboard.unlock();
      } catch {
        // Already unlocked, or the document left fullscreen first.
      }
    },
  };
}
