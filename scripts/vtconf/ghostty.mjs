// A headless driver for ghostty-vt, over the raw wasm C ABI.
//
// The wasm has exactly one import (env.log), so it runs in plain node with no
// DOM and no browser. Every offset and enum value below was read out of the
// module itself: the struct layouts come from ghostty_type_json(), and the
// key enums were recovered from the ghostty-web bundle that shipped alongside
// this wasm (sip, commit ec3b444^, static/ghostty-web/).
//
// ghostty-vt is not, and must not become, a runtime dependency of webterm.
// This is a measurement harness. The wasm is vendored so the harness can be
// re-run without recovering it from another repo's git history again.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** ghostty_terminal_get / _set keys (TerminalData in the bundle). */
export const T = {
  COLS: 1,
  ROWS: 2,
  CURSOR_X: 3,
  CURSOR_Y: 4,
  CURSOR_PENDING_WRAP: 5,
  ACTIVE_SCREEN: 6,
  CURSOR_VISIBLE: 7,
  KITTY_KEYBOARD_FLAGS: 8,
  CURSOR_STYLE: 10,
  MOUSE_TRACKING: 11,
  TITLE: 12,
  PWD: 13,
  TOTAL_ROWS: 14,
  SCROLLBACK_ROWS: 15,
  COLOR_PALETTE: 21,
};

/** ghostty_cell_get keys (CellData). */
export const CELL = {
  CODEPOINT: 1,
  CONTENT_TAG: 2,
  WIDE: 3,
  HAS_TEXT: 4,
  HAS_STYLING: 5,
  STYLE_ID: 6,
  HAS_HYPERLINK: 7,
  PROTECTED: 8,
};

/** Cell width tag. */
export const WIDE = { NARROW: 0, WIDE: 1, SPACER_TAIL: 2, SPACER_HEAD: 3 };

/** Point tag, for addressing a row. */
export const POINT = { ACTIVE: 0, VIEWPORT: 1, SCREEN: 2, HISTORY: 3 };

/** Cursor visual style, as ghostty reports it. */
export const CURSOR_STYLE = ['bar', 'block', 'underline', 'block_hollow'];

/**
 * Mode numbers are packed as { value: u15, ansi: bool } with ansi in bit 15.
 * A DEC private mode (the `?` ones) has ansi = false.
 */
export function packMode(n, ansi = false) {
  return (n & 0x7fff) | (ansi ? 0x8000 : 0);
}

/** GhosttyStyle, size 72. Offsets from ghostty_type_json(). */
const STYLE = {
  SIZE: 72,
  FG: 8,
  BG: 24,
  UNDERLINE_COLOR: 40,
  BOLD: 56,
  ITALIC: 57,
  FAINT: 58,
  BLINK: 59,
  INVERSE: 60,
  INVISIBLE: 61,
  STRIKETHROUGH: 62,
  OVERLINE: 63,
  UNDERLINE: 64,
};

/** GhosttyStyleColor is a 16-byte tagged union: tag@0 u32, then the payload. */
const STYLE_COLOR_NONE = 0;
const STYLE_COLOR_PALETTE = 1;
const STYLE_COLOR_RGB = 2;

/** ghostty_terminal_set callback slots. */
const CB_WRITE_PTY = 1;

let cachedBytes = null;
let cachedTrampoline = null;

export async function loadGhostty(wasmPath = join(HERE, 'vendor', 'ghostty-vt.wasm')) {
  if (!cachedBytes) cachedBytes = readFileSync(wasmPath);
  if (!cachedTrampoline) cachedTrampoline = readFileSync(join(HERE, 'vendor', 'trampoline.wasm'));
  const logs = [];
  const { instance } = await WebAssembly.instantiate(cachedBytes, {
    env: { log: (ptr, len) => logs.push([ptr, len]) },
  });
  const exports = instance.exports;

  // A wasm callback has to be a wasm function, and node cannot synthesise one
  // without --experimental-wasm-type-reflection. The ghostty-web bundle
  // solved this with a tiny forwarding module; the same 185-byte module is
  // vendored here and reused. write_pty_cb is (terminal, userdata, ptr, len).
  const sinks = new Map();
  const tramp = await WebAssembly.instantiate(cachedTrampoline, {
    env: {
      write_pty_cb: (term, _ud, ptr, len) => {
        const sink = sinks.get(term);
        if (sink && len > 0) {
          sink.push(Buffer.from(new Uint8Array(exports.memory.buffer, ptr, len)).toString('binary'));
        }
      },
      size_cb: () => 0,
      decode_png_cb: () => 0,
    },
  });

  const table = exports.__indirect_function_table;
  const writePtyIndex = table.length;
  table.grow(1);
  table.set(writePtyIndex, tramp.instance.exports.write_pty_fwd);

  return { exports, logs, sinks, writePtyIndex, CB_WRITE_PTY };
}

