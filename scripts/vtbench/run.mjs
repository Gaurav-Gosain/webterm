// VT throughput benchmark: ghostty-vt against xterm.js, on real byte streams.
//
//   node scripts/vtbench/run.mjs
//   node scripts/vtbench/run.mjs --sizes 200x55 --streams btop,sgr-bat
//   node scripts/vtbench/run.mjs --reps 9 --json out.json
//
// Two axes are measured.
//
//   write   bytes per second feeding a captured stream through the parser,
//           fed in 64 KiB chunks, which is what a pty read hands over.
//   read    the cost of getting one full viewport of cells out into a
//           render-ready pool, with every driver filling the same fields.
//
// Streams are real captures from real programs through a real pty, see
// streams/README.md. Nothing here is hand-written or synthetic.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GhosttyRaw, GhosttyWeb, Xterm, loadGhosttyRaw, loadGhosttyWeb } from './drivers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STREAM_DIR = join(HERE, 'streams');
const CHUNK = 64 * 1024;

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => {
    const k = a.replace(/^--/, '');
    if (!a.startsWith('--')) return [`_${i}`, a];
    const next = all[i + 1];
    return [k, next && !next.startsWith('--') ? next : true];
  }),
);

const SIZES = String(args.sizes ?? '80x24,120x40,200x55')
  .split(',')
  .map((s) => {
    const [c, r] = s.split('x').map(Number);
    return { cols: c, rows: r, label: s };
  });
const REPS = Number(args.reps ?? 7);
const WARMUP = Number(args.warmup ?? 3);

const ALL_STREAMS = readdirSync(STREAM_DIR)
  .filter((f) => f.endsWith('.raw.gz'))
  .sort();
const STREAMS = (args.streams ? String(args.streams).split(',') : null) ?? null;

/**
 * Captures are stored gzipped, because 25 MB of raw pty output does not belong
 * in a git history. They are decompressed once, up front, into a Buffer, and
 * every timed region operates on that Buffer, so no decompression cost lands
 * inside a measurement.
 */
