// The engine worker. It owns the wasm module (libghostty-vt plus the frame
// builder) and the OffscreenCanvas. Per frame it asks wasm to build the
// instance buffer, rasterizes the few glyphs wasm has not seen before into
// the atlas, uploads the dirty row ranges straight out of wasm memory, and
// issues one instanced draw. No cell ever becomes a JS object.

import { KEYS } from './keys.js';
import { openTransport } from './transport.js';

const ATLAS_W = 2048, ATLAS_H = 1024;
const F_DRAW = 1, F_ATLAS_RESET = 2, F_HELD = 4;
const HOLD_LIMIT_MS = 1000;
const ACK_BYTES = 256 * 1024;
const FRAME_MS = 16;
// Inside one large batch the screen is still mid-flood: 30 fps keeps it
// moving and leaves more of the thread to the parser.
const FLOOD_FRAME_MS = 33;
const WARM_PASSES = 12;

let x; // wasm exports
let e = 0; // engine pointer
let cols = 0, rows = 0, cw = 0, ch = 0, baseline = 0, dpr = 1;
let gl, prog, vao, instBuf, atlasTex, flagTex, uni = {};
let stageCtx, spr = 0, slotRows = 0;
let fontFamily = 'monospace', fontPx = 14;
let lastDraw = 0;
let conn = null, net = null, readOnly = false, observe = false, pingTimer = 0;
const encoder = new TextEncoder();
let scheduled = false, rafId = 0, renders = 0, heldSince = 0;
const frameMs = [];
const T = { warmMs: 0, bytes: 0, writeMs: 0, drawMs: 0, rasterMs: 0, msgs: 0, misses: 0 };
const raf = self.requestAnimationFrame ? (f) => self.requestAnimationFrame(f) : (f) => setTimeout(() => f(performance.now()), 16);
const decoder = new TextDecoder();

const u8 = () => new Uint8Array(x.memory.buffer);
const u32 = () => new Uint32Array(x.memory.buffer);

const VS = `#version 300 es
layout(location=0) in uint a_glyph;
layout(location=1) in uint a_fg;
layout(location=2) in uint a_bg;
uniform vec2 u_cell;
uniform vec2 u_view;
uniform int u_cols;
uniform ivec4 u_cursor; // x, y, visible, style
uniform vec3 u_curColor;
flat out uint v_glyph;
flat out vec3 v_fg;
flat out vec3 v_bg;
flat out int v_cursor;
out vec2 v_local;
vec3 unpack(uint c) { return vec3(float(c & 255u), float((c >> 8) & 255u), float((c >> 16) & 255u)) / 255.0; }
void main() {
  int col = gl_InstanceID % u_cols;
  int row = gl_InstanceID / u_cols;
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  float w = (a_glyph & (1u << 21)) != 0u ? 0.0 : ((a_glyph & (1u << 20)) != 0u ? 2.0 : 1.0);
  vec2 size = vec2(w, 1.0) * u_cell;
  vec2 px = vec2(float(col), float(row)) * u_cell + corner * size;
  v_local = corner * size;
  v_glyph = a_glyph;
  v_fg = unpack(a_fg);
  v_bg = unpack(a_bg);
  v_cursor = (u_cursor.z != 0 && col == u_cursor.x && row == u_cursor.y) ? u_cursor.w + 1 : 0;
  vec2 ndc = px / u_view * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_atlas;
uniform highp usampler2D u_flags;
uniform vec2 u_cell;
uniform int u_spr;
uniform vec3 u_curColor;
uniform float u_ulY;
uniform float u_ulH;
flat in uint v_glyph;
flat in vec3 v_fg;
flat in vec3 v_bg;
flat in int v_cursor;
in vec2 v_local;
out vec4 o;
void main() {
  vec3 fg = v_fg, bg = v_bg;
  // cursor styles from GhosttyRenderStateCursorVisualStyle: 0 bar, 1 block, 2 underline, 3 hollow
  if (v_cursor == 2) { vec3 t = fg; fg = bg; bg = u_curColor; }
  vec3 c = bg;
  uint slot = v_glyph & 0xFFFFFu;
  if (slot != 0u) {
    ivec2 sp = ivec2(int(slot) % u_spr, int(slot) / u_spr);
    ivec2 tp = sp * ivec2(u_cell) + ivec2(v_local);
    vec4 t = texelFetch(u_atlas, tp, 0);
    uint color = texelFetch(u_flags, sp, 0).r;
    float a = t.a;
    if ((v_glyph & (1u << 27)) != 0u) a *= 0.5;
    c = color != 0u ? mix(bg, t.rgb, a) : mix(bg, fg, a);
  }
  float y = v_local.y, xx = v_local.x;
  uint ul = (v_glyph >> 22) & 7u;
  if (ul != 0u && y >= u_ulY && y < u_ulY + u_ulH) c = fg;
  if (ul == 2u && y >= u_ulY + 2.0 * u_ulH && y < u_ulY + 3.0 * u_ulH) c = fg;
  if ((v_glyph & (1u << 25)) != 0u && abs(y - u_cell.y * 0.5) < u_ulH * 0.5 + 0.01) c = fg;
  if ((v_glyph & (1u << 26)) != 0u && y < u_ulH) c = fg;
  if (v_cursor == 1 && xx < 2.0) c = u_curColor;
  if (v_cursor == 3 && y >= u_cell.y - 2.0) c = u_curColor;
  if (v_cursor == 4 && (xx < 1.0 || y < 1.0 || y >= u_cell.y - 1.0 || xx >= u_cell.x - 1.0)) c = u_curColor;
  o = vec4(c, 1.0);
}`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function fontString(style) {
  return `${style & 2 ? 'italic ' : ''}${style & 1 ? 'bold ' : ''}${fontPx}px "${fontFamily}", monospace`;
}

