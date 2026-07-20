// A vtgl VtSource backed by ghostty's packed viewport (PackedCell, 16 bytes).
//
// This is the adapter the candidate architecture would actually ship: the VT
// hands over one flat buffer per frame, and the renderer reads cells straight
// out of it with no per-cell wasm crossing. It is identical in contenders 2, 3
// and 5, which is what makes their pixel output comparable.
//
// PackedCell, little-endian:
//    0 u32 codepoint   4 u8 fg_r  5 fg_g  6 fg_b  7 flags
//    8 u8 bg_r  9 bg_g 10 bg_b  11 width  12 hyperlink  13 grapheme_len
//   14 u16 reserved

export const PACKED_STRIDE = 16;

// ghostty PackedCell.flags bit order is NOT vtgl's CellFlags bit order. Getting
// this wrong silently swaps underline for strikethrough and faint for blink, so
// the translation is a table built once rather than an inline expression that
// looks right.
const G = {
  BOLD: 1,
  ITALIC: 2,
  FAINT: 4,
  BLINK: 8,
  INVERSE: 16,
  INVISIBLE: 32,
  STRIKETHROUGH: 64,
  UNDERLINE: 128,
};
const V = {
  BOLD: 1,
  ITALIC: 2,
  UNDERLINE: 4,
  STRIKETHROUGH: 8,
  INVERSE: 16,
  INVISIBLE: 32,
  BLINK: 64,
  FAINT: 128,
};

export const FLAG_MAP = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let o = 0;
  if (i & G.BOLD) o |= V.BOLD;
  if (i & G.ITALIC) o |= V.ITALIC;
  if (i & G.FAINT) o |= V.FAINT;
  if (i & G.BLINK) o |= V.BLINK;
  if (i & G.INVERSE) o |= V.INVERSE;
  if (i & G.INVISIBLE) o |= V.INVISIBLE;
  if (i & G.STRIKETHROUGH) o |= V.STRIKETHROUGH;
  if (i & G.UNDERLINE) o |= V.UNDERLINE;
  FLAG_MAP[i] = o;
}

/**
 * pack_viewport writes 0 for a cell whose colour is the terminal default, so
 * "0" has to mean "theme colour" rather than "black". Every contender that
 * consumes packed cells makes the same substitution, so it cannot tilt the
 * comparison between them; it is stated because it does make black-on-purpose
 * cells indistinguishable from default ones.
 */
class Line {
  constructor(src, row) {
    this.src = src;
    this.row = row;
    this.length = src.cols;
  }
  _base(col) {
    return (this.row * this.src.cols + col) * PACKED_STRIDE;
  }
  codepoint(col) {
    return this.src.u32[(this.row * this.src.cols + col) * 4];
  }
  grapheme(col) {
    const cp = this.codepoint(col);
    return cp === 0 ? '' : String.fromCodePoint(cp);
  }
  width(col) {
    return this.src.u8[this._base(col) + 11];
  }
  fg(col) {
    const b = this._base(col);
    const u = this.src.u8;
    const v = (u[b + 4] << 16) | (u[b + 5] << 8) | u[b + 6];
    return v === 0 ? this.src.defaultFg : v;
  }
  bg(col) {
    const b = this._base(col);
    const u = this.src.u8;
    const v = (u[b + 8] << 16) | (u[b + 9] << 8) | u[b + 10];
    return v === 0 ? this.src.defaultBg : v;
  }
  flags(col) {
    return FLAG_MAP[this.src.u8[this._base(col) + 7]];
  }
}

export class PackedSource {
  constructor(cols, rows, theme) {
    this.cols = cols;
    this.rows = rows;
    this.scrollbackRows = 0;
    this.defaultFg = theme.foreground;
    this.defaultBg = theme.background;
    this.cells = new Uint8Array(cols * rows * PACKED_STRIDE);
    this.u8 = this.cells;
    this.u32 = new Uint32Array(this.cells.buffer);
    this.dirty = new Uint8Array(rows).fill(1);
    this.cursor = { x: 0, y: 0, visible: true, shape: 'block' };
    // One Line per row, reused. Allocating per getLine would put GC pressure
    // in the hot path and make the render numbers measure the allocator.
    this.lines = [];
    for (let r = 0; r < rows; r++) this.lines.push(new Line(this, r));
  }

  /** Adopt a viewport that arrived as bytes (worker handoff or local pack). */
  adopt(cellBytes, dirtyBytes) {
    this.cells.set(cellBytes);
    if (dirtyBytes) this.dirty.set(dirtyBytes);
    else this.dirty.fill(1);
  }

  /** Point at an existing buffer with no copy (same-thread pack path). */
  attach(cellBytes, dirtyBytes) {
    this.cells = cellBytes;
    this.u8 = cellBytes;
    this.u32 = new Uint32Array(cellBytes.buffer, cellBytes.byteOffset, cellBytes.byteLength >> 2);
    if (dirtyBytes) this.dirty = dirtyBytes;
  }

  getLine(row) {
    return this.lines[row];
  }
  getCell(row, col) {
    const l = this.lines[row];
    return {
      codepoint: l.codepoint(col),
      grapheme: l.grapheme(col),
      width: l.width(col),
      fg: l.fg(col),
      bg: l.bg(col),
      flags: l.flags(col),
    };
  }
  getGraphemeString(row, col) {
    return this.lines[row].grapheme(col);
  }
  getCursor() {
    return this.cursor;
  }
  isRowDirty(row) {
    return this.dirty[row] !== 0;
  }

  /** Cheap content fingerprint, used by the correctness controls. */
  checksum() {
    const u32 = new Uint32Array(this.cells.buffer, this.cells.byteOffset, this.cells.byteLength >> 2);
    let h = 2166136261;
    for (let i = 0; i < u32.length; i++) {
      h ^= u32[i];
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
}
