// The worker side of contenders 3, 4 and 5.
//
//   pack       parse + pack here, hand the viewport to the main thread as a
//              transferred ArrayBuffer, main thread runs vtgl (contender 3)
//   sab        same, but the viewport lands in a double-buffered
//              SharedArrayBuffer with a sequence word (contender 4)
//   offscreen  parse + pack + vtgl all here, main thread never touches a cell
//              (contender 5)
//
// In every mode the byte feed itself lives here, which is the architectural
// claim under test: a pty socket opened in the worker means raw output never
// crosses the main thread.

import { loadVt, PackedVt } from './vtcore.mjs';
import { PackedSource, PACKED_STRIDE } from './packed-source.mjs';

const THEME = { foreground: 0xd0d0d0, background: 0x101010, cursor: 0xffffff };

let mode = 'pack';
let cols = 0;
let rows = 0;
let panes = [];
let chunks = [];
let freeBufs = [];
let running = false;
let seq = 0;
let sab = null;
let sabCells = 0;
let dirtyBase = 0;

// Everything the worker measures about itself. The main thread cannot see any
// of this, and for contender 5 it is the only place frame timing exists.
const stats = {
  bytesFed: 0,
  frames: 0,
  frameTs: [],
  packMs: [],
  renderMs: [],
  posts: 0,
};

class Pane {
  constructor(vt, index) {
    this.vt = vt;
    this.index = index;
    this.chunkIdx = 0;
    this.renderer = null;
    this.source = null;
    this.pendingPost = false;
  }
}

async function makeRenderer(canvas, c, r) {
  const { WebGL2Renderer } = await import('./vtgl.js');
  const ren = new WebGL2Renderer({
    fontFamily: 'monospace',
    fontSize: 14,
    dpr: 1,
    theme: THEME,
    resolveInverse: false,
  });
  ren.mount(canvas);
  ren.resize(c, r, 1);
  return ren;
}

async function init(msg) {
  mode = msg.mode;
  cols = msg.cols;
  rows = msg.rows;
  sabCells = cols * rows * PACKED_STRIDE;

  const raw = new Uint8Array(await (await fetch(msg.streamUrl)).arrayBuffer());
  const CH = 65536;
  chunks = [];
  for (let i = 0; i + CH <= raw.length; i += CH) chunks.push(raw.subarray(i, i + CH));

  const g = await loadVt();
  panes = [];
  for (let i = 0; i < msg.panes; i++) {
    const p = new Pane(new PackedVt(g, cols, rows), i);
    // Stagger the starting offset so eight panes are not the same program in
    // lockstep, which would make the multiplexed case unrealistically cache
    // friendly.
    p.chunkIdx = Math.floor((i * chunks.length) / msg.panes);
    if (mode === 'offscreen') {
      p.renderer = await makeRenderer(msg.canvases[i], cols, rows);
      p.source = new PackedSource(cols, rows, THEME);
    }
    panes.push(p);
  }

  if (mode === 'sab') {
    dirtyBase = 32 + msg.panes * 2 * sabCells;
    // Two viewport slots per pane plus a control block: [seq, slot, ...].
    // The main thread reads seq, reads the slot it names, then re-reads seq;
    // a change means it saw a torn frame and must retry.
    sab = msg.sab;
  }

  postMessage({ t: 'ready' });
}

function packAndShip(p) {
  const t0 = performance.now();
  const { cells, dirty } = p.vt.pack();
  p.vt.markClean();
  const t1 = performance.now();
  stats.packMs.push(t1 - t0);

  if (mode === 'offscreen') {
    p.source.attach(cells, dirty);
    const r0 = performance.now();
    p.renderer.render(p.source, 0);
    stats.renderMs.push(performance.now() - r0);
    return;
  }

  if (mode === 'sab') {
    // Each pane owns its own pair of slots. The first version sized the region
    // for a single viewport regardless of pane count, so eight panes all wrote
    // over each other and every pane drew the last one's contents. That is a
    // correctness bug, not a cheap layout, and it made the eight-pane SAB
    // numbers meaningless until it was fixed.
    const ctrl = new Int32Array(sab, 0, 8);
    const slot = (Atomics.load(ctrl, 1) + 1) & 1;
    const paneBase = 32 + p.index * 2 * sabCells;
    new Uint8Array(sab, paneBase + slot * sabCells, sabCells).set(cells);
    new Uint8Array(sab, dirtyBase + p.index * rows, rows).set(dirty);
    if (p.index === panes.length - 1) {
      Atomics.store(ctrl, 1, slot);
      Atomics.add(ctrl, 0, 1);
    }
    stats.posts++;
    return;
  }

  // Transferable handoff. A recycled buffer is reused when the main thread has
  // sent one back, so steady state allocates nothing.
  let buf = freeBufs.pop();
  if (!buf || buf.byteLength !== sabCells + rows) buf = new ArrayBuffer(sabCells + rows);
  const view = new Uint8Array(buf);
  view.set(cells, 0);
  view.set(dirty, sabCells);
  stats.posts++;
  postMessage({ t: 'frame', pane: p.index, buf, seq: ++seq, packedAt: performance.now() }, [buf]);
}

