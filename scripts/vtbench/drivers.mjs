// The four things being timed, behind one interface.
//
//   ghostty-raw   the low-level C ABI, one alloc/free per write
//   ghostty-web   the bundle sip actually shipped, including its optimized
//                 render-state read path
//   xterm         @xterm/headless, the parser webterm ships
//
// Every driver exposes write(bytes) and readViewport(), and readViewport
// produces the SAME per-cell field set on every driver, so the read numbers
// compare like with like. That field set is dictated by the narrowest of the
// three, which is ghostty-web's cell pool: codepoint, fg rgb, bg rgb, style
// flags bitfield, width, hyperlink presence, grapheme length.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VTCONF = join(HERE, '..', 'vtconf');
/**
 * Which ghostty-vt build the ghostty drivers run.
 *
 * Defaults to the vendored wasm, which is what every earlier number in this
 * harness was measured on. GHOSTTY_VT_WASM points it at another build so the
 * same drivers, unchanged, can be run against a freshly compiled upstream
 * wasm and the two compared directly.
 */
export const WASM_PATH = process.env.GHOSTTY_VT_WASM || join(VTCONF, 'vendor', 'ghostty-vt.wasm');

/** Style flag bits, matching the ghostty-web bundle's CellFlags. */
export const F = {
  BOLD: 1,
  ITALIC: 2,
  FAINT: 4,
  BLINK: 8,
  INVERSE: 16,
  INVISIBLE: 32,
  STRIKETHROUGH: 64,
  UNDERLINE: 128,
};

function emptyCell() {
  return {
    codepoint: 0,
    fg_r: 0,
    fg_g: 0,
    fg_b: 0,
    bg_r: 0,
    bg_g: 0,
    bg_b: 0,
    flags: 0,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
  };
}

// ---------------------------------------------------------------------------
// ghostty, raw C ABI
// ---------------------------------------------------------------------------

/**
 * The vtconf driver, plus a preallocated write staging buffer.
 *
 * vtconf's GhosttyTerm allocates and frees a wasm buffer on every write. That
 * is a real cost a naive embedding pays, so it is measured as its own variant
 * rather than quietly optimized away.
 */
export class GhosttyRaw {
  constructor(mod, cols, rows, { scrollback = 1_000_000, reuseBuffer = true } = {}) {
    this.e = mod.exports;
    this.cols = cols;
    this.rows = rows;
    this.reuseBuffer = reuseBuffer;

    const opts = this.e.ghostty_wasm_alloc_u8_array(8);
    const dv0 = new DataView(this.e.memory.buffer);
    dv0.setUint16(opts, cols, true);
    dv0.setUint16(opts + 2, rows, true);
    dv0.setUint32(opts + 4, scrollback, true);
    const out = this.e.ghostty_wasm_alloc_opaque();
    const rc = this.e.ghostty_terminal_new(0, out, opts);
    if (rc !== 0) throw new Error(`ghostty_terminal_new failed: ${rc}`);
    this.handle = new DataView(this.e.memory.buffer).getUint32(out, true);
    this.e.ghostty_wasm_free_opaque(out);
    this.e.ghostty_wasm_free_u8_array(opts, 8);

    this.stagePtr = 0;
    this.stageLen = 0;
    this.pool = new Array(cols * rows);
    for (let i = 0; i < this.pool.length; i++) this.pool[i] = emptyCell();
  }

  get dv() {
    return new DataView(this.e.memory.buffer);
  }