export class GhosttyTerm {
  constructor(mod, cols, rows, scrollback = 1000) {
    this.e = mod.exports;
    this.cols = cols;
    this.rows = rows;

    // GhosttyTerminalOptions: cols@0 u16, rows@2 u16, max_scrollback@4 u32.
    const opts = this.e.ghostty_wasm_alloc_u8_array(8);
    const dv = () => new DataView(this.e.memory.buffer);
    dv().setUint16(opts, cols, true);
    dv().setUint16(opts + 2, rows, true);
    dv().setUint32(opts + 4, scrollback, true);

    const out = this.e.ghostty_wasm_alloc_opaque();
    // Signature is (allocator, *out_handle, *options); allocator 0 = default.
    const rc = this.e.ghostty_terminal_new(0, out, opts);
    if (rc !== 0) throw new Error(`ghostty_terminal_new failed: ${rc}`);
    this.handle = dv().getUint32(out, true);
    this.e.ghostty_wasm_free_opaque(out);
    this.e.ghostty_wasm_free_u8_array(opts, 8);

    // Everything the emulator writes back up the pty, so query responses
    // (DA, DSR, DECRQSS, DECRQM, OSC queries) can be compared.
    this.responses = [];
    if (mod.sinks) {
      this.mod = mod;
      mod.sinks.set(this.handle, this.responses);
      this.e.ghostty_terminal_set(this.handle, mod.CB_WRITE_PTY, mod.writePtyIndex);
    }
  }

  get dv() {
    return new DataView(this.e.memory.buffer);
  }

  free() {
    if (this.handle) {
      this.mod?.sinks?.delete(this.handle);
      this.e.ghostty_terminal_free(this.handle);
    }
    this.handle = 0;
  }

  /** Feed bytes to the parser. */
  write(input) {
    // Strings are UTF-8: the parser is fed real bytes, so a non-latin-1
    // codepoint must not be truncated on the way in.
    const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
    if (bytes.length === 0) return;
    const p = this.e.ghostty_wasm_alloc_u8_array(bytes.length);
    new Uint8Array(this.e.memory.buffer, p, bytes.length).set(bytes);
    this.e.ghostty_terminal_vt_write(this.handle, p, bytes.length);
    this.e.ghostty_wasm_free_u8_array(p, bytes.length);
  }

  tGet(key, size) {
    const p = this.e.ghostty_wasm_alloc_u8_array(size);
    const rc = this.e.ghostty_terminal_get(this.handle, key, p);
    let v = 0;
    if (rc === 0) {
      v = size === 1 ? this.dv.getUint8(p) : size === 2 ? this.dv.getUint16(p, true) : this.dv.getUint32(p, true);
    }
    this.e.ghostty_wasm_free_u8_array(p, size);
    return rc === 0 ? v : null;
  }

  /** Query any mode by number. `ansi` selects the non-private (no `?`) space. */
  getMode(n, ansi = false) {
    const p = this.e.ghostty_wasm_alloc_u8();
    this.e.ghostty_terminal_mode_get(this.handle, packMode(n, ansi), p);
    const v = this.dv.getUint8(p);
    this.e.ghostty_wasm_free_u8(p);
    return v !== 0;
  }

  get cursorX() {
    return this.tGet(T.CURSOR_X, 2);
  }

  get cursorY() {
    return this.tGet(T.CURSOR_Y, 2);
  }

  get cursorVisible() {
    return this.tGet(T.CURSOR_VISIBLE, 1) !== 0;
  }

  get pendingWrap() {
    return this.tGet(T.CURSOR_PENDING_WRAP, 1) !== 0;
  }

  /** 0 = primary, non-zero = alternate. */
  get activeScreen() {
    return this.tGet(T.ACTIVE_SCREEN, 1);
  }

  get cursorStyle() {
    const v = this.tGet(T.CURSOR_STYLE, 4);
    return CURSOR_STYLE[v] ?? String(v);
  }

  get title() {
    const p = this.e.ghostty_wasm_alloc_u8_array(8);
    const rc = this.e.ghostty_terminal_get(this.handle, T.TITLE, p);
    let s = '';
    if (rc === 0) {
      const ptr = this.dv.getUint32(p, true);
      const len = this.dv.getUint32(p + 4, true);
      if (ptr && len) s = Buffer.from(new Uint8Array(this.e.memory.buffer, ptr, len)).toString('utf8');
    }
    this.e.ghostty_wasm_free_u8_array(p, 8);
    return s;
  }

