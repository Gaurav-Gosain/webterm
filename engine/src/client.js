// Main-thread side of the worker engine. It owns the DOM canvas and hands
// it to the worker, batches writes per microtask so a burst crosses the
// worker boundary once, and resolves each write() after its bytes are
// parsed. Rendering never touches this thread.

import { attachInput } from './input.js';

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
    this.tick = new MessageChannel();
    this.tick.port1.onmessage = () => this.sendWrites();
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
    if (m.type === 'data') { this.opts.onData?.(m.bytes); return; }
    if (m.type === 'frame') { this.opts.onFrame?.(m); return; }
    if (m.type === 'title') { this.opts.onTitle?.(m.title); return; }
    if (m.type === 'bell') { this.opts.onBell?.(); return; }
    if (m.type === 'search') { this.searchState = m; this.opts.onSearch?.(m); return; }
    if (m.type === 'hover') {
      this.hoveredLink = m.uri;
      this.canvas.style.cursor = m.uri ? 'pointer' : '';
      this.canvas.title = m.uri ?? '';
      this.opts.onLinkHover?.(m.uri);
      return;
    }
    if (m.type === 'openLink') {
      // The click that asked for it was a moment ago, so the page still has
      // user activation and the browser allows the new tab.
      if (this.opts.onLinkOpen) this.opts.onLinkOpen(m.uri);
      else { const w = window.open(m.uri, '_blank', 'noopener,noreferrer'); if (w) w.opener = null; }
      return;
    }
    if (m.type === 'cursor') { this.cursor = m; this.input?.cursor(m.x, m.y); return; }
    if (m.type === 'selection') {
      this.selection = m.text;
      this.input?.setSelection(m.text);
      if (m.copy) this.writeClipboard(m.text);
      this.opts.onSelection?.(m.text);
      return;
    }
    if (m.type === 'clipboard') {
      // OSC 52 from the program. sip's osc52gate filters it on the server
      // when the deployment says so; here it is only written.
      if (this.opts.onClipboard) this.opts.onClipboard(m.text, m.location);
      else if (m.location !== 'primary') this.writeClipboard(m.text);
      return;
    }
    if (m.type === 'options') { this.opts.onOptions?.(m.options); return; }
    if (m.type === 'closed') { this.opts.onClose?.(m.error); return; }
    if (m.type === 'ready') {
      this.cw = m.cw; this.ch = m.ch; this.renderer = m.renderer;
      this.canvas.style.width = `${(this.cols * m.cw) / this.dpr}px`;
      this.canvas.style.height = `${(this.rows * m.ch) / this.dpr}px`;
      if (this.opts.input !== false) this.input = attachInput(this.canvas.parentElement, this.canvas, (msg) => this.worker.postMessage(msg), { cell: () => ({ cw: this.cw / this.dpr, ch: this.ch / this.dpr }), onKey: this.opts.onKey, preeditStyle: { font: `${this.opts.fontSize ?? 14}px ${JSON.stringify(this.opts.fontFamily || 'monospace')}, monospace`, color: '#fff', background: 'rgba(0,0,0,0.8)' } });
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
    // Send at the end of the current task, not the current microtask: a
    // feeder that awaits each write wakes in its own microtask, and a
    // microtask flush would post one message per write.
    if (!this.flushQueued) { this.flushQueued = true; this.tick.port2.postMessage(0); }
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  sendWrites() {
    this.flushQueued = false;
    if (!this.batchIds.length) return;
    const out = new Uint8Array(this.batchLen);
    const lens = new Uint32Array(this.batch.length);
    let o = 0;
    this.batch.forEach((b, i) => { out.set(b, o); o += b.length; lens[i] = b.length; });
    this.worker.postMessage({ type: 'write', bytes: out, ids: this.batchIds, lens }, [out.buffer, lens.buffer]);
    this.batch = []; this.batchLen = 0; this.batchIds = [];
  }

  async flush() {
    this.sendWrites();
    const r = await this.request({ type: 'flush' });
    this.renders = r.renders;
  }

  /** Write text to the system clipboard; false if the browser refused. */
  async writeClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    // Insecure origin or no user gesture: the copy event path, which works
    // only during a user gesture but needs no permission.
    const prev = this.selection;
    this.input?.setSelection(text);
    try { return this.input?.copy() ?? false; } catch { return false; } finally { this.input?.setSelection(prev ?? ''); }
  }
  /**
   * Search the screen and scrollback (ASCII letters ignore case). Resolves
   * with { total, index, done } after the first step; onSearch gets each
   * later count while the search catches up. An empty needle closes it.
   */
  search(needle) { return this.request({ type: 'search', needle }); }
  /** Select the next older match ('next') or newer match ('prev'). */
  searchSelect(dir = 'next') { return this.request({ type: 'searchSelect', dir }); }
  selectAll() { this.worker.postMessage({ type: 'selectAll' }); }
  clearSelection() { this.worker.postMessage({ type: 'selectClear' }); }
  setCopyOnSelect(on) { this.worker.postMessage({ type: 'options', copyOnSelect: on }); }
  scroll(delta) { this.worker.postMessage({ type: 'scroll', delta }); }
  /**
   * Open the connection inside the worker. transport: { kind: 'websocket' |
   * 'webtransport', url, protocol: 'sip' | 'raw', options (WebTransport
   * constructor options, e.g. serverCertificateHashes), pingMs }.
   */
  connect(transport, { thread = 'net' } = {}) {
    if (thread === 'engine') return this.request({ type: 'connect', transport });
    // Default: a third thread owns the socket. Receiving a WebSocket message
    // costs about 0.3 ms per 64 KiB on the owning thread, so a separate
    // network worker lets receive and parse run in parallel.
    const ch = new MessageChannel();
    this.net = new Worker(this.opts.netWorkerUrl ?? new URL('./net-worker.js', import.meta.url), { type: 'module' });
    this.worker.postMessage({ type: 'net', port: ch.port1 }, [ch.port1]);
    return new Promise((resolve, reject) => {
      this.net.onmessage = ({ data: m }) => {
        if (m.type === 'result') return m.error ? reject(new Error(m.error)) : resolve(true);
        this.onMessage(m);
      };
      this.net.postMessage({ type: 'connect', transport, port: ch.port2 }, [ch.port2]);
    });
  }
  async resize(cols, rows) {
    const ok = await this.request({ type: 'resize', cols, rows });
    if (ok) {
      this.cols = cols; this.rows = rows;
      this.canvas.style.width = `${(cols * this.cw) / this.dpr}px`;
      this.canvas.style.height = `${(rows * this.ch) / this.dpr}px`;
    }
    return ok;
  }
  /** Ask the worker to report each drawn frame through onFrame. */
  observe(on = true) { this.worker.postMessage({ type: 'observe', on }); }
  focus() { this.input?.focus(); }
  stats() { return this.request({ type: 'stats' }); }
  /** kind 'render' reads the instance buffer, 'direct' reads Ghostty's cells. */
  dump(kind = 'render') { this.sendWrites(); return this.request({ type: 'dump', kind }); }
  dispose() { this.input?.detach(); this.net?.terminate(); this.worker.terminate(); this.canvas.remove(); }
}
