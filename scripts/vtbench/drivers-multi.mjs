// A fourth read path: the same ghostty-web bundle, read through the
// *_get_multi exports the shipped bundle never calls.
//
// The existing drivers are the baseline and are not touched. This one
// subclasses the bundle's terminal only to replace the viewport walk.
//
// What the multi exports actually are, from the disassembly and confirmed
// cell-by-cell by probe-multi.mjs: a loop INSIDE wasm that calls the ordinary
// single-key getter once per key, on ONE subject. They batch keys, not cells.
// There is no bulk transfer of a row or a viewport anywhere in this module, so
// the most this path can remove is the JS-to-wasm call overhead, not the
// per-cell work.
//
// Crossings per cell:
//
//   ghostty-web        8   next, 5x row_cells_get, 2x cell_get
//   ghostty-web-multi  3   next, 1x row_cells_get_multi, 1x cell_get_multi
//                      4   when the color batch is cut short (see below)
//
// The multi loop stops at the first non-zero return code and never writes the
// keys after it, so key order matters. FG_COLOR and BG_COLOR both return -2 on
// a cell using the default color, and which of them does so varies by stream:
// on btop both always succeed and one call covers everything, on sgr-bat and
// vim BG_COLOR always fails. So the fallible pair goes last and anything the
// batch skipped is retried individually. That keeps the result identical to
// the single-key path regardless of which keys fail.

import { ROW_CELLS, ROW_CELLS_SIZE, CELL, ROW, RS, RENDER_STATE, WIDE } from './multi-abi.mjs';
import { F } from './drivers.mjs';

/** Batch order: infallible keys first, the two fallible colors last. */
const KEYS = [
  ROW_CELLS.GRAPHEMES_LEN,
  ROW_CELLS.GRAPHEMES_BUF,
  ROW_CELLS.STYLE,
  ROW_CELLS.RAW,
  ROW_CELLS.BG_COLOR,
  ROW_CELLS.FG_COLOR,
];
const K_GLEN = 0;
const K_GBUF = 1;
const K_STYLE = 2;
const K_RAW = 3;
const K_BG = 4;
const K_FG = 5;

const CELL_KEYS = [CELL.WIDE, CELL.HAS_HYPERLINK];
const CELL_SIZE = [4, 1];

export class GhosttyWebMulti {
  constructor(loaded, cols, rows, { scrollback = 1_000_000 } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.term = new loaded.m.GhosttyTerminal(loaded.g.exports, loaded.g.memory, cols, rows, {
      scrollbackLimit: scrollback,
    });
    const e = this.term.exports;

    // Every out slot and both pointer tables are allocated once for the life
    // of the driver. The multi call allocates nothing itself, so there is no
    // ownership to hand back and nothing to free per cell or per frame.
    this.slots = KEYS.map((k) => e.ghostty_wasm_alloc_u8_array(ROW_CELLS_SIZE[k]));
    this.keysPtr = e.ghostty_wasm_alloc_u8_array(KEYS.length * 4);
    this.valsPtr = e.ghostty_wasm_alloc_u8_array(KEYS.length * 4);
    this.cellSlots = CELL_SIZE.map((n) => e.ghostty_wasm_alloc_u8_array(n));
    this.cellKeysPtr = e.ghostty_wasm_alloc_u8_array(CELL_KEYS.length * 4);
    this.cellValsPtr = e.ghostty_wasm_alloc_u8_array(CELL_KEYS.length * 4);
    this.countPtr = e.ghostty_wasm_alloc_u8_array(4);
    this.wrapPtr = e.ghostty_wasm_alloc_u8();
    this.rowRawPtr = e.ghostty_wasm_alloc_u8_array(8);
    this.dirtyPtr = e.ghostty_wasm_alloc_u8();

    const d = new DataView(e.memory.buffer);
    KEYS.forEach((k, i) => d.setUint32(this.keysPtr + i * 4, k, true));
    this.slots.forEach((p, i) => d.setUint32(this.valsPtr + i * 4, p, true));
    CELL_KEYS.forEach((k, i) => d.setUint32(this.cellKeysPtr + i * 4, k, true));
    this.cellSlots.forEach((p, i) => d.setUint32(this.cellValsPtr + i * 4, p, true));
  }

  write(bytes) {
    this.term.write(bytes);
  }