function measure() {
  const c = new OffscreenCanvas(64, 64).getContext('2d');
  c.font = fontString(0);
  const m = c.measureText('M');
  const asc = m.fontBoundingBoxAscent ?? fontPx * 0.8;
  const desc = m.fontBoundingBoxDescent ?? fontPx * 0.2;
  cw = Math.max(1, Math.round(m.width));
  ch = Math.max(1, Math.round(asc + desc));
  baseline = Math.round(asc);
}

function setupGL(canvas) {
  gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  if (!gl) throw new Error('WebGL2 is not available in the worker');
  prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  for (const n of ['u_cell', 'u_view', 'u_cols', 'u_cursor', 'u_curColor', 'u_atlas', 'u_flags', 'u_spr', 'u_ulY', 'u_ulH']) uni[n] = gl.getUniformLocation(prog, n);
  vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  instBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  gl.bufferData(gl.ARRAY_BUFFER, cols * rows * 12, gl.DYNAMIC_DRAW);
  for (let i = 0; i < 3; i++) {
    gl.enableVertexAttribArray(i);
    gl.vertexAttribIPointer(i, 1, gl.UNSIGNED_INT, 12, i * 4);
    gl.vertexAttribDivisor(i, 1);
  }
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  atlasTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, ATLAS_W, ATLAS_H);
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  flagTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, flagTex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, spr, slotRows);
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  clearAtlas();
  gl.uniform1i(uni.u_atlas, 0);
  gl.uniform1i(uni.u_flags, 1);
  gl.uniform2f(uni.u_cell, cw, ch);
  gl.uniform2f(uni.u_view, cols * cw, rows * ch);
  gl.uniform1i(uni.u_cols, cols);
  gl.uniform1i(uni.u_spr, spr);
  const ulH = Math.max(1, Math.round(dpr));
  gl.uniform1f(uni.u_ulY, Math.min(ch - ulH, baseline + ulH));
  gl.uniform1f(uni.u_ulH, ulH);
  gl.viewport(0, 0, cols * cw, rows * ch);
}

function clearAtlas() {
  // Glyph pixels need no clearing: every raster uploads its whole slot.
  gl.activeTexture(gl.TEXTURE1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, spr, slotRows, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(spr * slotRows));
}

// Rasterize the glyphs wasm reported as new this frame. Each one already
// has a slot; this draws it on a two-cell staging canvas and uploads that
// rectangle into the slot. The browser's own font fallback picks a system
// font for anything the web font lacks (CJK, emoji, Arabic, Devanagari).
const STAGE_COLS = 32, STAGE_ROWS = 8; // glyphs per staging batch: 32 x 8, two cells each

