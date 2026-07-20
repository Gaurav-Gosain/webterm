// Sanity check for the throughput benchmark.
//
//   node scripts/vtbench/verify.mjs
//
// A benchmark that measures one side skipping the work is worse than no
// benchmark. This feeds every stream to every driver at every size and checks
// three things before any timing figure is quoted:
//
//   1. the visible grid is not blank
//   2. all three drivers agree on the visible grid text, so none of them
//      silently bailed out of parsing part of the stream
//   3. all three retained comparable scrollback, so none of them is winning
//      the scrolling streams by throwing rows away
//
// It prints what it finds and does not assert, because ghostty and xterm.js
// genuinely differ on a handful of cells and the point is to see how much.

import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GhosttyRaw, GhosttyWeb, Xterm, loadGhosttyRaw, loadGhosttyWeb } from './drivers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STREAM_DIR = join(HERE, 'streams');
const CHUNK = 64 * 1024;

const SIZES = [
  { cols: 80, rows: 24, label: '80x24' },
  { cols: 120, rows: 40, label: '120x40' },
  { cols: 200, rows: 55, label: '200x55' },
];

const rawMod = await loadGhosttyRaw();
const webPerf = await loadGhosttyWeb('perf');
const xpkg = await import('@xterm/headless');
const XtermTerminal = xpkg.default?.Terminal ?? xpkg.Terminal;

async function feed(term, bytes) {
  for (let off = 0; off < bytes.length; off += CHUNK) {
    const r = term.write(bytes.subarray(off, Math.min(off + CHUNK, bytes.length)));
    if (r && typeof r.then === 'function') await r;
  }
}

/** The visible grid as row strings, so drivers can be diffed textually. */
function poolText(pool, cols, rows) {
  const out = [];
  for (let y = 0; y < rows; y++) {
    let s = '';
    for (let x = 0; x < cols; x++) {
      const c = pool[y * cols + x];
      if (c.width === 0) continue;
      s += c.codepoint === 0 ? ' ' : String.fromCodePoint(c.codepoint);
    }
    out.push(s.replace(/\s+$/, ''));
  }
  return out;
}

const streams = readdirSync(STREAM_DIR)
  .filter((f) => f.endsWith('.raw.gz'))
  .sort();

console.log('stream / size, then: non-blank cells, grid-text row agreement, retained rows\n');

for (const f of streams) {
  const bytes = gunzipSync(readFileSync(join(STREAM_DIR, f)));
  for (const size of SIZES) {
    const raw = new GhosttyRaw(rawMod, size.cols, size.rows, { scrollback: 64 * 1024 * 1024 });
    const web = new GhosttyWeb(webPerf, size.cols, size.rows, { scrollback: 64 * 1024 * 1024 });
    const xt = new Xterm(XtermTerminal, size.cols, size.rows, { scrollback: 200000 });
    await feed(raw, bytes);
    await feed(web, bytes);
    await feed(xt, bytes);

    const tRaw = poolText(raw.readViewport(), size.cols, size.rows);
    const tWeb = poolText(web.readViewport(), size.cols, size.rows);
    const tXt = poolText(xt.readViewport(), size.cols, size.rows);

    const nonBlank = (t) => t.join('').replace(/\s/g, '').length;
    const agree = (a, b) => a.filter((r, i) => r === b[i]).length;

    // Retained rows: ghostty reports TOTAL_ROWS through terminal_get key 14,
    // xterm reports buffer.length. Both count viewport plus scrollback.
    const p = raw.e.ghostty_wasm_alloc_u8_array(4);
    raw.e.ghostty_terminal_get(raw.handle, 14, p);
    const gRows = new DataView(raw.e.memory.buffer).getUint32(p, true);
    raw.e.ghostty_wasm_free_u8_array(p, 4);
    const xRows = xt.term.buffer.active.length;

    console.log(
      `${f.replace(/\.raw\.gz$/, '').padEnd(16)} ${size.label.padEnd(7)}` +
        ` cells raw/web/xt ${String(nonBlank(tRaw)).padStart(6)}/${String(nonBlank(tWeb)).padStart(6)}/${String(nonBlank(tXt)).padStart(6)}` +
        `  rows raw=web ${agree(tRaw, tWeb)}/${size.rows}  web=xt ${agree(tWeb, tXt)}/${size.rows}` +
        `  retained g=${gRows} x=${xRows}`,
    );

    raw.free();
    web.free();
    xt.free();
  }
}