/**
 * The flood loop: feed until the consumer is the limit, pack at display cadence.
 *
 * Feeding and packing are deliberately decoupled. Packing on every chunk would
 * measure a pathological design; packing only when a frame is due is what a
 * real renderer does and is what xterm.js's own debouncer does on the other
 * side of the comparison.
 */
async function flood(ms, packEveryMs, targetMiBs = 0) {
  running = true;
  const t0 = performance.now();
  const end = t0 + ms;
  const perSec = targetMiBs * 1048576;
  let lastPack = 0;
  while (running && performance.now() < end) {
    if (perSec > 0) {
      const owed = (stats.bytesFed / perSec) * 1000 - (performance.now() - t0);
      if (owed > 0) await new Promise((r) => setTimeout(r, owed));
    }
    for (const p of panes) {
      const c = chunks[p.chunkIdx % chunks.length];
      p.chunkIdx++;
      p.vt.write(c);
      stats.bytesFed += c.length;
    }
    const now = performance.now();
    if (now - lastPack >= packEveryMs) {
      lastPack = now;
      for (const p of panes) packAndShip(p);
      stats.frames++;
      stats.frameTs.push(performance.now());
      // Yield so incoming messages (keystrokes, recycled buffers) are seen.
      // Without this the worker is a single uninterruptible task and the
      // latency numbers would measure the harness, not the architecture.
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  running = false;
  postMessage({ t: 'flood-done', stats: snapshotStats() });
}

function snapshotStats() {
  return {
    bytesFed: stats.bytesFed,
    frames: stats.frames,
    frameTs: stats.frameTs.slice(),
    packMs: stats.packMs.slice(),
    renderMs: stats.renderMs.slice(),
    posts: stats.posts,
  };
}

function resetStats() {
  stats.bytesFed = 0;
  stats.frames = 0;
  stats.frameTs.length = 0;
  stats.packMs.length = 0;
  stats.renderMs.length = 0;
  stats.posts = 0;
}

/** Feed a fixed prefix of the stream with no timing, for the pixel controls. */
function feedFixed(bytes, paneIdx) {
  const p = panes[paneIdx ?? 0];
  for (let i = 0; i + 65536 <= bytes; i += 65536) {
    p.vt.write(chunks[(i / 65536) % chunks.length]);
  }
}

onmessage = async (e) => {
  const m = e.data;
  switch (m.t) {
    case 'init':
      await init(m);
      break;
    case 'flood':
      resetStats();
      await flood(m.ms, m.packEveryMs ?? 8, m.targetMiBs ?? 0);
      break;
    case 'stop':
      running = false;
      break;
    case 'recycle':
      freeBufs.push(m.buf);
      break;
    case 'key': {
      // Local echo, in the worker, exactly as a worker-resident pty would do it.
      const p = panes[0];
      p.vt.write(new Uint8Array(m.bytes));
      packAndShip(p);
      postMessage({ t: 'keydone', id: m.id, at: performance.now() });
      break;
    }
    case 'feed-fixed':
      resetStats();
      feedFixed(m.bytes, m.pane);
      for (const p of panes) packAndShip(p);
      postMessage({ t: 'fed' });
      break;
    case 'checksum': {
      const p = panes[m.pane ?? 0];
      const { cells } = p.vt.pack();
      // Byte-wise FNV, the identical function the main thread uses. Hashing
      // words here and bytes there produced two different numbers for the same
      // buffer and looked exactly like a real divergence.
      let h = 2166136261;
      for (let i = 0; i < cells.length; i++) {
        h ^= cells[i];
        h = Math.imul(h, 16777619) >>> 0;
      }
      postMessage({ t: 'checksum', value: h >>> 0 });
      break;
    }
    case 'pixels': {
      // Only meaningful in offscreen mode; the canvas lives here. Render and
      // read back inside one task: with preserveDrawingBuffer false the
      // contents are gone as soon as the frame is handed to the compositor.
      const p = panes[m.pane ?? 0];
      const { cells, dirty } = p.vt.pack();
      p.source.attach(cells, dirty);
      p.renderer.render(p.source, 0);
      const gl = p.renderer.gl;
      postMessage({ t: 'pixels', hash: gl ? hashFramebuffer(gl) : null });
      break;
    }
    case 'raf-probe': {
      const has = typeof requestAnimationFrame === 'function';
      postMessage({ t: 'raf-probe', has });
      break;
    }
  }
};

function hashFramebuffer(gl) {
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let a = 2166136261;
  const seen = new Set();
  let nonBg = 0;
  for (let i = 0; i < px.length; i += 4) {
    const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    if (seen.size < 20000) seen.add(k);
    if (k !== 0x101010) nonBg++;
  }
  for (let i = 0; i < px.length; i++) {
    a ^= px[i];
    a = Math.imul(a, 16777619) >>> 0;
  }
  return { hash: a >>> 0, w, h, distinctColors: seen.size, nonBgFraction: nonBg / (w * h) };
}
