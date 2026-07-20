// Proof that the read benchmark is comparing equal work.
//
//   node scripts/vtbench/sanity.mjs [stream] [cols] [rows]
//
// A read number is worthless if one driver is quietly filling fewer fields, or
// if V8 has eliminated the walk because nothing consumes it. So this feeds the
// same stream to all three drivers, checksums every field of every cell in the
// resulting pool, and prints the checksums. They must be identical.
//
// It then re-times each read with the checksum inside the timed region. If a
// driver's time were an artifact of dead code elimination, consuming the
// result would move it; if the times hold, the walk is genuinely happening.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GhosttyRaw, GhosttyWeb, Xterm, loadGhosttyRaw, loadGhosttyWeb } from './drivers.mjs';
import { GhosttyWebMulti } from './drivers-multi.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const [streamName = 'sgr-bat', colsArg = '200', rowsArg = '55'] = process.argv.slice(2);
const COLS = Number(colsArg);
const ROWS = Number(rowsArg);

const bytes = gunzipSync(readFileSync(join(HERE, 'streams', `${streamName}.raw.gz`)));
const rawMod = await loadGhosttyRaw();
const webMod = await loadGhosttyWeb('perf');
const XtermTerminal = (await import('@xterm/headless')).default.Terminal;

// Matched retention: enough budget for roughly 1000 lines at this width, the
// same figure run.mjs calibrates to. The exact value does not matter here,
// only that the three drivers see the same stream.
const SB_BYTES = 1000 * COLS * 16;

async function feed(t) {
  for (let o = 0; o < bytes.length; o += 65536) {
    const r = t.write(bytes.subarray(o, o + 65536));
    if (r && r.then) await r;
  }
}

/** Every field the drivers are contracted to fill, folded into one number. */
function checksum(pool) {
  let h = 0;
  for (const c of pool) {
    h =
      (h * 31 +
        c.codepoint +
        c.flags * 7 +
        c.fg_r * 3 +
        c.fg_g * 5 +
        c.fg_b * 11 +
        c.bg_r * 13 +
        c.bg_g * 17 +
        c.bg_b * 19 +
        c.width * 23) >>>
      0;
  }
  return h;
}

const terms = {
  'ghostty-raw': new GhosttyRaw(rawMod, COLS, ROWS, { scrollback: SB_BYTES }),
  'ghostty-web': new GhosttyWeb(webMod, COLS, ROWS, { scrollback: SB_BYTES }),
  'ghostty-multi': new GhosttyWebMulti(webMod, COLS, ROWS, { scrollback: SB_BYTES }),
  xterm: new Xterm(XtermTerminal, COLS, ROWS, { scrollback: 1000 }),
};
for (const t of Object.values(terms)) await feed(t);

console.log(`${streamName} at ${COLS}x${ROWS}, ${COLS * ROWS} cells\n`);
const sums = new Set();
for (const [name, t] of Object.entries(terms)) {
  const pool = t.readViewport();
  let codepoints = 0;
  let styled = 0;
  let coloured = 0;
  for (const c of pool) {
    if (c.codepoint) codepoints++;
    if (c.flags) styled++;
    if (c.fg_r | c.fg_g | c.fg_b | c.bg_r | c.bg_g | c.bg_b) coloured++;
  }
  const sum = checksum(pool);
  sums.add(sum);
  console.log(
    `${name.padEnd(12)} checksum ${String(sum).padStart(11)}` +
      `  codepoints ${codepoints}  styled ${styled}  coloured ${coloured}`,
  );
}
console.log(sums.size === 1 ? '\nOK: all drivers produced an identical pool\n' : '\nMISMATCH: pools differ\n');

for (const [name, t] of Object.entries(terms)) {
  let sink = 0;
  for (let i = 0; i < 5; i++) sink ^= checksum(t.readViewport());
  const times = [];
  for (let i = 0; i < 15; i++) {
    const s = process.hrtime.bigint();
    sink ^= checksum(t.readViewport());
    times.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  times.sort((a, b) => a - b);
  console.log(
    `${name.padEnd(12)} read+checksum median ${times[7].toFixed(3)}ms` +
      `  min ${times[0].toFixed(3)}  max ${times[14].toFixed(3)}  (sink ${sink})`,
  );
}

for (const t of Object.values(terms)) t.free?.();