  write(bytes) {
    if (bytes.length === 0) return;
    if (this.reuseBuffer) {
      if (this.stageLen < bytes.length) {
        if (this.stagePtr) this.e.ghostty_wasm_free_u8_array(this.stagePtr, this.stageLen);
        this.stageLen = bytes.length;
        this.stagePtr = this.e.ghostty_wasm_alloc_u8_array(this.stageLen);
      }
      new Uint8Array(this.e.memory.buffer, this.stagePtr, bytes.length).set(bytes);
      this.e.ghostty_terminal_vt_write(this.handle, this.stagePtr, bytes.length);
    } else {
      const p = this.e.ghostty_wasm_alloc_u8_array(bytes.length);
      new Uint8Array(this.e.memory.buffer, p, bytes.length).set(bytes);
      this.e.ghostty_terminal_vt_write(this.handle, p, bytes.length);
      this.e.ghostty_wasm_free_u8_array(p, bytes.length);
    }
  }

  /**
   * The naive read: grid_ref per row, then ghostty_cell_get and
   * ghostty_grid_ref_style per cell. This is the shape sip's read path had
   * before the perf branch, and the shape the vtconf harness still uses.
   */
  readViewport() {
    const e = this.e;
    const pt = e.ghostty_wasm_alloc_u8_array(24);
    const ref = e.ghostty_wasm_alloc_u8_array(12);
    const cellOut = e.ghostty_wasm_alloc_u8_array(8);
    const u32 = e.ghostty_wasm_alloc_u8_array(4);
    const style = e.ghostty_wasm_alloc_u8_array(72);
    try {
      for (let y = 0; y < this.rows; y++) {
        let dv = new DataView(e.memory.buffer);
        dv.setUint32(pt, 0, true); // POINT.ACTIVE
        dv.setUint16(pt + 8, 0, true);
        dv.setUint32(pt + 12, y, true);
        dv.setUint32(ref, 12, true);
        if (e.ghostty_terminal_grid_ref(this.handle, pt, ref) !== 0) continue;
        for (let x = 0; x < this.cols; x++) {
          const c = this.pool[y * this.cols + x];
          dv = new DataView(e.memory.buffer);
          dv.setUint16(ref + 8, x, true);
          if (e.ghostty_grid_ref_cell(ref, cellOut) !== 0) {
            c.codepoint = 0;
            continue;
          }
          const cell = new DataView(e.memory.buffer).getBigUint64(cellOut, true);
          e.ghostty_cell_get(cell, 1, u32); // CODEPOINT
          c.codepoint = new DataView(e.memory.buffer).getUint32(u32, true);
          e.ghostty_cell_get(cell, 3, u32); // WIDE
          const w = new DataView(e.memory.buffer).getUint32(u32, true);
          c.width = w === 1 ? 2 : w === 2 || w === 3 ? 0 : 1;
          e.ghostty_cell_get(cell, 7, u32); // HAS_HYPERLINK
          c.hyperlink_id = new Uint8Array(e.memory.buffer)[u32] !== 0 ? 1 : 0;
          new DataView(e.memory.buffer).setUint32(style, 72, true);
          if (e.ghostty_grid_ref_style(ref, style) === 0) {
            const b = new Uint8Array(e.memory.buffer, style, 72);
            const sdv = new DataView(e.memory.buffer);
            let f = 0;
            if (b[56]) f |= F.BOLD;
            if (b[57]) f |= F.ITALIC;
            if (b[58]) f |= F.FAINT;
            if (b[59]) f |= F.BLINK;
            if (b[60]) f |= F.INVERSE;
            if (b[61]) f |= F.INVISIBLE;
            if (b[62]) f |= F.STRIKETHROUGH;
            if (sdv.getInt32(style + 64, true) !== 0) f |= F.UNDERLINE;
            c.flags = f;
            readColorInto(sdv, style + 8, c, 'fg');
            readColorInto(sdv, style + 24, c, 'bg');
          } else {
            c.flags = 0;
            c.fg_r = c.fg_g = c.fg_b = 0;
            c.bg_r = c.bg_g = c.bg_b = 0;
          }
        }
      }
    } finally {
      e.ghostty_wasm_free_u8_array(pt, 24);
      e.ghostty_wasm_free_u8_array(ref, 12);
      e.ghostty_wasm_free_u8_array(cellOut, 8);
      e.ghostty_wasm_free_u8_array(u32, 4);
      e.ghostty_wasm_free_u8_array(style, 72);
    }
    return this.pool;
  }