function pickStreams() {
  const want = STREAMS;
  return ALL_STREAMS.filter((f) => !want || want.some((w) => f.startsWith(w))).map((f) => ({
    name: f.replace(/\.raw\.gz$/, ''),
    bytes: gunzipSync(readFileSync(join(STREAM_DIR, f))),
  }));
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  return { min: s[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: s[s.length - 1], n: s.length };
}

const fmtMs = (v) => (v < 10 ? v.toFixed(3) : v.toFixed(1));
const fmtMB = (v) => v.toFixed(1);

// ---------------------------------------------------------------------------
// drivers
// ---------------------------------------------------------------------------

let rawMod;
let webPerf;
let XtermTerminal;

async function ensureLoaded() {
  rawMod ??= await loadGhosttyRaw();
  webPerf ??= await loadGhosttyWeb('perf');
  if (!XtermTerminal) {
    const pkg = await import('@xterm/headless');
    XtermTerminal = pkg.default?.Terminal ?? pkg.Terminal;
  }
}

/**
 * Scrollback has to be matched or the scrolling streams are a fraud.
 *
 * xterm's `scrollback` is a line count. ghostty's `max_scrollback` is a byte
 * budget, so the same number means nothing across the two, and an unmatched
 * pair makes one side retain several times more rows than the other while
 * being timed on the same bytes. On an early run at 200x55 ghostty was keeping
 * 26,586 rows against xterm's 147,693 on the same stream, which would have
 * handed ghostty a large unearned win on every scrolling workload.
 *
 * So ghostty's byte budget is calibrated per grid size: scroll a known number
 * of full-width rows through a terminal, read back how many it retained, and
 * scale the budget until it retains the same line count xterm is configured
 * for. The calibration is measured, not assumed, and printed with the results.
 */
const SCROLLBACK_LINES = Number(args.scrollback ?? 1000);
const ghosttyBudget = new Map();

async function calibrate(size) {
  const key = size.label;
  if (ghosttyBudget.has(key)) return ghosttyBudget.get(key);
  const target = SCROLLBACK_LINES + size.rows;
  // A representative row: full width of printable text, which is what the
  // scrolling streams actually push through.
  const line = Buffer.from('x'.repeat(size.cols - 1) + '\n', 'latin1');
  const feedBytes = Buffer.concat(Array.from({ length: target * 3 }, () => line));
  // Bracket the budget first, then bisect. A pure secant step overshoots,
  // because ghostty frees whole pages rather than single rows, so retention
  // is a staircase in the budget rather than a line.
  const probe = (b) => {
    const t = new GhosttyRaw(rawMod, size.cols, size.rows, { scrollback: b });
    t.write(feedBytes);
    const n = t.totalRows;
    t.free();
    return n;
  };
  let lo = 1024;
  let hi = target * size.cols * 8;
  while (probe(hi) < target && hi < 1 << 30) hi *= 2;
  let budget = hi;
  let retained = probe(hi);
  for (let i = 0; i < 40 && hi - lo > 1024; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const n = probe(mid);
    if (n >= target) {
      hi = mid;
      budget = mid;
      retained = n;
    } else {
      lo = mid;
    }
  }
  const out = { budget, retained, target };
  ghosttyBudget.set(key, out);
  return out;
}

const MAKERS = {
  'ghostty-raw': (cols, rows, sb) => new GhosttyRaw(rawMod, cols, rows, { scrollback: sb }),
  'ghostty-raw-alloc': (cols, rows, sb) => new GhosttyRaw(rawMod, cols, rows, { scrollback: sb, reuseBuffer: false }),
  'ghostty-web': (cols, rows, sb) => new GhosttyWeb(webPerf, cols, rows, { scrollback: sb }),
  xterm: (cols, rows) => new Xterm(XtermTerminal, cols, rows, { scrollback: SCROLLBACK_LINES }),
};

function make(driver, size) {
  return MAKERS[driver](size.cols, size.rows, ghosttyBudget.get(size.label).budget);
}

// ---------------------------------------------------------------------------
// write benchmark
// ---------------------------------------------------------------------------

async function feed(term, bytes) {
  for (let off = 0; off < bytes.length; off += CHUNK) {
    const chunk = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
    const r = term.write(chunk);
    if (r && typeof r.then === 'function') await r;
  }
}

async function benchWrite(driver, stream, size) {
  const times = [];
  for (let i = 0; i < WARMUP + REPS; i++) {
    const term = make(driver, size);
    const t0 = process.hrtime.bigint();
    await feed(term, stream.bytes);
    const t1 = process.hrtime.bigint();
    // Read one cell after timing so the parse cannot be dead-code eliminated
    // and so a silently broken driver shows up as an empty grid.
    const probe = term.readViewport ? term.readViewport() : null;
    const retained = term.totalRows;
    term.free?.();
    lastRetained = retained;
    if (i >= WARMUP) times.push(Number(t1 - t0) / 1e6);
    if (i === WARMUP && probe) checkNonEmpty(driver, stream.name, size.label, probe);
  }
  return times;
}

let lastRetained = 0;
const emptyGrids = [];
function checkNonEmpty(driver, stream, size, pool) {
  let nonBlank = 0;
  for (const c of pool) if (c.codepoint > 32) nonBlank++;
  if (nonBlank === 0) emptyGrids.push(`${driver} ${stream} ${size}`);
}

// ---------------------------------------------------------------------------
// read benchmark
// ---------------------------------------------------------------------------

async function benchRead(driver, stream, size) {
  const term = make(driver, size);
  await feed(term, stream.bytes);
  for (let i = 0; i < WARMUP; i++) term.readViewport();
  const times = [];
  for (let i = 0; i < REPS; i++) {
    const t0 = process.hrtime.bigint();
    term.readViewport();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  term.free?.();
  return times;
}

/**
 * The typing-path read: one cell changed since the last frame, then the read
 * the render loop performs for the next frame.
 *
 * This is NOT a like-for-like comparison and is reported on its own. ghostty's
 * damage-driven path skips clean rows, which is a real architectural advantage
 * because ghostty-vt exposes a per-row dirty flag. @xterm/headless exposes no
 * equivalent public API, so the xterm column here is the same full walk it
 * always does. The point of the section is to size the advantage, not to
 * pretend the two are doing the same thing.
 */
async function benchTypingRead(driver, stream, size) {
  const term = make(driver, size);
  await feed(term, stream.bytes);
  const damaged = () => {
    if (typeof term.readViewportDamaged === 'function') return term.readViewportDamaged();
    return term.readViewport();
  };
  const step = (i) => {
    const b = Buffer.from(`\x1b[2;2H${String.fromCharCode(97 + (i % 26))}`, 'latin1');
    const r = term.write(b);
    return r && typeof r.then === 'function' ? r : null;
  };
  for (let i = 0; i < WARMUP; i++) {
    damaged();
    term.markClean?.();
    await step(i);
  }
  const times = [];
  for (let i = 0; i < REPS; i++) {
    damaged();
    term.markClean?.();
    await step(i);
    const t0 = process.hrtime.bigint();
    damaged();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  term.free?.();
  return times;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const WRITE_DRIVERS = ['ghostty-raw', 'ghostty-raw-alloc', 'ghostty-web', 'xterm'];
const READ_DRIVERS = ['ghostty-raw', 'ghostty-web', 'xterm'];

/**
 * Every driver is timed in its own fresh node process.
 *
 * Running all four in one process gave wildly unstable small-grid numbers:
 * whole-stream times swinging 159 ms to 225 ms across repetitions of the same
 * work, and ghostty-raw measuring slower than ghostty-raw-alloc, which is its
 * own strictly-more-work variant. That is not the parsers, it is one shared
 * heap and one shared set of inline caches: whichever driver runs first pays
 * the JIT warmup and megamorphic call sites, and everyone shares the GC
 * pauses. Isolation removes it. The 200x55 rows in the single-process run were
 * already tight, because by then everything was warm, which is exactly the
 * signature of the artifact.
 *
 * The child runs one driver, one size, all streams, and prints one JSON line.
 */
async function runChild(driver, size, calBudget) {
  const { execFileSync } = await import('node:child_process');
  const payload = JSON.stringify({
    driver,
    size,
    budget: calBudget,
    reps: REPS,
    warmup: WARMUP,
    scrollbackLines: SCROLLBACK_LINES,
    streams: STREAMS,
  });
  const out = execFileSync(
    process.execPath,
    ['--max-old-space-size=8192', fileURLToPath(import.meta.url), '--child', payload],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const line = out.trim().split('\n').at(-1);
  return JSON.parse(line);
}

async function child(spec) {
  await ensureLoaded();
  ghosttyBudget.set(spec.size.label, { budget: spec.budget });
  const streams = pickStreams();
  const out = { driver: spec.driver, size: spec.size.label, write: {}, read: {}, typing: {} };
  for (const stream of streams) {
    out.write[stream.name] = { ...stats(await benchWrite(spec.driver, stream, spec.size)), retained: lastRetained };
    if (READ_DRIVERS.includes(spec.driver)) {
      out.read[stream.name] = stats(await benchRead(spec.driver, stream, spec.size));
      out.typing[stream.name] = stats(await benchTypingRead(spec.driver, stream, spec.size));
    }
  }
  out.empty = emptyGrids;
  process.stdout.write(JSON.stringify(out) + '\n');
}

async function main() {
  await ensureLoaded();
  const streams = pickStreams();
  if (streams.length === 0) throw new Error('no streams matched');

  const results = { meta: meta(), write: [], read: [], typing: [] };

  console.log(`node ${process.version}  ${SIZES.length} sizes  ${streams.length} streams`);
  console.log(`reps ${REPS} (after ${WARMUP} warmup), 64 KiB chunks`);
  console.log(`scrollback target ${SCROLLBACK_LINES} lines on every driver`);
  console.log('each driver timed in its own node process\n');

  for (const size of SIZES) {
    const cal = await calibrate(size);
    results.meta.calibration ??= {};
    results.meta.calibration[size.label] = cal;
    console.log(`=== ${size.label} (${size.cols * size.rows} cells) ===`);
    console.log(
      `ghostty max_scrollback calibrated to ${cal.budget} bytes` +
        ` -> ${cal.retained} rows retained against a target of ${cal.target}\n`,
    );

    const byDriver = {};
    for (const d of WRITE_DRIVERS) byDriver[d] = await runChild(d, size, cal.budget);
    for (const d of WRITE_DRIVERS) for (const e of byDriver[d].empty ?? []) emptyGrids.push(e);

    console.log('WRITE  MiB/s median, and ms for the whole stream [min-max]');
    console.log(
      pad('stream', 16) + pad('MiB', 7) + WRITE_DRIVERS.map((d) => pad(d, 22)).join('') + 'ghostty best vs xterm',
    );
    for (const stream of streams) {
      const mib = stream.bytes.length / (1024 * 1024);
      const row = { size: size.label, stream: stream.name, bytes: stream.bytes.length, drivers: {} };
      let line = pad(stream.name, 16) + pad(fmtMB(mib), 7);
      for (const d of WRITE_DRIVERS) {
        const s = byDriver[d].write[stream.name];
        row.drivers[d] = { ms: s, mibps: mib / (s.median / 1000), retained: s.retained };
        line += pad(`${fmtMB(mib / (s.median / 1000))} [${fmtMs(s.min)}-${fmtMs(s.max)}ms]`, 22);
      }
      const gb = Math.min(row.drivers['ghostty-raw'].ms.median, row.drivers['ghostty-web'].ms.median);
      row.ghosttyVsXterm = row.drivers.xterm.ms.median / gb;
      line += `${row.ghosttyVsXterm.toFixed(2)}x`;
      console.log(line);
      results.write.push(row);
    }

    console.log('\nREAD  ms per full viewport, median [min-max]');
    console.log(pad('stream', 16) + READ_DRIVERS.map((d) => pad(d, 24)).join('') + 'ghostty-web vs xterm');
    for (const stream of streams) {
      const row = { size: size.label, stream: stream.name, drivers: {} };
      let line = pad(stream.name, 16);
      for (const d of READ_DRIVERS) {
        const s = byDriver[d].read[stream.name];
        row.drivers[d] = s;
        line += pad(`${fmtMs(s.median)} [${fmtMs(s.min)}-${fmtMs(s.max)}]`, 24);
      }
      row.ghosttyWebVsXterm = row.drivers['ghostty-web'].median / row.drivers.xterm.median;
      line += `${row.ghosttyWebVsXterm.toFixed(2)}x`;
      console.log(line);
      results.read.push(row);
    }

    console.log('\nTYPING READ  ms for the next frame after a one-cell write, median [min-max]');
    console.log('not like-for-like: ghostty-web skips clean rows, xterm has no dirty-row API and rewalks');
    console.log(pad('stream', 16) + READ_DRIVERS.map((d) => pad(d, 24)).join(''));
    for (const stream of streams) {
      const row = { size: size.label, stream: stream.name, drivers: {} };
      let line = pad(stream.name, 16);
      for (const d of READ_DRIVERS) {
        const s = byDriver[d].typing[stream.name];
        row.drivers[d] = s;
        line += pad(`${fmtMs(s.median)} [${fmtMs(s.min)}-${fmtMs(s.max)}]`, 24);
      }
      console.log(line);
      results.typing.push(row);
    }
    console.log('');
  }

  if (emptyGrids.length) {
    console.log('WARNING: these runs produced an all-blank grid, treat their numbers as suspect:');
    for (const g of emptyGrids) console.log('  ' + g);
    console.log('');
  }

  if (args.json) {
    writeFileSync(String(args.json), JSON.stringify(results, null, 2));
    console.log(`wrote ${args.json}`);
  }
}

function pad(s, n) {
  return String(s).padEnd(n);
}

function meta() {
  let cpu = '';
  try {
    cpu = readFileSync('/proc/cpuinfo', 'utf8').match(/model name\s*:\s*(.+)/)?.[1] ?? '';
  } catch {
    /* not linux */
  }
  return {
    node: process.version,
    v8: process.versions.v8,
    platform: `${process.platform} ${process.arch}`,
    cpu,
    reps: REPS,
    warmup: WARMUP,
    chunk: CHUNK,
    when: new Date().toISOString(),
  };
}

const entry = args.child ? child(JSON.parse(String(args.child))) : main();
entry.catch((e) => {
  console.error(e);
  process.exit(1);
});
