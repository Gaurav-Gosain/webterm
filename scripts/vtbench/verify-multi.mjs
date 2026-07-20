// Cell-by-cell proof that the multi read path is identical to the per-cell one.
//
//   node scripts/vtbench/verify-multi.mjs
//
// sanity.mjs folds a pool into one checksum, which is enough to catch a
// driver filling different values but tells you nothing about WHERE. This
// compares every field of every cell of ghostty-web against ghostty-multi, on
// every stream at every size, and reports the first differences it finds.
//
// ghostty-web is the reference here, not ghostty-raw. The two ghostty drivers
// already disagree with each other on some stream/size pairs before any of
// this work, so the contract the multi path has to meet is "identical to the
// read path it replaces", which is ghostty-web's.

import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GhosttyWeb, loadGhosttyWeb } from './drivers.mjs';
import { GhosttyWebMulti } from './drivers-multi.mjs';
import { GhosttyPacked } from './drivers-packed.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STREAM_DIR = join(HERE, 'streams');
const CHUNK = 64 * 1024;

const SIZES = [
  { cols: 80, rows: 24, label: '80x24' },
  { cols: 120, rows: 40, label: '120x40' },
  { cols: 200, rows: 55, label: '200x55' },
];

const FIELDS = [
  'codepoint',
  'fg_r',
  'fg_g',
  'fg_b',
  'bg_r',
  'bg_g',
  'bg_b',
  'flags',
  'width',
  'hyperlink_id',
  'grapheme_len',
];

// Which candidate read path is being checked against ghostty-web.
const WHICH = process.argv[2] === 'packed' ? 'packed' : 'multi';
const webMod = await loadGhosttyWeb('perf');
const streams = readdirSync(STREAM_DIR)
  .filter((f) => f.endsWith('.raw.gz'))
  .sort();

let totalCells = 0;
let totalDiffs = 0;

for (const f of streams) {
  const bytes = gunzipSync(readFileSync(join(STREAM_DIR, f)));
  for (const size of SIZES) {
    const sb = 1000 * size.cols * 16;
    const a = new GhosttyWeb(webMod, size.cols, size.rows, { scrollback: sb });
    const b = WHICH === 'packed'
      ? new GhosttyPacked(webMod, size.cols, size.rows, { scrollback: sb })
      : new GhosttyWebMulti(webMod, size.cols, size.rows, { scrollback: sb });
    for (let off = 0; off < bytes.length; off += CHUNK) {
      const chunk = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
      a.write(chunk);
      b.write(chunk);
    }
    // The pools are the terminals' own arrays and are reused across reads, so
    // the reference is snapshotted before the second driver runs.
    const pa = a.readViewport().map((c) => FIELDS.map((k) => c[k]));
    const pb = b.readViewport();

    let diffs = 0;
    const examples = [];
    for (let i = 0; i < pa.length; i++) {
      for (let k = 0; k < FIELDS.length; k++) {
        if (pa[i][k] !== pb[i][FIELDS[k]]) {
          diffs++;
          if (examples.length < 3)
            examples.push(
              `cell ${i} (y${Math.floor(i / size.cols)} x${i % size.cols}) ${FIELDS[k]}: web ${pa[i][k]} ${WHICH} ${pb[i][FIELDS[k]]}`,
            );
          break;
        }
      }
    }
    totalCells += pa.length;
    totalDiffs += diffs;
    console.log(
      `${f.replace(/\.raw\.gz$/, '').padEnd(16)} ${size.label.padEnd(7)} ${String(pa.length).padStart(6)} cells  ` +
        (diffs === 0 ? 'identical' : `${diffs} DIFFER`),
    );
    for (const e of examples) console.log('    ' + e);
    a.free();
    b.free();
  }
}

console.log(
  `\n${totalCells} cells compared across ${streams.length} streams and ${SIZES.length} sizes, ` +
    (totalDiffs === 0 ? 'all identical' : `${totalDiffs} DIFFER`),
);
process.exit(totalDiffs === 0 ? 0 : 1);