  /** Viewport plus retained scrollback, so retention can be compared. */
  get totalRows() {
    const p = this.e.ghostty_wasm_alloc_u8_array(4);
    this.e.ghostty_terminal_get(this.handle, 14, p); // T.TOTAL_ROWS
    const v = new DataView(this.e.memory.buffer).getUint32(p, true);
    this.e.ghostty_wasm_free_u8_array(p, 4);
    return v;
  }

  free() {
    if (this.stagePtr) this.e.ghostty_wasm_free_u8_array(this.stagePtr, this.stageLen);
    if (this.handle) this.e.ghostty_terminal_free(this.handle);
    this.handle = 0;
  }
}

/**
 * GhosttyStyleColor is a 16-byte tagged union: tag@0 u32, payload@8.
 * A palette index is not resolved to rgb here, and neither the bundle's read
 * path nor xterm's is asked to resolve one either, so the three stay level.
 */
function readColorInto(dv, p, c, which) {
  const tag = dv.getUint32(p, true);
  let r = 0;
  let g = 0;
  let b = 0;
  if (tag === 2) {
    r = dv.getUint8(p + 8);
    g = dv.getUint8(p + 9);
    b = dv.getUint8(p + 10);
  } else if (tag === 1) {
    r = dv.getUint8(p + 8);
  }
  if (which === 'fg') {
    c.fg_r = r;
    c.fg_g = g;
    c.fg_b = b;
  } else {
    c.bg_r = r;
    c.bg_g = g;
    c.bg_b = b;
  }
}

export async function loadGhosttyRaw() {
  const bytes = readFileSync(WASM_PATH);
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log: () => {} } });
  return { exports: instance.exports };
}

// ---------------------------------------------------------------------------
// ghostty-web: the shipped bundle, with the perf branch's optimized read path
// ---------------------------------------------------------------------------

/**
 * Loads sip's ghostty-web bundle in plain node.
 *
 * The bundle is an ES module with no DOM dependency at import time, and its
 * loader only needs fetch to see a file. `variant` selects which build:
 * 'perf' is the branch that fixed the read path, 'base' is main before it.
 */
export async function loadGhosttyWeb(variant = 'perf') {
  const path = join(HERE, 'vendor', `ghostty-web-${variant}.mjs`);
  const real = globalThis.fetch;
  globalThis.fetch = async (u, ...rest) => {
    const s = String(u);
    if (s.startsWith('file://')) {
      return new Response(readFileSync(s.slice(7)), {
        headers: { 'content-type': 'application/wasm' },
      });
    }
    return real(u, ...rest);
  };
  try {
    const m = await import(`file://${path}`);
    const g = await m.Ghostty.load(`file://${WASM_PATH}`);
    return { m, g };
  } finally {
    globalThis.fetch = real;
  }
}

export class GhosttyWeb {
  constructor(loaded, cols, rows, { scrollback = 1_000_000 } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.term = new loaded.m.GhosttyTerminal(loaded.g.exports, loaded.g.memory, cols, rows, {
      scrollbackLimit: scrollback,
    });
  }

  write(bytes) {
    this.term.write(bytes);
  }

  /**
   * A full cold read: the per-frame memo and the dirty-row memo are both
   * invalidated, so this is what a genuine full repaint costs. The damage
   * driven fast path is measured separately, because xterm.js exposes no
   * equivalent and pretending otherwise would not be a comparison.
   */
  readViewport() {
    const t = this.term;
    t.__sipViewportValid = false;
    t.__sipPoolValid = false;
    t.rowDirtyCache = null;
    t.rowWrapCache = null;
    return t.getViewport();
  }

  /** The read the shipped render loop actually performs after a small write. */
  readViewportDamaged() {
    this.term.__sipViewportValid = false;
    return this.term.getViewport();
  }