function raster(n) {
  const mem = u8();
  const miss = new Uint32Array(x.memory.buffer, x.eng_miss(e), n * 3);
  const arena = x.eng_arena(e);
  const ctx = stageCtx;
  const sw = STAGE_COLS * 2 * cw, per = STAGE_COLS * STAGE_ROWS;
  let font = '';
  const flags = new Uint8Array(1);
  for (let base = 0; base < n; base += per) {
    // Draw up to 256 glyphs on the staging canvas, read it back once,
    // then upload each glyph's rectangle out of that one buffer.
    const count = Math.min(per, n - base);
    const usedRows = Math.ceil(count / STAGE_COLS);
    ctx.clearRect(0, 0, sw, usedRows * ch);
    for (let k = 0; k < count; k++) {
      const i = base + k;
      const off = miss[i * 3 + 1], meta = miss[i * 3 + 2];
      const len = meta & 0xffff, style = meta >>> 24;
      const f = fontString(style);
      if (f !== font) { ctx.font = f; font = f; }
      ctx.save();
      ctx.beginPath();
      ctx.rect((k % STAGE_COLS) * 2 * cw, Math.floor(k / STAGE_COLS) * ch, 2 * cw, ch);
      ctx.clip();
      ctx.fillText(decoder.decode(mem.subarray(arena + off, arena + off + len)), (k % STAGE_COLS) * 2 * cw, Math.floor(k / STAGE_COLS) * ch + baseline);
      ctx.restore();
    }
    const d = ctx.getImageData(0, 0, sw, usedRows * ch).data;
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, sw);
    for (let k = 0; k < count; k++) {
      const i = base + k;
      const slot = miss[i * 3], width = (miss[i * 3 + 2] >>> 16) & 0xff;
      const w = cw * width, sx = (k % STAGE_COLS) * 2 * cw, sy = Math.floor(k / STAGE_COLS) * ch;
      gl.activeTexture(gl.TEXTURE0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, sx);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, sy);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, (slot % spr) * cw, Math.floor(slot / spr) * ch, w, ch, gl.RGBA, gl.UNSIGNED_BYTE, d);
      // A glyph is "colour" when a covered pixel is not white: emoji keep
      // their own colours, everything else is tinted by the cell foreground.
      let color = 0;
      for (let yy = 0; yy < ch && !color; yy++) {
        for (let p = ((sy + yy) * sw + sx) * 4, q = p + w * 4; p < q; p += 4) {
          if (d[p + 3] > 40 && (Math.abs(d[p] - d[p + 1]) > 24 || Math.abs(d[p + 1] - d[p + 2]) > 24 || d[p] < 180)) { color = 1; break; }
        }
      }
      if (color) {
        flags[0] = 1;
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, slot % spr, Math.floor(slot / spr), 1, 1, gl.RED_INTEGER, gl.UNSIGNED_BYTE, flags);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, sw);
      }
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  }
}

function draw(force) {
  const t0 = performance.now();
  const f = x.eng_frame(e, force ? 1 : 0);
  if (f & F_HELD) {
    if (!heldSince) heldSince = t0;
    else if (t0 - heldSince > HOLD_LIMIT_MS) { x.eng_release_hold(e); heldSince = 0; schedule(); }
  } else heldSince = 0;
  if (f & F_ATLAS_RESET) clearAtlas();
  const n = x.eng_miss_n(e);
  if (n) { const tr = performance.now(); raster(n); T.rasterMs += performance.now() - tr; T.misses += n; }
  if (!(f & F_DRAW) && !force) return false;
  // Upload dirty row ranges directly from wasm memory: one bufferSubData
  // per contiguous run, no intermediate copy.
  const mem = u8();
  const dirty = x.eng_row_dirty(e), inst = x.eng_inst(e), rowBytes = cols * 12;
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  for (let y = 0; y < rows; ) {
    if (!mem[dirty + y]) { y++; continue; }
    let y1 = y;
    while (y1 < rows && mem[dirty + y1]) y1++;
    gl.bufferSubData(gl.ARRAY_BUFFER, y * rowBytes, mem, inst + y * rowBytes, (y1 - y) * rowBytes);
    y = y1;
  }
  const cur = new Uint32Array(x.memory.buffer, x.eng_cursor(e), 6);
  gl.uniform4i(uni.u_cursor, cur[0], cur[1], cur[2], cur[3]);
  const col = new Uint32Array(x.memory.buffer, x.eng_colors(e), 3)[2];
  gl.uniform3f(uni.u_curColor, (col & 255) / 255, ((col >> 8) & 255) / 255, ((col >> 16) & 255) / 255);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, cols * rows);
  renders++;
  lastDraw = performance.now();
  if (observe) self.postMessage({ type: 'frame', n: renders, t: performance.timeOrigin + lastDraw, cx: cur[0], cy: cur[1] });
  const dt = performance.now() - t0;
  T.drawMs += dt;
  frameMs.push(dt);
  if (frameMs.length > 4096) frameMs.splice(0, 2048);
  return true;
}

