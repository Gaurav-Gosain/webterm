// Empirical probe of the *_get_multi exports.
//
//   node scripts/vtbench/probe-multi.mjs [stream] [cols] [rows]
//
// ghostty_type_json() describes struct layouts and says nothing about function
// signatures, so the multi ABI was read out of the wasm disassembly and is
// checked here, cell by cell on a real grid, against the single-key calls it
// is supposed to replace. It also records the return code of every key, which
// is what decides how the keys can safely be batched: the multi loop stops at
// the first failure and never writes the keys after it.
//
// The multi call runs FIRST on each cell and the single-key reference second,
// so a stale value left by the reference cannot be mistaken for a value the
// multi call wrote. Each out slot is poisoned with 0xa5 before the multi call.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GhosttyWeb, loadGhosttyWeb } from './drivers.mjs';
import { RS, ROW_CELLS, ROW_CELLS_SIZE, CELL, RENDER_STATE } from './multi-abi.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const [streamName = 'sgr-bat', colsArg = '200', rowsArg = '55'] = process.argv.slice(2);
const COLS = Number(colsArg);
const ROWS = Number(rowsArg);

const bytes = gunzipSync(readFileSync(join(HERE, 'streams', `${streamName}.raw.gz`)));
const webMod = await loadGhosttyWeb('perf');
const w = new GhosttyWeb(webMod, COLS, ROWS, { scrollback: 1000 * COLS * 16 });
for (let o = 0; o < bytes.length; o += 65536) w.write(bytes.subarray(o, o + 65536));
w.readViewport();

const t = w.term;
const e = t.exports;
const dv = () => new DataView(e.memory.buffer);
const u8 = () => new Uint8Array(e.memory.buffer);

const rcHist = new Map();
const bump = (k) => rcHist.set(k, (rcHist.get(k) ?? 0) + 1);
const notes = [];

// --- row_cells ------------------------------------------------------------

const keys = [
  ROW_CELLS.GRAPHEMES_LEN,
  ROW_CELLS.GRAPHEMES_BUF,
  ROW_CELLS.STYLE,
  ROW_CELLS.RAW,
  ROW_CELLS.FG_COLOR,
  ROW_CELLS.BG_COLOR,
];
const width = keys.map((k) => ROW_CELLS_SIZE[k]);
const slots = width.map((n) => e.ghostty_wasm_alloc_u8_array(n));
const refs = width.map((n) => e.ghostty_wasm_alloc_u8_array(n));
const keysPtr = e.ghostty_wasm_alloc_u8_array(keys.length * 4);
const valsPtr = e.ghostty_wasm_alloc_u8_array(keys.length * 4);
const countPtr = e.ghostty_wasm_alloc_u8_array(4);
{
  const d = dv();
  keys.forEach((k, i) => d.setUint32(keysPtr + i * 4, k, true));
  slots.forEach((p, i) => d.setUint32(valsPtr + i * 4, p, true));
}

// --- cell -----------------------------------------------------------------

const cellKeys = [CELL.WIDE, CELL.HAS_HYPERLINK];
const cellWidth = [4, 1];
const cellSlots = cellWidth.map((n) => e.ghostty_wasm_alloc_u8_array(n));
const cellRefs = cellWidth.map((n) => e.ghostty_wasm_alloc_u8_array(n));
const cellKeysPtr = e.ghostty_wasm_alloc_u8_array(cellKeys.length * 4);
const cellValsPtr = e.ghostty_wasm_alloc_u8_array(cellKeys.length * 4);
{
  const d = dv();
  cellKeys.forEach((k, i) => d.setUint32(cellKeysPtr + i * 4, k, true));
  cellSlots.forEach((p, i) => d.setUint32(cellValsPtr + i * 4, p, true));
}

let cells = 0;
let rcMismatch = 0;
let byteMismatch = 0;
let cellByteMismatch = 0;
const examples = [];

