// The five contenders and the scenario runner, in one page.
//
// Everything the main thread is asked to do is identical across contenders
// except the part under test: where the VT lives and who draws. The byte feed
// is where that shows up. In contenders 1 and 2 the feed loop runs on the main
// thread, because that is where a WebSocket delivering pty output would land
// for an architecture whose terminal lives there. In 3, 4 and 5 the feed loop
// runs in the worker, because that is the whole claim.

import { WebGL2Renderer } from './vtgl.js';
import { loadVt, PackedVt } from './vtcore.mjs';
import { PackedSource, PACKED_STRIDE } from './packed-source.mjs';

const THEME = { foreground: 0xd0d0d0, background: 0x101010, cursor: 0xffffff };
const CHUNK = 65536;

const macrotask = () => new Promise((r) => setTimeout(r, 0));

function stats(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
  return {
    n: s.length,
    min: s[0],
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

function fnv(u8) {
  let h = 2166136261;
  for (let i = 0; i < u8.length; i++) {
    h ^= u8[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function makeCanvas(container, i) {
  const c = document.createElement('canvas');
  c.id = `cv${i}`;
  container.appendChild(c);
  return c;
}

/**
 * Explicitly drop a WebGL context.
 *
 * Chrome caps live WebGL contexts per page and reclaims them only when the
 * canvas is collected. An eight-pane run creates eight, and without this the
 * next contender's first mount fails with "webgl2 context unavailable" and
 * would be recorded as that contender failing rather than as harness debris.
 */
function loseContext(canvas) {
  try {
    const gl = canvas.getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    /* nothing usable to lose */
  }
}

// ---------------------------------------------------------------------------
// contender 1: xterm.js + WebGL addon, main thread
// ---------------------------------------------------------------------------

class XtermContender {
  static id = 'c1-xterm-webgl-main';
  constructor() {
    this.terms = [];
    this.renderers = [];
    this.pendingKey = null;
  }

  async init({ container, cols, rows, panes, streamUrl }) {
    const { Terminal } = await import('/xterm.mjs');
    const { WebglAddon } = await import('/addon-webgl.mjs');
    this.raw = new Uint8Array(await (await fetch(streamUrl)).arrayBuffer());
    this.chunks = [];
    for (let i = 0; i + CHUNK <= this.raw.length; i += CHUNK) {
      this.chunks.push(this.raw.subarray(i, i + CHUNK));
    }
    for (let i = 0; i < panes; i++) {
      const el = document.createElement('div');
      el.className = 'pane';
      container.appendChild(el);
      const term = new Terminal({
        cols,
        rows,
        allowProposedApi: true,
        scrollback: 1000,
        fontSize: 14,
        fontFamily: 'monospace',
        cursorBlink: false,
        theme: { background: '#101010', foreground: '#d0d0d0' },
      });
      term.open(el);
      const addon = new WebglAddon();
      term.loadAddon(addon);
      // WebglAddon swaps the render service's renderer in asynchronously. A
      // harness that starts timing before the swap is timing the DOM renderer,
      // which is the exact trap a previous run fell into. Wait for the swap and
      // assert on a property only the WebGL renderer has.
      let renderer = null;
      for (let k = 0; k < 200 && !renderer; k++) {
        const rs = term._core?._renderService;
        const r = rs?._renderer?.value ?? rs?._renderer;
        if (r && typeof r.renderRows === 'function' && 'textureAtlas' in r) renderer = r;
        else await new Promise((res) => setTimeout(res, 25));
      }
      if (!renderer) throw new Error('c1: WebGL renderer never became active');
      this.terms.push(term);
      this.renderers.push(renderer);
      this.chunkIdx = this.chunkIdx ?? [];
      this.chunkIdx[i] = Math.floor((i * this.chunks.length) / panes);
    }
    this.panes = panes;
  }

  /** True if every pane really is on the WebGL renderer. */
  rendererProof() {
    return this.renderers.map((r) => ({
      hasAtlas: 'textureAtlas' in r,
      ctor: r.constructor?.name ?? '?',
    }));
  }

  write(pane, bytes) {
    return new Promise((res) => this.terms[pane].write(bytes, res));
  }

  async feedRound() {
    const ps = [];
    for (let i = 0; i < this.panes; i++) {
      const c = this.chunks[this.chunkIdx[i] % this.chunks.length];
      this.chunkIdx[i]++;
      ps.push(this.write(i, c));
    }
    await Promise.all(ps);
    return this.panes * CHUNK;
  }

  /** xterm owns its own render scheduling; the harness must not fake one. */
  frame() {}

  sendKey(bytes, onEcho) {
    // The echo enters xterm's own write queue, behind whatever flood chunks are
    // already in it, which is the queueing a real keystroke would meet. The
    // callback fires when it has been parsed; the paint follows on xterm's next
    // animation frame, which is the same frame boundary every other contender
    // is measured to.
    this.terms[0].write(new Uint8Array(bytes), () => {
      this.echoPending = onEcho;
    });
  }

  afterFrame() {
    if (this.echoPending) {
      const f = this.echoPending;
      this.echoPending = null;
      f();
    }
  }

  /**
   * xterm draws on its own schedule, so the readback has to ride its render
   * event. Reading at any later point returns a cleared buffer, because the
   * context has preserveDrawingBuffer false and the frame is already gone to
   * the compositor.
   */
  async renderAndHash() {
    return new Promise((res) => {
      const d = this.terms[0].onRender(() => {
        d.dispose();
        const cvs = [...this.terms[0].element.querySelectorAll('canvas')];
        const hs = cvs.map((c) => hashAny(c)).filter(Boolean);
        // xterm's WebGL addon stacks several canvases; the one that matters is
        // whichever carries actual glyph coverage.
        hs.sort((a, b) => b.nonBgFraction - a.nonBgFraction);
        res(hs[0] ?? null);
      });
      this.terms[0].refresh(0, this.terms[0].rows - 1);
    });
  }

  dispose() {
    for (const t of this.terms) {
      for (const cv of t.element?.querySelectorAll('canvas') ?? []) loseContext(cv);
      t.dispose();
    }
  }
}

// ---------------------------------------------------------------------------
// contender 2: ghostty-wasm + pack + vtgl, all main thread
// ---------------------------------------------------------------------------

class MainThreadGhostty {
  static id = 'c2-ghostty-vtgl-main';
  constructor() {
    this.vts = [];
    this.sources = [];
    this.renderers = [];
    this.canvases = [];
    this.pendingKey = null;
    this.packMs = [];
    this.renderMs = [];
  }

  async init({ container, cols, rows, panes, streamUrl }) {
    this.raw = new Uint8Array(await (await fetch(streamUrl)).arrayBuffer());
    this.chunks = [];
    for (let i = 0; i + CHUNK <= this.raw.length; i += CHUNK) {
      this.chunks.push(this.raw.subarray(i, i + CHUNK));
    }
    const g = await loadVt();
    this.chunkIdx = [];
    for (let i = 0; i < panes; i++) {
      const cv = makeCanvas(container, i);
      const r = new WebGL2Renderer({
        fontFamily: 'monospace',
        fontSize: 14,
        dpr: 1,
        theme: THEME,
        resolveInverse: false,
      });
      r.mount(cv);
      r.resize(cols, rows, 1);
      this.canvases.push(cv);
      this.renderers.push(r);
      this.vts.push(new PackedVt(g, cols, rows));
      this.sources.push(new PackedSource(cols, rows, THEME));
      this.chunkIdx[i] = Math.floor((i * this.chunks.length) / panes);
    }
    this.panes = panes;
  }

  async feedRound() {
    for (let i = 0; i < this.panes; i++) {
      const c = this.chunks[this.chunkIdx[i] % this.chunks.length];
      this.chunkIdx[i]++;
      this.vts[i].write(c);
    }
    return this.panes * CHUNK;
  }

  /** One frame: pack every pane out of wasm and draw it. All on this thread. */
  frame() {
    for (let i = 0; i < this.panes; i++) {
      const t0 = performance.now();
      const { cells, dirty } = this.vts[i].pack();
      this.vts[i].markClean();
      this.sources[i].attach(cells, dirty);
      const t1 = performance.now();
      this.renderers[i].render(this.sources[i], 0);
      const t2 = performance.now();
      this.packMs.push(t1 - t0);
      this.renderMs.push(t2 - t1);
    }
  }

  sendKey(bytes, onEcho) {
    this.vts[0].write(new Uint8Array(bytes));
    this.echoPending = onEcho;
  }

  afterFrame() {
    if (this.echoPending) {
      const f = this.echoPending;
      this.echoPending = null;
      f();
    }
  }

  checksum(pane = 0) {
    const { cells } = this.vts[pane].pack();
    return fnv(cells);
  }

  /** Render and read back inside one task, before the frame is composited. */
  async renderAndHash(pane = 0) {
    const { cells, dirty } = this.vts[pane].pack();
    this.sources[pane].attach(cells, dirty);
    this.renderers[pane].render(this.sources[pane], 0);
    return hashGl(this.canvases[pane]);
  }

  dispose() {
    for (const r of this.renderers) r.dispose();
    for (const c of this.canvases) loseContext(c);
  }
}

// ---------------------------------------------------------------------------
// contenders 3, 4, 5: worker-resident VT
// ---------------------------------------------------------------------------

class WorkerContender {
  constructor(mode) {
    this.mode = mode;
    this.static_id = mode;
    this.sources = [];
    this.renderers = [];
    this.canvases = [];
    this.latest = [];
    this.adoptMs = [];
    this.renderMs = [];
    this.keyWaiters = new Map();
    this.keyId = 0;
    this.framesReceived = 0;
    this.latestSeq = 0;
    this.drawnSeq = -1;
  }

  async init({ container, cols, rows, panes, streamUrl }) {
    this.cols = cols;
    this.rows = rows;
    this.panes = panes;
    this.cellBytes = cols * rows * PACKED_STRIDE;
    this.worker = new Worker('/worker.mjs', { type: 'module' });
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => {
      console.error('worker error', e.message);
    };

    const msg = { t: 'init', mode: this.mode, cols, rows, panes, streamUrl };
    const transfer = [];

    if (this.mode === 'offscreen') {
      msg.canvases = [];
      for (let i = 0; i < panes; i++) {
        const cv = makeCanvas(container, i);
        // vtgl sizes the backing store itself, but transferControlToOffscreen
        // freezes the element's own width/height, so give it the real geometry
        // up front.
        cv.width = cols * 8;
        cv.height = rows * 17;
        this.canvases.push(cv);
        const off = cv.transferControlToOffscreen();
        msg.canvases.push(off);
        transfer.push(off);
      }
    } else {
      for (let i = 0; i < panes; i++) {
        const cv = makeCanvas(container, i);
        const r = new WebGL2Renderer({
          fontFamily: 'monospace',
          fontSize: 14,
          dpr: 1,
          theme: THEME,
          resolveInverse: false,
        });
        r.mount(cv);
        r.resize(cols, rows, 1);
        this.canvases.push(cv);
        this.renderers.push(r);
        this.sources.push(new PackedSource(cols, rows, THEME));
        this.latest.push(null);
      }
      if (this.mode === 'sab') {
        // 32 control bytes, two viewport slots, one dirty block per pane.
        this.sab = new SharedArrayBuffer(32 + panes * 2 * this.cellBytes + panes * rows);
        this.dirtyBase = 32 + panes * 2 * this.cellBytes;
        this.ctrl = new Int32Array(this.sab, 0, 8);
        msg.sab = this.sab;
        this.lastSeq = 0;
      }
    }

    const ready = new Promise((res) => (this.readyRes = res));
    this.worker.postMessage(msg, transfer);
    await ready;
  }

  onMessage(m) {
    switch (m.t) {
      case 'ready':
        this.readyRes?.();
        break;
      case 'frame': {
        this.framesReceived++;
        const old = this.latest[m.pane];
        if (old) this.worker.postMessage({ t: 'recycle', buf: old }, [old]);
        this.latest[m.pane] = m.buf;
        this.latestSeq = m.seq;
        break;
      }
      case 'flood-done':
        this.floodRes?.(m.stats);
        break;
      case 'keydone': {
        const w = this.keyWaiters.get(m.id);
        if (!w) break;
        this.keyWaiters.delete(m.id);
        if (this.mode === 'offscreen') {
          // The worker drew it; that IS the paint for this contender.
          w();
        } else {
          // The worker has packed the echo but nothing is on screen until the
          // main thread's next frame draws it. Resolving here instead would
          // hand contenders 3 and 4 a latency number for work they have not
          // finished, which is the flattering-but-wrong version of this metric.
          this.echoPending = w;
        }
        break;
      }
      case 'checksum':
        this.checksumRes?.(m.value);
        break;
      case 'pixels':
        this.pixelsRes?.(m.hash);
        break;
      case 'fed':
        this.fedRes?.();
        break;
    }
  }

  /** The feed runs in the worker, so the main thread's round is a no-op. */
  async feedRound() {
    return 0;
  }

  async flood(ms, packEveryMs, targetMiBs) {
    const p = new Promise((res) => (this.floodRes = res));
    this.worker.postMessage({ t: 'flood', ms, packEveryMs, targetMiBs });
    return p;
  }

  /** Main-thread frame: adopt whatever the worker last produced and draw it. */
  frame() {
    if (this.mode === 'offscreen') return;
    if (this.mode === 'sab') {
      const seq = Atomics.load(this.ctrl, 0);
      if (seq === this.lastSeq) return;
      const slot = Atomics.load(this.ctrl, 1);
      const t0 = performance.now();
      for (let i = 0; i < this.panes; i++) {
        const cells = new Uint8Array(
          this.sab,
          32 + i * 2 * this.cellBytes + slot * this.cellBytes,
          this.cellBytes,
        );
        const dirty = new Uint8Array(this.sab, this.dirtyBase + i * this.rows, this.rows);
        this.sources[i].adopt(cells, dirty);
      }
      const t1 = performance.now();
      // A seq change between the two reads means the worker overwrote the slot
      // underneath us. Count it rather than pretending it cannot happen.
      if (Atomics.load(this.ctrl, 0) !== seq) this.torn = (this.torn ?? 0) + 1;
      this.lastSeq = seq;
      for (let i = 0; i < this.panes; i++) this.renderers[i].render(this.sources[i], 0);
      this.adoptMs.push(t1 - t0);
      this.renderMs.push(performance.now() - t1);
      return;
    }
    // Redraw only when the worker has actually delivered something new. The
    // SAB path skipped unchanged frames from the start because its sequence
    // word made that free, and the transferable path did not, which under a
    // paced feed made the same architecture look four times more expensive on
    // one transport than the other. That is a harness asymmetry, not a
    // property of either transport.
    if (this.latestSeq === this.drawnSeq) return;
    this.drawnSeq = this.latestSeq;
    let drew = false;
    const t0 = performance.now();
    for (let i = 0; i < this.panes; i++) {
      const buf = this.latest[i];
      if (!buf || buf.byteLength === 0) continue;
      const view = new Uint8Array(buf);
      this.sources[i].attach(view.subarray(0, this.cellBytes), view.subarray(this.cellBytes));
      drew = true;
    }
    const t1 = performance.now();
    if (!drew) return;
    for (let i = 0; i < this.panes; i++) {
      if (this.latest[i]) this.renderers[i].render(this.sources[i], 0);
    }
    this.adoptMs.push(t1 - t0);
    this.renderMs.push(performance.now() - t1);
  }

  sendKey(bytes, onEcho) {
    const id = ++this.keyId;
    this.keyWaiters.set(id, () => onEcho());
    this.worker.postMessage({ t: 'key', bytes, id });
  }

  afterFrame() {
    if (this.echoPending) {
      const f = this.echoPending;
      this.echoPending = null;
      f();
    }
  }

  async checksum(pane = 0) {
    const p = new Promise((res) => (this.checksumRes = res));
    this.worker.postMessage({ t: 'checksum', pane });
    return p;
  }

  async feedFixed(bytes) {
    const p = new Promise((res) => (this.fedRes = res));
    this.worker.postMessage({ t: 'feed-fixed', bytes });
    return p;
  }

  async renderAndHash(pane = 0) {
    if (this.mode === 'offscreen') {
      const p = new Promise((res) => (this.pixelsRes = res));
      this.worker.postMessage({ t: 'pixels', pane });
      return p;
    }
    this.frame();
    return hashGl(this.canvases[pane]);
  }

  dispose() {
    this.worker.terminate();
    for (const r of this.renderers) r.dispose();
    if (this.mode !== 'offscreen') for (const c of this.canvases) loseContext(c);
  }
}

// ---------------------------------------------------------------------------
// pixel readback
// ---------------------------------------------------------------------------

/**
 * Hash a WebGL canvas, and refuse to hash a blank one silently.
 *
 * A pixel comparison between two blank canvases passes and proves nothing,
 * which is the same shape of vacuity that made a previous verification pass
 * over a uniformly zero stream. distinctColors and nonBg are returned so the
 * caller can require the frame to have content.
 */
function hashGl(canvas) {
  const gl = canvas.getContext('webgl2');
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const seen = new Set();
  let nonBg = 0;
  for (let i = 0; i < px.length; i += 4) {
    const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    if (seen.size < 20000) seen.add(k);
    if (k !== 0x101010) nonBg++;
  }
  return { hash: fnv(px), w, h, distinctColors: seen.size, nonBgFraction: nonBg / (w * h) };
}

/** Hash whichever kind of context a canvas already has. */
function hashAny(cv) {
  try {
    const gl = cv.getContext('webgl2');
    if (gl) return hashGl(cv);
  } catch {
    /* the canvas belongs to another context type; fall through */
  }
  try {
    const ctx = cv.getContext('2d');
    if (!ctx) return null;
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const seen = new Set();
    let nonBg = 0;
    for (let i = 0; i < d.length; i += 4) {
      const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      if (seen.size < 20000) seen.add(k);
      if (k !== 0x101010) nonBg++;
    }
    return { hash: fnv(d), w: cv.width, h: cv.height, distinctColors: seen.size, nonBgFraction: nonBg / (cv.width * cv.height) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// scenario runner
// ---------------------------------------------------------------------------

const CONTENDERS = {
  c1: () => new XtermContender(),
  c2: () => new MainThreadGhostty(),
  c3: () => new WorkerContender('pack'),
  c4: () => new WorkerContender('sab'),
  c5: () => new WorkerContender('offscreen'),
};

let current = null;

window.setup = async (which, opts) => {
  if (current) {
    current.dispose();
    document.getElementById('stage').innerHTML = '';
    current = null;
    await new Promise((r) => setTimeout(r, 300));
  }
  const container = document.getElementById('stage');
  container.className = `panes-${opts.panes}`;
  const c = CONTENDERS[which]();
  await c.init({ container, ...opts });
  current = c;
  return {
    contender: which,
    proof: c.rendererProof ? c.rendererProof() : null,
  };
};

/**
 * Run the flood and collect every main-thread-side metric in one pass.
 *
 * The rAF loop runs for every contender, including the ones that do no work in
 * it, because the cadence of that loop is the frame-delivery measurement.
 */
window.runFlood = async ({ ms, packEveryMs = 8, keyIntervalMs = 0, targetMiBs = 0 }) => {
  const c = current;
  const rafTs = [];
  const frameWorkMs = [];
  const longTasks = [];
  const eventTiming = [];
  let bytes = 0;
  let stop = false;

  const lo = new PerformanceObserver((l) => {
    for (const e of l.getEntries()) longTasks.push({ start: e.startTime, dur: e.duration });
  });
  lo.observe({ type: 'longtask', buffered: false });

  const eo = new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      if (e.name === 'keydown') {
        eventTiming.push({ start: e.startTime, dur: e.duration, proc: e.processingEnd - e.processingStart });
      }
    }
  });
  try {
    eo.observe({ type: 'event', durationThreshold: 16, buffered: false });
  } catch {
    /* older builds lack durationThreshold; the rAF measure still stands */
  }

  const raf = (t) => {
    if (stop) return;
    rafTs.push(t);
    const a = performance.now();
    c.frame();
    frameWorkMs.push(performance.now() - a);
    c.afterFrame?.();
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);

  // Keystroke injection. Driven from inside the page on a timer so it is not
  // at the mercy of CDP scheduling, and measured two ways: to the echo being
  // drawn, and to the next main-thread animation frame.
  const keyLatency = [];
  const keyToRaf = [];
  let keyTimer = null;
  if (keyIntervalMs > 0) {
    keyTimer = setInterval(() => {
      const t0 = performance.now();
      const before = rafTs.length;
      c.sendKey([0x78], () => keyLatency.push(performance.now() - t0));
      const wait = () => {
        if (rafTs.length > before) keyToRaf.push(performance.now() - t0);
        else requestAnimationFrame(wait);
      };
      requestAnimationFrame(wait);
    }, keyIntervalMs);
  }

  const t0 = performance.now();
  let workerStats = null;

  if (c instanceof WorkerContender) {
    workerStats = await c.flood(ms, packEveryMs, targetMiBs);
    bytes = workerStats.bytesFed;
  } else {
    // With targetMiBs set, every contender is handed the same number of bytes
    // per second instead of as many as it will take. That is the only way to
    // read main-thread occupancy as a cost of the architecture: xterm.js
    // self-throttles its parser, so under an unpaced flood its occupancy is low
    // only because its throughput is low, and the two numbers cannot be read
    // separately.
    const perSec = targetMiBs * 1048576;
    while (performance.now() - t0 < ms) {
      bytes += await c.feedRound();
      if (perSec > 0) {
        const owed = (bytes / perSec) * 1000 - (performance.now() - t0);
        if (owed > 0) await new Promise((r) => setTimeout(r, owed));
        else await macrotask();
      } else {
        await macrotask();
      }
    }
  }
  const elapsed = performance.now() - t0;
  stop = true;
  if (keyTimer) clearInterval(keyTimer);
  lo.disconnect();
  eo.disconnect();
  await new Promise((r) => setTimeout(r, 100));

  const intervals = [];
  for (let i = 1; i < rafTs.length; i++) intervals.push(rafTs[i] - rafTs[i - 1]);

  return {
    elapsedMs: elapsed,
    bytes,
    mibPerSec: bytes / 1048576 / (elapsed / 1000),
    rafFrames: rafTs.length,
    rafFps: rafTs.length / (elapsed / 1000),
    rafInterval: stats(intervals),
    // rAF here is not vsync locked (see the report), so "dropped frames" is
    // reported as the shape of the interval distribution rather than as a
    // count against a 60 Hz target that does not exist in this environment.
    longFrames: {
      over16_7: intervals.filter((x) => x > 16.7).length,
      over33: intervals.filter((x) => x > 33).length,
      over100: intervals.filter((x) => x > 100).length,
    },
    frameWorkMs: stats(frameWorkMs),
    longTasks: {
      count: longTasks.length,
      totalMs: longTasks.reduce((a, b) => a + b.dur, 0),
      dur: stats(longTasks.map((t) => t.dur)),
    },
    keyEchoMs: stats(keyLatency),
    keyToRafMs: stats(keyToRaf),
    eventTimingMs: stats(eventTiming.map((e) => e.dur)),
    packMs: c.packMs ? stats(c.packMs) : null,
    renderMs: c.renderMs ? stats(c.renderMs) : null,
    adoptMs: c.adoptMs ? stats(c.adoptMs) : null,
    framesReceived: c.framesReceived ?? null,
    torn: c.torn ?? 0,
    worker: workerStats
      ? {
          bytesFed: workerStats.bytesFed,
          frames: workerStats.frames,
          packMs: stats(workerStats.packMs),
          renderMs: stats(workerStats.renderMs),
          posts: workerStats.posts,
          rafInterval: (() => {
            const iv = [];
            for (let i = 1; i < workerStats.frameTs.length; i++) {
              iv.push(workerStats.frameTs[i] - workerStats.frameTs[i - 1]);
            }
            return stats(iv);
          })(),
        }
      : null,
  };
};

/** Deterministic prefix feed plus one frame, for the correctness controls. */
window.feedAndSnap = async (bytes) => {
  const c = current;
  if (c instanceof WorkerContender) {
    await c.feedFixed(bytes);
    const px = await c.renderAndHash(0);
    const ck = await c.checksum(0);
    return { checksum: ck, pixels: px };
  }
  let fed = 0;
  while (fed < bytes) {
    fed += await c.feedRound();
    await macrotask();
  }
  const px = await c.renderAndHash(0);
  return { checksum: c.checksum ? c.checksum(0) : null, pixels: px };
};

window.glInfo = () => {
  const cv = document.createElement('canvas');
  const gl = cv.getContext('webgl2');
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: gl.getParameter(d.UNMASKED_RENDERER_WEBGL),
    vendor: gl.getParameter(d.UNMASKED_VENDOR_WEBGL),
    version: gl.getParameter(gl.VERSION),
  };
};

window.__ready = true;