function schedule() {
  if (scheduled || !e) return;
  scheduled = true;
  rafId = raf(() => {
    scheduled = false;
    draw(false);
    if (heldSince) schedule();
  });
}

function writeBytes(bytes) {
  const tw = performance.now();
  T.msgs++;
  T.bytes += bytes.length;
  // Parse in slices of at most 256 KiB and draw between slices when a frame
  // is overdue, so one large batch cannot hold the screen still.
  const cap = Math.min(x.eng_input_cap(), 256 * 1024);
  const inPtr = x.eng_input(e);
  let drawMs = 0;
  for (let off = 0; off < bytes.length; off += cap) {
    const n = Math.min(cap, bytes.length - off);
    u8().set(bytes.subarray(off, off + n), inPtr);
    x.eng_write_input(e, n);
    if (off + n < bytes.length && performance.now() - lastDraw > FLOOD_FRAME_MS) {
      const d0 = performance.now();
      flushOut();
      draw(false);
      drawMs += performance.now() - d0;
    }
  }
  T.writeMs += performance.now() - tw - drawMs;
}

// Two warm-ups before "ready", both cheap and both paid once:
//  - rasterize printable ASCII (regular and bold) into the atlas;
//  - run a short synthetic stream through the terminal so V8 has compiled
//    the parser's hot functions with its optimizing tier before real output
//    arrives. Without it the first MiB parses about 2x slower.
// The stream only addresses rows that already exist (CUP, no newlines), so
// it allocates no scrollback pages, and a full reset follows. A scratch
// terminal cost 6 MiB of wasm memory that the idle page kept.
function warmUp() {
  const n = x.eng_warm_ascii(e);
  if (n) raster(n);
  let t = '';
  // Mix the sequences real output leans on: sync output, CUP, SGR with
  // 256 and 24-bit colours, wide text, box drawing and plain runs.
  for (let i = 0; i < 300; i++) {
    if (i % rows === 0) t += '\x1b[?2026h';
    t += `\x1b[${1 + (i % rows)};1H\x1b[38;2;${i & 255};${(i * 7) & 255};90;48;2;${(i * 3) & 255};20;30m`;
    t += `w${i} \u2500\u2502 \u6f22\u5b57 \x1b[1;38;5;${i & 255}mbold\x1b[0m ${'abcdefghij'.repeat(Math.max(1, Math.floor(cols / 20)))}\x1b[K`;
    if (i % rows === rows - 1) t += '\x1b[?2026l';
  }
  t += '\x1b[?2026l\x1b[0m';
  const b = new TextEncoder().encode(t);
  const inPtr = x.eng_input(e), cap = x.eng_input_cap();
  for (let k = 0; k < WARM_PASSES; k++) {
    for (let o = 0; o < b.length; o += cap) {
      const len = Math.min(cap, b.length - o);
      u8().set(b.subarray(o, o + len), inPtr);
      x.eng_write_input(e, len);
    }
  }
  x.eng_reset(e);
}

function warmFallbackFonts() {
  const c = new OffscreenCanvas(4 * fontPx, 2 * fontPx).getContext('2d');
  for (const style of [0, 1]) {
    c.font = fontString(style);
    for (const t of ['\u{1F642}', '\u{1F1EF}\u{1F1F5}', '\u2800\u28FF', '\u6F22\uD55C', '\u0645\u0928']) c.fillText(t, 0, fontPx);
  }
}

async function loadFonts(fonts) {
  if (!fonts?.length || !self.FontFace) return;
  await Promise.all(fonts.map(async (f) => {
    const face = new FontFace(fontFamily, `url(${f.url})`, { weight: f.weight ?? '400', style: f.style ?? 'normal' });
    await face.load();
    self.fonts.add(face);
  }));
}

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((p1, p2) => p1 - p2); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3); };

// Send whatever the engine queued for the PTY: encoded keys, mouse
// reports, pastes and the terminal's own replies (DA, DSR, ...). With a
// connection the bytes go straight to the socket; without one they go to
// the page, which forwards them itself.
function flushOut() {
  const n = x.eng_out_len(e);
  if (!n) return;
  const p = x.eng_out(e);
  const bytes = u8().slice(p, p + n);
  x.eng_out_clear(e);
  if (readOnly) return;
  if (net) net.postMessage({ type: 'input', bytes }, [bytes.buffer]);
  else if (conn) conn.input(bytes);
  else self.postMessage({ type: 'data', bytes }, [bytes.buffer]);
}

