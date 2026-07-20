// Server + headed-Chromium launcher + the two guards that decide whether a run
// is allowed to report anything at all.
//
// Guard 1: the WebGL unmasked renderer must name NVIDIA and must not name a
// software rasteriser. Every prior measurement in this family silently ran on
// SwiftShader, which is exactly the failure this exists to catch.
// Guard 2: requestAnimationFrame must reach ~60 callbacks in a second. A window
// the compositor thinks is occluded gets throttled to about 1 Hz, which would
// turn every frame-delivery number into fiction.

import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, extname } from 'node:path';
import { execSync } from 'node:child_process';
import { chromium } from '/home/gaurav/dev/webterm/node_modules/playwright/index.mjs';

export const ROOT = '/home/gaurav/.cache/gpubench';
const NM = '/home/gaurav/dev/webterm/node_modules';
const STREAMS = '/home/gaurav/dev/webterm/scripts/vtbench/streams';
const WS = '99';

const TYPES = {
  '.html': 'text/html',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
};

export async function serve() {
  const extra = {
    '/xterm.mjs': join(NM, '@xterm/xterm/lib/xterm.mjs'),
    '/addon-webgl.mjs': join(NM, '@xterm/addon-webgl/lib/addon-webgl.mjs'),
    '/xterm.css': join(NM, '@xterm/xterm/css/xterm.css'),
  };
  const server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    const send = (buf, type) => {
      res.writeHead(200, {
        'content-type': type,
        // Cross-origin isolation, so SharedArrayBuffer and a precise
        // performance.now() are available if a contender wants them.
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
      });
      res.end(buf);
    };
    if (url.startsWith('/stream/')) {
      const p = join(STREAMS, url.slice(8) + '.raw.gz');
      if (existsSync(p)) return send(gunzipSync(readFileSync(p)), 'application/octet-stream');
    }
    if (extra[url]) return send(readFileSync(extra[url]), TYPES[extname(extra[url])] ?? 'text/plain');
    const p = join(ROOT, url === '/' ? 'page.html' : url.replace(/^\//, ''));
    if (existsSync(p) && !p.includes('..')) {
      return send(readFileSync(p), TYPES[extname(p)] ?? 'application/octet-stream');
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

function hypr(cmd) {
  return execSync(`hyprctl ${cmd}`, { encoding: 'utf8' });
}

/** Move anything we launched onto the headless output, never the user's. */
export function park() {
  const clients = JSON.parse(hypr('clients -j'));
  const mine = clients.filter((c) => c.class === 'vtbench' || c.initialClass === 'vtbench');
  for (const c of mine) {
    if (c.workspace?.name !== WS) hypr(`dispatch movetoworkspacesilent ${WS},address:${c.address}`);
  }
  return mine.length;
}

/**
 * Park, and keep parking. A window that has not mapped yet cannot be moved, and
 * one that appears on a visible workspace mid-run is the failure the owner
 * explicitly ruled out, so this polls rather than firing once and hoping.
 */
export async function parkUntilFound(timeoutMs = 8000) {
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < timeoutMs) {
    n = park();
    if (n > 0) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const check = setInterval(park, 500);
  check.unref?.();
  return { count: n, stop: () => clearInterval(check) };
}

/** Assert nothing of ours is sitting on a workspace the user can see. */
export function assertParked() {
  const stray = JSON.parse(hypr('clients -j'))
    .filter((c) => c.class === 'vtbench' || c.initialClass === 'vtbench')
    .filter((c) => c.workspace?.name !== WS);
  if (stray.length) {
    for (const c of stray) hypr(`dispatch movetoworkspacesilent ${WS},address:${c.address}`);
    return stray.map((c) => c.workspace?.name);
  }
  return [];
}

export async function launch() {
  // /tmp on this machine is a 16 GB tmpfs that runs full. Chromium's temporary
  // profile and Playwright's artifact directory both live there by default, and
  // a full tmpfs does not fail loudly: it stalls, which showed up as a run that
  // got steadily slower until each measurement took minutes. Keep both on disk.
  const tmp = `${ROOT}/tmp`;
  mkdirSync(tmp, { recursive: true });
  process.env.TMPDIR = tmp;

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--class=vtbench',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-features=CalculateNativeWinOcclusion',
      '--enable-gpu-rasterization',
      '--ignore-gpu-blocklist',
    ],
  });
  return browser;
}

export async function verifyGpu(page) {
  const r = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    const d = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'no webgl2';
    const t0 = performance.now();
    let frames = 0;
    await new Promise((res) => {
      const tick = () => {
        frames++;
        if (performance.now() - t0 >= 1000) res();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return {
      renderer,
      version: gl ? gl.getParameter(gl.VERSION) : '',
      fps: frames,
      isolated: globalThis.crossOriginIsolated === true,
      sab: typeof SharedArrayBuffer !== 'undefined',
      timerRes: (() => {
        // Smallest non-zero performance.now() delta observed, which tells us
        // whether we are on the 100 us coarse clock or the fine one.
        let m = Infinity;
        for (let i = 0; i < 200000; i++) {
          const a = performance.now();
          const b = performance.now();
          if (b > a && b - a < m) m = b - a;
        }
        return m;
      })(),
    };
  });
  const bad = /swiftshader|llvmpipe|software/i.test(r.renderer) || !/NVIDIA/i.test(r.renderer);
  if (bad) throw new Error(`GPU GUARD FAILED: renderer is "${r.renderer}"`);
  if (r.fps < 55) throw new Error(`RAF GUARD FAILED: only ${r.fps} frames in 1s`);
  return r;
}

export function chromiumVersionInfo(browser) {
  return browser.version();
}

/** Sum utime+stime over every chromium process, in seconds. Metric 5. */
export function chromiumCpuSeconds() {
  const hz = 100;
  let total = 0;
  const per = {};
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const name = stat.slice(stat.indexOf('(') + 1, close);
      if (!/chrom/i.test(name)) continue;
      const f = stat.slice(close + 2).split(' ');
      const secs = (Number(f[11]) + Number(f[12])) / hz;
      let type = 'other';
      try {
        const cl = readFileSync(`/proc/${d}/cmdline`, 'utf8');
        const m = cl.match(/--type=([a-z-]+)/);
        type = m ? m[1] : 'browser';
      } catch {
        /* process exited between readdir and read; skip its label only */
      }
      per[type] = (per[type] ?? 0) + secs;
      total += secs;
    } catch {
      /* processes come and go; a missing one contributes nothing */
    }
  }
  return { total, per };
}
