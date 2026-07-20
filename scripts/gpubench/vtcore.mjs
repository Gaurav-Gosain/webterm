// The ghostty-vt side of every candidate contender: parse bytes, then hand the
// whole viewport over in one call.
//
// Runs unchanged on the main thread and in a worker, which is the point: the
// only difference between contenders 2, 3 and 5 is where this object lives.

import { Ghostty, GhosttyTerminal } from './ghostty-web.mjs';
import { PACKED_STRIDE } from './packed-source.mjs';

let loaded = null;

export async function loadVt(wasmUrl = '/ghostty-vt.wasm') {
  if (!loaded) loaded = await Ghostty.load(wasmUrl);
  return loaded;
}

export class PackedVt {
  constructor(g, cols, rows, { scrollback = 1_000_000 } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.term = new GhosttyTerminal(g.exports, g.memory, cols, rows, {
      scrollbackLimit: scrollback,
    });
    const e = this.term.exports;
    if (typeof e.ghostty_render_state_pack_viewport !== 'function') {
      throw new Error('wasm has no ghostty_render_state_pack_viewport');
    }
    this.e = e;
    this.cellCap = cols * rows;
    this.outPtr = e.ghostty_wasm_alloc_u8_array(this.cellCap * PACKED_STRIDE);
    this.dirtyPtr = e.ghostty_wasm_alloc_u8_array(rows);
    this.rowsPtr = e.ghostty_wasm_alloc_u8_array(4);
    this.colsPtr = e.ghostty_wasm_alloc_u8_array(4);
    this._buf = null;
    // Staging buffer for writes, sized up on demand. Allocating per write was
    // measured as noise at 64 KiB chunks but it is still avoidable work.
    this.stagePtr = 0;
    this.stageLen = 0;
  }

  _sync() {
    const buf = this.e.memory.buffer;
    if (this._buf !== buf) {
      this._buf = buf;
      this.u8 = new Uint8Array(buf);
    }
  }

  write(bytes) {
    if (bytes.length === 0) return;
    this.term.write(bytes);
  }

  /**
   * Parse-visible viewport as one flat buffer. Returns views into wasm linear
   * memory; the caller copies out of them if it needs to keep them across
   * another write (a memory.grow detaches them).
   */
  pack() {
    const t = this.term;
    t.update();
    const rc = this.e.ghostty_render_state_pack_viewport(
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
    return {
      cells: new Uint8Array(this._buf, this.outPtr, this.cellCap * PACKED_STRIDE),
      dirty: new Uint8Array(this._buf, this.dirtyPtr, this.rows),
    };
  }

  markClean() {
    this.term.markClean();
  }

  /** Geometry the last pack reported; a guard against a silent resize. */
  packedGeometry() {
    this._sync();
    const dv = new DataView(this._buf);
    return { rows: dv.getUint32(this.rowsPtr, true), cols: dv.getUint32(this.colsPtr, true) };
  }
}