  /**
   * Read one row of the active screen.
   *
   * A grid ref is invalidated by any terminal mutation, so everything is read
   * and copied out before the next write.
   */
  readRow(y, { withStyle = false } = {}) {
    // GhosttyPoint: tag@0 u32, value@8 (GhosttyPointCoordinate: x@0 u16, y@4 u32).
    const pt = this.e.ghostty_wasm_alloc_u8_array(24);
    this.dv.setUint32(pt, POINT.ACTIVE, true);
    this.dv.setUint16(pt + 8, 0, true);
    this.dv.setUint32(pt + 12, y, true);

    // GhosttyGridRef: size@0 u32, node@4, x@8 u16, y@10 u16. Sized struct.
    const ref = this.e.ghostty_wasm_alloc_u8_array(12);
    this.dv.setUint32(ref, 12, true);

    const cells = [];
    try {
      if (this.e.ghostty_terminal_grid_ref(this.handle, pt, ref) !== 0) return null;

      const cellOut = this.e.ghostty_wasm_alloc_u8_array(8);
      const u32 = this.e.ghostty_wasm_alloc_u8_array(4);
      const style = this.e.ghostty_wasm_alloc_u8_array(STYLE.SIZE);

      for (let x = 0; x < this.cols; x++) {
        this.dv.setUint16(ref + 8, x, true);
        if (this.e.ghostty_grid_ref_cell(ref, cellOut) !== 0) {
          cells.push({ cp: 0, width: 1 });
          continue;
        }
        const cell = this.dv.getBigUint64(cellOut, true);

        this.e.ghostty_cell_get(cell, CELL.CODEPOINT, u32);
        const cp = this.dv.getUint32(u32, true);

        this.e.ghostty_cell_get(cell, CELL.WIDE, u32);
        const w = this.dv.getUint32(u32, true);
        const width = w === WIDE.WIDE ? 2 : w === WIDE.SPACER_TAIL || w === WIDE.SPACER_HEAD ? 0 : 1;

        const out = { cp, width };

        if (withStyle) {
          this.dv.setUint32(style, STYLE.SIZE, true);
          if (this.e.ghostty_grid_ref_style(ref, style) === 0) {
            const b = new Uint8Array(this.e.memory.buffer, style, STYLE.SIZE);
            out.bold = !!b[STYLE.BOLD];
            out.italic = !!b[STYLE.ITALIC];
            out.faint = !!b[STYLE.FAINT];
            out.blink = !!b[STYLE.BLINK];
            out.inverse = !!b[STYLE.INVERSE];
            out.invisible = !!b[STYLE.INVISIBLE];
            out.strikethrough = !!b[STYLE.STRIKETHROUGH];
            out.overline = !!b[STYLE.OVERLINE];
            out.underline = this.dv.getInt32(style + STYLE.UNDERLINE, true);
            out.fg = this.readStyleColor(style + STYLE.FG);
            out.bg = this.readStyleColor(style + STYLE.BG);
            out.underlineColor = this.readStyleColor(style + STYLE.UNDERLINE_COLOR);
          } else {
            out.bold = false;
            out.italic = false;
            out.faint = false;
            out.blink = false;
            out.inverse = false;
            out.invisible = false;
            out.strikethrough = false;
            out.overline = false;
            out.underline = 0;
            out.fg = null;
            out.bg = null;
            out.underlineColor = null;
          }
        }
        cells.push(out);
      }

      this.e.ghostty_wasm_free_u8_array(cellOut, 8);
      this.e.ghostty_wasm_free_u8_array(u32, 4);
      this.e.ghostty_wasm_free_u8_array(style, STYLE.SIZE);
    } finally {
      this.e.ghostty_wasm_free_u8_array(pt, 24);
      this.e.ghostty_wasm_free_u8_array(ref, 12);
    }
    return cells;
  }

  /** GhosttyStyleColor: 16-byte tagged union, tag@0 u32. */
  readStyleColor(p) {
    const tag = this.dv.getUint32(p, true);
    if (tag === STYLE_COLOR_NONE) return null;
    // The union payload sits at offset 8, not 4: GhosttyStyleColor has align 8.
    if (tag === STYLE_COLOR_PALETTE) return { kind: 'palette', index: this.dv.getUint8(p + 8) };
    if (tag === STYLE_COLOR_RGB) {
      return {
        kind: 'rgb',
        r: this.dv.getUint8(p + 8),
        g: this.dv.getUint8(p + 9),
        b: this.dv.getUint8(p + 10),
      };
    }
    return { kind: 'unknown', tag };
  }

  /** The active screen as an array of row strings, trailing blanks trimmed. */
  gridText() {
    const out = [];
    for (let y = 0; y < this.rows; y++) {
      const row = this.readRow(y);
      if (!row) {
        out.push('');
        continue;
      }
      let s = '';
      for (const c of row) {
        if (c.width === 0) continue; // spacer tail of a wide cell
        s += c.cp === 0 ? ' ' : String.fromCodePoint(c.cp);
      }
      out.push(s.replace(/\s+$/, ''));
    }
    return out;
  }
}