t.populateHandle((p) => e.ghostty_render_state_get(t.renderHandle, RENDER_STATE.ROW_ITERATOR, p), t.rowIter);
let y = 0;
while (y < ROWS && e.ghostty_render_state_row_iterator_next(t.rowIter)) {
  t.populateHandle((p) => e.ghostty_render_state_row_get(t.rowIter, RS.CELLS, p), t.rowCells);
  let x = 0;
  while (x < COLS && e.ghostty_render_state_row_cells_next(t.rowCells)) {
    cells++;

    for (let i = 0; i < keys.length; i++) u8().fill(0xa5, slots[i], slots[i] + width[i]);
    const mrc = e.ghostty_render_state_row_cells_get_multi(t.rowCells, keys.length, keysPtr, valsPtr, countPtr);
    const done = dv().getUint32(countPtr, true);
    bump(`row_cells multi rc=${mrc} done=${done}`);
    const got = keys.map((_, i) => Uint8Array.from(u8().subarray(slots[i], slots[i] + width[i])));

    // Reference: the same keys, one call each, in the same order. The
    // reference slots are poisoned too, so a key whose getter returns 0
    // without writing anything shows up as poison on BOTH sides rather than
    // as a spurious mismatch against a stale value from the previous cell.
    for (let i = 0; i < keys.length; i++) u8().fill(0xa5, refs[i], refs[i] + width[i]);
    const refRc = keys.map((k, i) => {
      const rc = e.ghostty_render_state_row_cells_get(t.rowCells, k, refs[i]);
      bump(`row_cells key ${k} rc=${rc}`);
      return rc;
    });
    // The multi loop must have stopped at exactly the first failing key.
    const firstFail = refRc.findIndex((rc) => rc !== 0);
    const expectDone = firstFail === -1 ? keys.length : firstFail;
    if (done !== expectDone || (firstFail !== -1 && mrc !== refRc[firstFail]) || (firstFail === -1 && mrc !== 0)) {
      rcMismatch++;
      if (examples.length < 6) examples.push(`y${y} x${x}: done ${done} rc ${mrc}, singles ${refRc.join(',')}`);
    }
    for (let i = 0; i < done; i++) {
      const want = u8().subarray(refs[i], refs[i] + width[i]);
      for (let b = 0; b < width[i]; b++) {
        if (got[i][b] !== want[b]) {
          byteMismatch++;
          if (examples.length < 6)
            examples.push(`y${y} x${x} key${keys[i]} byte${b}: multi ${got[i][b]} single ${want[b]}`);
          break;
        }
      }
    }

    // cell_get_multi on this cell's raw handle.
    const raw = dv().getBigUint64(refs[3], true); // RAW slot
    for (let i = 0; i < cellKeys.length; i++) u8().fill(0xa5, cellSlots[i], cellSlots[i] + cellWidth[i]);
    const crc = e.ghostty_cell_get_multi(raw, cellKeys.length, cellKeysPtr, cellValsPtr, countPtr);
    const cdone = dv().getUint32(countPtr, true);
    bump(`cell multi rc=${crc} done=${cdone}`);
    const cgot = cellKeys.map((_, i) => Uint8Array.from(u8().subarray(cellSlots[i], cellSlots[i] + cellWidth[i])));
    cellKeys.forEach((k, i) => bump(`cell key ${k} rc=${e.ghostty_cell_get(raw, k, cellRefs[i])}`));
    for (let i = 0; i < cdone; i++) {
      const want = u8().subarray(cellRefs[i], cellRefs[i] + cellWidth[i]);
      for (let b = 0; b < cellWidth[i]; b++) {
        if (cgot[i][b] !== want[b]) {
          cellByteMismatch++;
          if (examples.length < 6) examples.push(`y${y} x${x} cellkey${cellKeys[i]} byte${b} differs`);
          break;
        }
      }
    }
    x++;
  }
  y++;
}

console.log(`${streamName} at ${COLS}x${ROWS}`);
console.log(`cells checked           ${cells}`);
console.log(`row_cells rc mismatches ${rcMismatch}`);
console.log(`row_cells byte mismatch ${byteMismatch}`);
console.log(`cell_get byte mismatch  ${cellByteMismatch}`);
console.log('\nreturn codes seen:');
for (const [k, v] of [...rcHist].sort()) console.log(`  ${k.padEnd(34)} ${v}`);
if (examples.length) {
  console.log('\nexamples:');
  for (const m of examples) console.log('  ' + m);
}
for (const n of notes) console.log(n);
