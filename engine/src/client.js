// Main-thread side of the worker engine. It owns the DOM canvas and hands
// it to the worker, batches writes per microtask so a burst crosses the
// worker boundary once, and resolves each write() after its bytes are
// parsed. Rendering never touches this thread.

export class WorkerTerm {
  static async mount(host, opts = {}) {
    const t = new WorkerTerm(host, opts);
    await t.ready;
    return t;
  }

  constructor(host, opts) {
    this.opts = opts;
    this.cols = opts.cols ?? 80;
    this.rows = opts.rows ?? 24;
    this.dpr = opts.dpr ?? (self.devicePixelRatio || 1);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'wt-canvas';
    host.append(this.canvas);
    const off = this.canvas.transferControlToOffscreen();
    this.worker = new Worker(opts.workerUrl ?? new URL('./worker.js', import.meta.url), { type: 'module' });
    this.seq = 0;
    this.pending = new Map();
    this.batch = [];
    this.batchLen = 0;
    this.batchIds = [];
    this.flushQueued = false;
    this.renders = 0;
    this.worker.onmessage = ({ data: m }) => this.onMessage(m);
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.worker.postMessage({
      type: 'init', canvas: off, cols: this.cols, rows: this.rows, dpr: this.dpr,
      scrollback: opts.scrollback ?? 10000, fontFamily: opts.fontFamily, fontSize: opts.fontSize ?? 14,
      fonts: opts.fonts, theme: opts.theme, wasmUrl: String(opts.wasmUrl ?? new URL('../dist/engine.wasm', import.meta.url)),
    }, [off]);
  }

  onMessage(m) {
    if (m.type === 'ready') {
      this.cw = m.cw; this.ch = m.ch; this.renderer = m.renderer;
      this.canvas.style.width = `${(this.cols * m.cw) / this.dpr}px`;
      this.canvas.style.height = `${(this.rows * m.ch) / this.dpr}px`;
      this.readyResolve();
    } else if (m.type === 'written') {
      for (const id of m.ids) { const p = this.pending.get(id); this.pending.delete(id); p?.resolve(); }
    } else if (m.type === 'result') {
      const p = this.pending.get(m.id); this.pending.delete(m.id);
      if (m.error) p?.reject(new Error(m.error)); else p?.resolve(m.value);
    } else if (m.type === 'error') {
      if (this.readyReject) this.readyReject(new Error(m.error));
      console.error(m.error);
    }
  }

  request(msg) {
    const id = this.seq++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ ...msg, id }); });
  }

  /** Resolves after the bytes are parsed. flush() waits for the frame. */
  write(data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const id = this.seq++;
    this.batch.push(bytes);
    this.batchLen += bytes.length;
    this.batchIds.push(id);
    if (!this.flushQueued) { this.flushQueued = true; queueMicrotask(() => this.sendWrites()); }
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  sendWrites() {
    this.flushQueued = false;
    if (!this.batchIds.length) return;
    const out = new Uint8Array(this.batchLen);
    let o = 0;
    for (const b of this.batch) { out.set(b, o); o += b.length; }
    this.worker.postMessage({ type: 'write', bytes: out, ids: this.batchIds }, [out.buffer]);
    this.batch = []; this.batchLen = 0; this.batchIds = [];
  }

  async flush() {
    this.sendWrites();
    const r = await this.request({ type: 'flush' });
    this.renders = r.renders;
  }

  scroll(delta) { this.worker.postMessage({ type: 'scroll', delta }); }
  stats() { return this.request({ type: 'stats' }); }
  /** kind 'render' reads the instance buffer, 'direct' reads Ghostty's cells. */
  dump(kind = 'render') { this.sendWrites(); return this.request({ type: 'dump', kind }); }
  dispose() { this.worker.terminate(); this.canvas.remove(); }
}