  /**
   * A full cold read, matching what GhosttyWeb.readViewport() measures: no
   * per-frame memo, no damage-driven row skipping, every cell walked.
   */
  readViewport() {
    const t = this.term;
    const e = t.exports;
    t.__sipViewportValid = false;
    t.__sipPoolValid = false;
    t.rowDirtyCache = null;
    t.rowWrapCache = null;
    t.update();
    t.zeroCellPool();

    const pool = t.cellPool;
    const cols = this.cols;
    const rows = this.rows;
    const S = this.slots;
    const CS = this.cellSlots;

    t.populateHandle((p) => e.ghostty_render_state_get(t.renderHandle, RENDER_STATE.ROW_ITERATOR, p), t.rowIter);

    // One DataView and one Uint8Array for the walk, rebuilt only when
    // populateHandle's per-row allocation has grown memory and detached the
    // buffer. Same discipline as the bundle's own read path.
    let buf = e.memory.buffer;
    let dv = new DataView(buf);
    let u8 = new Uint8Array(buf);
    const sync = () => {
      if (e.memory.buffer !== buf) {
        buf = e.memory.buffer;
        dv = new DataView(buf);
        u8 = new Uint8Array(buf);
      }
    };

    const dirty = new Array(rows).fill(false);
    const wrap = new Array(rows).fill(false);

    let y = 0;
    while (y < rows && e.ghostty_render_state_row_iterator_next(t.rowIter)) {
      sync();
      e.ghostty_render_state_row_get(t.rowIter, RS.DIRTY, this.dirtyPtr);
      dirty[y] = u8[this.dirtyPtr] !== 0;
      e.ghostty_render_state_row_get(t.rowIter, RS.RAW, this.rowRawPtr);
      const rowRaw = dv.getBigUint64(this.rowRawPtr, true);
      e.ghostty_row_get(rowRaw, ROW.WRAP_CONTINUATION, this.wrapPtr);
      wrap[y] = u8[this.wrapPtr] !== 0;

      t.populateHandle((p) => e.ghostty_render_state_row_get(t.rowIter, RS.CELLS, p), t.rowCells);
      sync();

      const base = y * cols;
      let x = 0;
      while (x < cols && e.ghostty_render_state_row_cells_next(t.rowCells)) {
        const c = pool[base + x];

        const rc = e.ghostty_render_state_row_cells_get_multi(
          t.rowCells,
          KEYS.length,
          this.keysPtr,
          this.valsPtr,
          this.countPtr,
        );
        let done = rc === 0 ? KEYS.length : dv.getUint32(this.countPtr, true);
        // The batch stopped at KEYS[done]. Everything after the failure has
        // to be asked for individually, or a cell whose bg is default would
        // silently lose its fg. In practice this is one extra call per cell
        // on the streams where BG_COLOR fails, and none where it does not.
        let bgOk = done > K_BG;
        let fgOk = done > K_FG;
        if (done < KEYS.length) {
          for (let i = done + 1; i < KEYS.length; i++) {
            const ok = e.ghostty_render_state_row_cells_get(t.rowCells, KEYS[i], S[i]) === 0;
            if (i === K_BG) bgOk = ok;
            else if (i === K_FG) fgOk = ok;
          }
        }

        const glen = dv.getUint32(S[K_GLEN], true);
        c.grapheme_len = glen > 0 ? glen - 1 : 0;
        c.codepoint = glen > 0 ? dv.getUint32(S[K_GBUF], true) : 0;

        if (fgOk) {
          c.fg_r = u8[S[K_FG]];
          c.fg_g = u8[S[K_FG] + 1];
          c.fg_b = u8[S[K_FG] + 2];
        } else {
          c.fg_r = c.fg_g = c.fg_b = 0;
        }
        if (bgOk) {
          c.bg_r = u8[S[K_BG]];
          c.bg_g = u8[S[K_BG] + 1];
          c.bg_b = u8[S[K_BG] + 2];
        } else {
          c.bg_r = c.bg_g = c.bg_b = 0;
        }

        const st = S[K_STYLE];
        let f = 0;
        if (u8[st + 56]) f |= F.BOLD;
        if (u8[st + 57]) f |= F.ITALIC;
        if (u8[st + 58]) f |= F.FAINT;
        if (u8[st + 59]) f |= F.BLINK;
        if (u8[st + 60]) f |= F.INVERSE;
        if (u8[st + 61]) f |= F.INVISIBLE;
        if (u8[st + 62]) f |= F.STRIKETHROUGH;
        if (dv.getInt32(st + 64, true) !== 0) f |= F.UNDERLINE;
        c.flags = f;

        const raw = dv.getBigUint64(S[K_RAW], true);
        e.ghostty_cell_get_multi(raw, CELL_KEYS.length, this.cellKeysPtr, this.cellValsPtr, this.countPtr);
        const w = dv.getUint32(CS[0], true);
        c.width = w === WIDE.WIDE ? 2 : w === WIDE.SPACER_TAIL || w === WIDE.SPACER_HEAD ? 0 : 1;
        c.hyperlink_id = u8[CS[1]] !== 0 ? 1 : 0;
        x++;
      }
      y++;
    }

    t.rowDirtyCache = dirty;
    t.rowWrapCache = wrap;
    t.__sipRowDirtySnap = dirty;
    t.__sipRowWrapSnap = wrap;
    t.__sipViewportValid = true;
    t.__sipPoolValid = true;
    t.__sipPoolCols = cols;
    t.__sipPoolRows = rows;
    return pool;
  }

  /** No damage-driven variant here: this driver exists to measure a cold read. */
  readViewportDamaged() {
    return this.readViewport();
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
