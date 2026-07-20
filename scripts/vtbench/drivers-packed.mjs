// The read path with the boundary contract changed instead of optimized.
//
// Every other driver here asks ghostty for cells and rebuilds them in JS, which
// costs at least one host call per cell. This one calls a single export,
// ghostty_render_state_pack_viewport, which writes the whole viewport into a
// caller-owned buffer in wasm linear memory as a flat array of 16-byte
// records. One crossing per frame instead of thousands.
//
// That export does not exist in the shipped wasm. It was added to
// src/terminal/c/render.zig in a ghostty worktree and the module rebuilt, so
// this driver only runs against that build. Point GHOSTTY_VT_WASM at it.
//
// PackedCell, 16 bytes, little-endian, matching the Zig extern struct:
//
//   0  u32  codepoint          first codepoint, 0 if the cell has no text
//   4  u8   fg_r
//   5  u8   fg_g
//   6  u8   fg_b
//   7  u8   flags              bold 1 italic 2 faint 4 blink 8 inverse 16
//                              invisible 32 strikethrough 64 underline 128
//   8  u8   bg_r
//   9  u8   bg_g
//  10  u8   bg_b
//  11  u8   width              1 narrow, 2 wide head, 0 spacer
//  12  u8   hyperlink          0 or 1
//  13  u8   grapheme_len       continuation codepoints beyond the first
//  14  u16  reserved
//
// Two costs remain and neither is removable by a wider export. The pack itself
// is O(cells) inside wasm, and this harness's contract is a pool of JS objects,
// so the decode below is O(cells) in JS. The decode is the honest floor for any
// consumer that wants JS objects; a consumer that can read the typed array
// directly, like a GPU upload, pays only the pack. Both are reported.

import { RENDER_STATE } from './multi-abi.mjs';

export const PACKED_STRIDE = 16;

export class GhosttyPacked {
  constructor(loaded, cols, rows, { scrollback = 1_000_000 } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.term = new loaded.m.GhosttyTerminal(loaded.g.exports, loaded.g.memory, cols, rows, {
      scrollbackLimit: scrollback,
    });
    const e = this.term.exports;
    if (typeof e.ghostty_render_state_pack_viewport !== 'function') {
      throw new Error(
        'this wasm has no ghostty_render_state_pack_viewport; point GHOSTTY_VT_WASM at the patched build',
      );
    }

    // One buffer for the viewport, one byte per row for the dirty flags, and
    // two u32 slots for the geometry the call reports back. All caller-owned
    // and allocated once: the export allocates nothing.
    this.cellCap = cols * rows;
    this.outPtr = e.ghostty_wasm_alloc_u8_array(this.cellCap * PACKED_STRIDE);
    this.dirtyPtr = e.ghostty_wasm_alloc_u8_array(rows);
    this.rowsPtr = e.ghostty_wasm_alloc_u8_array(4);
    this.colsPtr = e.ghostty_wasm_alloc_u8_array(4);

    this.pool = new Array(this.cellCap);
    for (let i = 0; i < this.cellCap; i++) {
      this.pool[i] = {
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
    this.rowDirty = new Array(rows).fill(false);
    this._buf = null;
    this._u8 = null;
    this._u32 = null;
  }

  write(bytes) {
    this.term.write(bytes);
  }

  /** Refresh the views if a wasm allocation has grown memory and detached them. */
  _sync() {
    const buf = this.term.exports.memory.buffer;
    if (this._buf !== buf) {
      this._buf = buf;
      this._u8 = new Uint8Array(buf);
      this._u32 = new Uint32Array(buf);
    }
  }

  /**
   * The pack alone: what a consumer pays if it can use the packed bytes as
   * they are, for instance uploading them to the GPU. One host call.
   */
  packOnly() {
    const t = this.term;
    const e = t.exports;
    t.update();
    const rc = e.ghostty_render_state_pack_viewport(
      t.renderHandle,
      this.outPtr,
      this.cellCap,
      this.dirtyPtr,
      this.rows,
      this.rowsPtr,
      this.colsPtr,
    );
    if (rc !== 0) throw new Error(`pack_viewport failed: ${rc}`);
    this._sync();
    return this.outPtr;
  }

  /**
   * Pack, then decode into the same pool of JS objects every other driver
   * fills, so the read numbers stay comparable.
   */
  readViewport() {
    this.packOnly();
    const u8 = this._u8;
    const u32 = this._u32;
    const base = this.outPtr;
    const wordBase = base >> 2;
    const pool = this.pool;
    const n = this.cellCap;

    for (let i = 0; i < n; i++) {
      const c = pool[i];
      const w = wordBase + i * 4;
      const b = base + i * PACKED_STRIDE;
      c.codepoint = u32[w];
      c.fg_r = u8[b + 4];
      c.fg_g = u8[b + 5];
      c.fg_b = u8[b + 6];
      c.flags = u8[b + 7];
      c.bg_r = u8[b + 8];
      c.bg_g = u8[b + 9];
      c.bg_b = u8[b + 10];
      c.width = u8[b + 11];
      c.hyperlink_id = u8[b + 12];
      c.grapheme_len = u8[b + 13];
    }
    for (let y = 0; y < this.rows; y++) this.rowDirty[y] = u8[this.dirtyPtr + y] !== 0;
    return pool;
  }

  readViewportDamaged() {
    return this.readViewport();
  }

  markClean() {
    if (typeof this.term.markClean === 'function') this.term.markClean();
  }

  /** Geometry the last pack reported, for checking against the requested size. */
  get packedGeometry() {
    this._sync();
    return {
      rows: this._u32[this.rowsPtr >> 2],
      cols: this._u32[this.colsPtr >> 2],
    };
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

export { RENDER_STATE };

/**
 * The pack with no decode: one host call and nothing else.
 *
 * This is the floor of the boundary contract, and it is what a consumer that
 * can consume the packed bytes directly would pay. It leaves the JS pool
 * untouched, so it must not be checked for a non-blank grid, hence the flag.
 */
export class GhosttyPackOnly extends GhosttyPacked {
  skipNonEmptyCheck = true;

  readViewport() {
    this.packOnly();
    return this.pool;
  }
}