// After output was parsed: replies out, and a frame if one is overdue.
function afterOutput() {
  flushOut();
  if (performance.now() - lastDraw > FRAME_MS) {
    if (scheduled) { (self.cancelAnimationFrame || clearTimeout)(rafId); scheduled = false; }
    draw(false);
  } else schedule();
}

// Stage text in the engine's input buffer and return its byte length.
function stage(text) {
  if (!text) return 0;
  const b = encoder.encode(text);
  const n = Math.min(b.length, x.eng_input_cap());
  u8().set(b.subarray(0, n), x.eng_input(e));
  return n;
}

function resizeGrid(c, r) {
  if (x.eng_resize(e, c, r)) return false;
  cols = c; rows = r;
  gl.canvas.width = cols * cw;
  gl.canvas.height = rows * ch;
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  gl.bufferData(gl.ARRAY_BUFFER, cols * rows * 12, gl.DYNAMIC_DRAW);
  gl.uniform2f(uni.u_view, cols * cw, rows * ch);
  gl.uniform1i(uni.u_cols, cols);
  gl.viewport(0, 0, cols * cw, rows * ch);
  draw(true);
  conn?.resize(cols, rows, cols * cw, rows * ch);
  net?.postMessage({ type: 'resize', cols, rows, widthPx: cols * cw, heightPx: rows * ch });
  return true;
}

