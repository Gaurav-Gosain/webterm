// The ABI of ghostty-vt's *_get_multi exports, and the enums they key on.
//
// None of this is in ghostty_type_json(), which describes struct layouts and
// says nothing about function signatures. The signatures below were read out
// of the wasm disassembly (`wasm2wat --enable-all`, functions 133, 135 and
// 189) and are checked against the single-key calls they replace by
// probe-multi.mjs on every cell of a real grid.
//
// All three multi exports have the identical body:
//
//   i32 ghostty_cell_get_multi(u64 cell, u32 n, const u32 *keys,
//                              void *const *values, u32 *out_done)
//   i32 ghostty_row_get_multi(u64 row, u32 n, const u32 *keys,
//                             void *const *values, u32 *out_done)
//   i32 ghostty_render_state_row_cells_get_multi(handle, u32 n,
//                             const u32 *keys, void *const *values,
//                             u32 *out_done)
//
// Semantics, straight from the disassembly:
//
//   - `keys` is an array of n u32 keys. `values` is an array of n POINTERS,
//     each 4 bytes, each pointing at a caller-owned out slot big enough for
//     that key's payload. It is a scatter, not a packed struct: nothing is
//     laid out contiguously by the callee.
//   - The body is a plain loop calling the single-key getter n times inside
//     wasm. There is NO bulk copy and no row- or viewport-wide transfer. The
//     only thing saved is n-1 JS-to-wasm crossings.
//   - The loop STOPS at the first non-zero return code and returns it. Keys
//     after the failing one are never written. `out_done` (may be null)
//     receives the number of keys that succeeded, so a partial result is
//     detectable but the tail is lost.
//   - Returns -2 if `keys` or `values` is null. Returns 0 when all n succeed.
//   - Nothing is allocated by the callee, so there is no ownership to
//     release. The out slots and the two pointer arrays are caller-owned and
//     can be hoisted for the whole walk. Views over wasm memory stay valid
//     until memory.grow detaches the buffer.

/** ghostty_render_state_get keys. */
export const RENDER_STATE = { DIRTY: 3, ROW_ITERATOR: 4 };

/** ghostty_render_state_row_get keys. */
export const RS = { DIRTY: 1, RAW: 2, CELLS: 3 };

/** ghostty_render_state_row_cells_get keys. */
export const ROW_CELLS = {
  RAW: 1,
  STYLE: 2,
  GRAPHEMES_LEN: 3,
  GRAPHEMES_BUF: 4,
  BG_COLOR: 5,
  FG_COLOR: 6,
};

/** ghostty_cell_get keys. */
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

/** ghostty_row_get keys. */
export const ROW = { WRAP: 1, WRAP_CONTINUATION: 2, GRAPHEME: 3, STYLED: 4, HYPERLINK: 5 };

/** Cell width tag. */
export const WIDE = { NARROW: 0, WIDE: 1, SPACER_TAIL: 2, SPACER_HEAD: 3 };

/** Byte size of the out slot each row_cells key writes. */
export const ROW_CELLS_SIZE = {
  [ROW_CELLS.RAW]: 8,
  [ROW_CELLS.STYLE]: 72,
  [ROW_CELLS.GRAPHEMES_LEN]: 4,
  [ROW_CELLS.GRAPHEMES_BUF]: 4,
  [ROW_CELLS.BG_COLOR]: 3,
  [ROW_CELLS.FG_COLOR]: 3,
};