  markClean() {
    if (typeof this.term.markClean === 'function') this.term.markClean();
  }

  get totalRows() {
    const e = this.term.exports;
    const p = e.ghostty_wasm_alloc_u8_array(4);
    e.ghostty_terminal_get(this.term.handle, 14, p);
    const v = new DataView(e.memory.buffer).getUint32(p, true);
    e.ghostty_wasm_free_u8_array(p, 4);
    return v;
  }

  free() {
    try {
      this.term.dispose?.();
    } catch {
      /* the bundle's dispose is best effort here */
    }
  }
}

// ---------------------------------------------------------------------------
// xterm.js
// ---------------------------------------------------------------------------

export class Xterm {
  constructor(Terminal, cols, rows, { scrollback = 1000, unicode = null } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    if (unicode) {
      this.term.loadAddon(new unicode.UnicodeGraphemesAddon());
      this.term.unicode.activeVersion = '15-graphemes';
    }
    this.pool = new Array(cols * rows);
    for (let i = 0; i < this.pool.length; i++) this.pool[i] = emptyCell();
    this._cell = undefined;
  }

  /**
   * xterm.js parses asynchronously and chunks internally, so a write is only
   * finished when its callback fires. Timing the synchronous return would
   * measure the enqueue, not the parse.
   */
  write(bytes) {
    return new Promise((resolve) => this.term.write(bytes, resolve));
  }

  /**
   * Read the visible screen into the same preallocated pool shape the ghostty
   * drivers fill, reading the same fields. getCell(x, cell) reuses one cell
   * object, which is xterm's own no-allocation accessor.
   */
  readViewport() {
    const b = this.term.buffer.active;
    const base = b.baseY;
    let cell = this._cell;
    for (let y = 0; y < this.rows; y++) {
      const line = b.getLine(base + y);
      if (!line) continue;
      for (let x = 0; x < this.cols; x++) {
        cell = line.getCell(x, cell);
        this._cell = cell;
        const c = this.pool[y * this.cols + x];
        if (!cell) {
          c.codepoint = 0;
          continue;
        }
        c.codepoint = cell.getCode();
        c.width = cell.getWidth();
        let f = 0;
        if (cell.isBold()) f |= F.BOLD;
        if (cell.isItalic()) f |= F.ITALIC;
        if (cell.isDim()) f |= F.FAINT;
        if (cell.isBlink()) f |= F.BLINK;
        if (cell.isInverse()) f |= F.INVERSE;
        if (cell.isInvisible()) f |= F.INVISIBLE;
        if (cell.isStrikethrough()) f |= F.STRIKETHROUGH;
        if (cell.isUnderline()) f |= F.UNDERLINE;
        c.flags = f;
        if (cell.isFgDefault()) {
          c.fg_r = c.fg_g = c.fg_b = 0;
        } else {
          const v = cell.getFgColor();
          if (cell.isFgRGB()) {
            c.fg_r = (v >> 16) & 0xff;
            c.fg_g = (v >> 8) & 0xff;
            c.fg_b = v & 0xff;
          } else {
            c.fg_r = v & 0xff;
            c.fg_g = 0;
            c.fg_b = 0;
          }
        }
        if (cell.isBgDefault()) {
          c.bg_r = c.bg_g = c.bg_b = 0;
        } else {
          const v = cell.getBgColor();
          if (cell.isBgRGB()) {
            c.bg_r = (v >> 16) & 0xff;
            c.bg_g = (v >> 8) & 0xff;
            c.bg_b = v & 0xff;
          } else {
            c.bg_r = v & 0xff;
            c.bg_g = 0;
            c.bg_b = 0;
          }
        }
        c.hyperlink_id = 0;
        c.grapheme_len = 0;
      }
    }
    return this.pool;
  }

  get totalRows() {
    return this.term.buffer.active.length;
  }

  free() {
    this.term.dispose();
  }
}