self.onmessage = async ({ data: m }) => {
  try {
    switch (m.type) {
      case 'init': {
        ({ cols, rows } = m);
        dpr = m.dpr || 1;
        fontFamily = m.fontFamily || 'monospace';
        fontPx = Math.round((m.fontSize || 14) * dpr);
        await loadFonts(m.fonts);
        measure();
        const loading = WebAssembly.instantiateStreaming(fetch(m.wasmUrl), {});
        // The first glyph that needs a system fallback font (emoji, CJK,
        // braille) costs about 10 ms while the browser loads that font.
        // Pay it here, while wasm compiles on another thread, instead of in
        // the middle of the first burst of output.
        warmFallbackFonts();
        const res = await loading;
        x = res.instance.exports;
        e = x.eng_new(cols, rows, m.scrollback ?? 10000, cw, ch, ATLAS_W, ATLAS_H);
        if (!e) throw new Error('eng_new failed');
        const bad = x.eng_selftest(e);
        if (bad) throw new Error('cell layout self-test failed: ' + bad);
        if (m.theme) x.eng_theme(e, m.theme[0], m.theme[1], m.theme[2]);
        spr = x.eng_slots_per_row(e);
        slotRows = Math.floor(ATLAS_H / ch);
        stageCtx = new OffscreenCanvas(STAGE_COLS * 2 * cw, STAGE_ROWS * ch).getContext('2d', { willReadFrequently: true });
        stageCtx.fillStyle = '#fff';
        stageCtx.textBaseline = 'alphabetic';
        m.canvas.width = cols * cw;
        m.canvas.height = rows * ch;
        setupGL(m.canvas);
        const tw = performance.now();
        warmUp();
        T.warmMs = performance.now() - tw;
        draw(true);
        self.postMessage({ type: 'ready', cw, ch, renderer: 'worker-webgl2' });
        break;
      }
      case 'write': {
        // Acknowledge writes as their bytes are parsed, about every
        // 256 KiB, not once per batch. The sender refills its window while
        // the rest of the batch parses, so the worker never idles waiting
        // for the next message.
        let off = 0, from = 0, pending = 0;
        for (let i = 0; i < m.ids.length; i++) {
          const n = m.lens ? m.lens[i] : m.bytes.length;
          writeBytes(m.bytes.subarray(off, off + n));
          off += n;
          pending += n;
          if (pending >= ACK_BYTES && i + 1 < m.ids.length) {
            self.postMessage({ type: 'written', ids: m.ids.slice(from, i + 1) });
            from = i + 1;
            pending = 0;
          }
        }
        self.postMessage({ type: 'written', ids: m.ids.slice(from) });
        // A flood of write messages can keep the worker busy past its
        // animation frames. afterOutput draws when a frame is overdue, so
        // the screen keeps moving at about 60 fps however fast bytes arrive.
        afterOutput();
        break;
      }
      case 'connect': {
        // The socket lives here: PTY output goes from the network straight
        // into wasm, and input goes from wasm straight to the network.
        conn = openTransport(m.transport, {
          output: (bytes) => { writeBytes(bytes); afterOutput(); },
          title: (title) => self.postMessage({ type: 'title', title }),
          options: (o) => { readOnly = !!o.readOnly; self.postMessage({ type: 'options', options: o }); },
          closed: (err) => { clearInterval(pingTimer); self.postMessage({ type: 'closed', error: err ? String(err) : undefined }); },
          open: () => {
            conn.resize(cols, rows, cols * cw, rows * ch);
            if (m.transport.pingMs) pingTimer = setInterval(() => conn.ping(), m.transport.pingMs);
          },
        });
        await conn.ready;
        self.postMessage({ type: 'result', id: m.id, value: true });
        break;
      }
      case 'net': {
        // The socket lives in the network worker; this port carries its
        // output here and our input there.
        net = m.port;
        net.onmessage = ({ data: d }) => {
          if (d.type === 'output') { writeBytes(d.bytes); net.postMessage({ type: 'ack' }); afterOutput(); }
          else if (d.type === 'open') net.postMessage({ type: 'resize', cols, rows, widthPx: cols * cw, heightPx: rows * ch });
          else if (d.type === 'options') { readOnly = !!d.options.readOnly; self.postMessage(d); }
          else self.postMessage(d); // title, closed
        };
        break;
      }
      case 'key': {
        // A DOM key event. Ghostty's encoder applies the terminal's modes
        // (cursor keys, keypad, kitty keyboard flags, modifyOtherKeys).
        const n = stage(m.text);
        x.eng_key(e, KEYS[m.code] ?? 0, m.mods, m.action, n, m.unshifted || 0, m.composing ? 1 : 0);
        flushOut();
        schedule();
        break;
      }
      case 'text':
        x.eng_text(e, stage(m.text));
        flushOut();
        schedule();
        break;
      case 'paste':
        x.eng_paste(e, stage(m.text));
        flushOut();
        schedule();
        break;
      case 'focus':
        x.eng_focus(e, m.focused ? 1 : 0);
        flushOut();
        break;
      case 'mouse':
        // Coordinates in CSS pixels; the engine works in canvas pixels.
        x.eng_mouse(e, m.action, m.button, m.mods, m.x * dpr, m.y * dpr, m.pressed ? 1 : 0);
        flushOut();
        break;
      case 'wheel': {
        // Mouse reports when the program tracks the mouse, otherwise the
        // viewport scrolls through history.
        if (x.eng_mouse_tracking(e)) {
          const button = m.lines < 0 ? 4 : 5;
          for (let i = 0; i < Math.min(Math.abs(m.lines), 10); i++) x.eng_mouse(e, 0, button, m.mods, m.x * dpr, m.y * dpr, 0);
          flushOut();
        } else {
          x.eng_scroll(e, m.lines);
          schedule();
        }
        break;
      }
      case 'resize':
        self.postMessage({ type: 'result', id: m.id, value: resizeGrid(m.cols, m.rows) });
        break;
      case 'observe':
        observe = !!m.on;
        break;
      case 'scroll':
        x.eng_scroll(e, m.delta);
        schedule();
        break;
      case 'flush':
        if (scheduled) { (self.cancelAnimationFrame || clearTimeout)(rafId); scheduled = false; }
        draw(true);
        gl.finish();
        self.postMessage({ type: 'result', id: m.id, value: { renders } });
        break;
      case 'stats':
        self.postMessage({ type: 'result', id: m.id, value: { renders, frames: frameMs.length, renderP50Ms: pct(frameMs, 0.5), renderP99Ms: pct(frameMs, 0.99), ...T, mem: x.memory.buffer.byteLength } });
        break;
      case 'dump': {
        const p = m.kind === 'direct' ? x.eng_dump_direct(e) : x.eng_dump_render(e);
        const text = decoder.decode(u8().slice(p, p + x.eng_dump_len(e)));
        self.postMessage({ type: 'result', id: m.id, value: text });
        break;
      }
    }
  } catch (err) {
    self.postMessage({ type: m.id !== undefined ? 'result' : 'error', id: m.id, error: String(err && err.stack || err) });
  }
};
