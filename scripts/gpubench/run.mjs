// The run. Correctness controls first, then the timed scenarios.
//
//   node run.mjs [--ms 5000] [--only c1,c3] [--json out.json] [--skip-verify]

import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { serve, launch, parkUntilFound, assertParked, verifyGpu, chromiumCpuSeconds } from './launch.mjs';
import { startTrace, endTrace, analyze, mainThread, workerThreads } from './trace.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => {
    const k = a.replace(/^--/, '');
    const n = all[i + 1];
    return [k, n && !n.startsWith('--') ? n : true];
  }),
);
const MS = Number(args.ms ?? 5000);
const ONLY = args.only ? String(args.only).split(',') : ['c1', 'c2', 'c3', 'c4', 'c5'];
const STREAM = String(args.stream ?? 'btop-200x55');
const REPS = Number(args.reps ?? 1);

const results = { meta: {}, verify: null, scenarios: [] };

const { server, port } = await serve();
const browser = await launch();
const parking = await parkUntilFound();
const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.stack ?? e.message));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || /error|fail/i.test(t)) console.error('[page]', t);
});

await page.goto(`http://127.0.0.1:${port}/`);
await parkUntilFound();
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });

const gpu = await verifyGpu(page);
console.log('GPU guard:', gpu.renderer, `| ${gpu.fps} rAF/s | isolated=${gpu.isolated} | clock ${gpu.timerRes.toFixed(4)} ms`);
results.meta.gpu = gpu;
results.meta.chromium = browser.version();
results.meta.node = process.version;
results.meta.stream = STREAM;
try {
  results.meta.driver = execSync('nvidia-smi --query-gpu=name,driver_version --format=csv,noheader', {
    encoding: 'utf8',
  }).trim();
} catch {
  results.meta.driver = 'nvidia-smi unavailable';
}
try {
  results.meta.governor = execSync(
    'cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor | sort | uniq -c',
    { encoding: 'utf8' },
  ).trim();
} catch {
  results.meta.governor = 'unknown';
}
results.meta.loadavg = execSync('cat /proc/loadavg', { encoding: 'utf8' }).trim();

const cdp = await page.context().newCDPSession(page);

const cfg1 = { cols: 200, rows: 55, panes: 1, streamUrl: `/stream/${STREAM}` };
const cfg8 = { cols: 100, rows: 27, panes: 8, streamUrl: `/stream/${STREAM}` };

// ---------------------------------------------------------------------------
// correctness controls
// ---------------------------------------------------------------------------

if (!args['skip-verify']) {
  console.log('\n=== correctness controls (identical input, 2 MiB prefix) ===');
  const v = {};
  for (const c of ONLY) {
    const setup = await page.evaluate(([w, o]) => window.setup(w, o), [c, cfg1]);
    assertParked();
    const snap = await page.evaluate((b) => window.feedAndSnap(b), 2 * 1024 * 1024);
    v[c] = { ...snap, proof: setup.proof };
    console.log(
      `  ${c.padEnd(3)} cellsum=${snap.checksum ?? '-'} pixhash=${snap.pixels?.hash} ` +
        `${snap.pixels?.w}x${snap.pixels?.h} colors=${snap.pixels?.distinctColors} ` +
        `nonbg=${(snap.pixels?.nonBgFraction * 100).toFixed(1)}%`,
    );
  }
  results.verify = v;

  const candidates = ONLY.filter((c) => c !== 'c1');
  const cs = candidates.map((c) => v[c]?.checksum).filter((x) => x != null);
  const px = candidates.map((c) => v[c]?.pixels?.hash).filter((x) => x != null);
  const same = (a) => a.every((x) => x === a[0]);
  results.verify.candidateCellsAgree = cs.length > 1 ? same(cs) : null;
  results.verify.candidatePixelsAgree = px.length > 1 ? same(px) : null;
  // A pass over a blank frame proves nothing, so require content before the
  // agreement is allowed to count for anything.
  results.verify.frameHasContent = candidates.every(
    (c) => (v[c]?.pixels?.distinctColors ?? 0) > 50 && (v[c]?.pixels?.nonBgFraction ?? 0) > 0.01,
  );
  console.log(
    `  candidate cell buffers agree: ${results.verify.candidateCellsAgree}, ` +
      `pixels agree: ${results.verify.candidatePixelsAgree}, frames non-blank: ${results.verify.frameHasContent}`,
  );

  // Negative control: the same comparison over a different input must fail.
  // Without this, "all hashes equal" is consistent with hashing nothing.
  const alt = await page.evaluate(([w, o]) => window.setup(w, o), ['c2', { ...cfg1, streamUrl: '/stream/vim-200x55' }]);
  void alt;
  const altSnap = await page.evaluate((b) => window.feedAndSnap(b), 2 * 1024 * 1024);
  results.verify.negativeControl = {
    differentStreamChecksum: altSnap.checksum,
    differsFromC2: altSnap.checksum !== v.c2?.checksum,
    differentPixelHash: altSnap.pixels?.hash !== v.c2?.pixels?.hash,
  };
  console.log(
    `  negative control (different stream through c2): cells differ=${results.verify.negativeControl.differsFromC2}, ` +
      `pixels differ=${results.verify.negativeControl.differentPixelHash}`,
  );
}

// ---------------------------------------------------------------------------
// timed scenarios
// ---------------------------------------------------------------------------

async function scenario(label, cfg, contenders, opts) {
  console.log(`\n=== ${label} ===`);
  const hdr =
    'id'.padEnd(4) +
    'main busy ms/s'.padStart(15) +
    'longtask'.padStart(10) +
    'lt p95'.padStart(9) +
    'rAF fps'.padStart(9) +
    'key p50'.padStart(9) +
    'key p95'.padStart(9) +
    'MiB/s'.padStart(9) +
    'cpu s'.padStart(8);
  console.log(hdr);
  console.log('-'.repeat(hdr.length));

  for (const c of contenders) {
   for (let rep = 0; rep < REPS; rep++) {
    let row;
    try {
      await page.evaluate(([w, o]) => window.setup(w, o), [c, cfg]);
      assertParked();
      // Warm the atlas, the shaders and the wasm before anything is timed.
      await page.evaluate((o) => window.runFlood(o), { ms: 1200, ...opts });

      const cpu0 = chromiumCpuSeconds();
      let events = null;
      let traceErr = null;
      try {
        await startTrace(cdp);
      } catch (e) {
        traceErr = String(e.message ?? e);
      }
      const r = await page.evaluate((o) => window.runFlood(o), { ms: MS, ...opts });
      if (!traceErr) {
        try {
          events = await endTrace(cdp);
        } catch (e) {
          // A failed trace read must not be reported as a contender failure,
          // and must not silently become a zero.
          traceErr = String(e.message ?? e);
        }
      }
      const cpu1 = chromiumCpuSeconds();

      const a = events ? analyze(events) : { spanMs: 0, threads: [] };
      const mt = mainThread(a);
      const wt = workerThreads(a);
      const secs = r.elapsedMs / 1000;
      row = {
        contender: c,
        rep,
        scenario: label,
        ...r,
        trace: {
          error: traceErr,
          spanMs: a.spanMs,
          main: mt,
          workers: wt,
          mainBusyMsPerSec: mt ? (mt.busyMs / a.spanMs) * 1000 : null,
          workerBusyMsPerSec: wt.length ? (wt.reduce((s, t) => s + t.busyMs, 0) / a.spanMs) * 1000 : 0,
          gpuProcess: a.threads.filter((t) => /CrGpuMain|VizCompositor/.test(t.thread)),
        },
        cpu: {
          totalSeconds: cpu1.total - cpu0.total,
          perType: Object.fromEntries(
            Object.keys(cpu1.per).map((k) => [k, cpu1.per[k] - (cpu0.per[k] ?? 0)]),
          ),
          cpuPerSecond: (cpu1.total - cpu0.total) / secs,
        },
      };
      console.log(
        c.padEnd(4) +
          (row.trace.mainBusyMsPerSec?.toFixed(1) ?? '-').padStart(15) +
          String(mt?.longTasks ?? '-').padStart(10) +
          (mt?.longTaskP95Ms?.toFixed(0) ?? '-').padStart(9) +
          r.rafFps.toFixed(1).padStart(9) +
          (r.keyEchoMs?.p50?.toFixed(1) ?? '-').padStart(9) +
          (r.keyEchoMs?.p95?.toFixed(1) ?? '-').padStart(9) +
          r.mibPerSec.toFixed(1).padStart(9) +
          row.cpu.cpuPerSecond.toFixed(2).padStart(8),
      );
    } catch (e) {
      row = { contender: c, rep, scenario: label, error: String(e.message ?? e).split('\n')[0] };
      console.log(c.padEnd(4) + `  FAILED: ${row.error}`);
    }
    results.scenarios.push(row);
    // Flush after every repetition. An earlier attempt at this matrix was
    // killed by its own timeout with nothing written, which is a worse outcome
    // than partial data.
    writeFileSync(args.json ? String(args.json) : 'results.json', JSON.stringify(results, null, 2));
   }
  }
}

const RATE = Number(args.rate ?? 4);
// Selectable so a long matrix can be run in pieces rather than as one job that
// either finishes or leaves nothing behind.
const WANT = args.scenarios ? String(args.scenarios).split(',') : ['f1', 'm1', 'f8', 'm8'];
const want = (k) => WANT.includes(k);
if (want('f1')) await scenario('flood-1pane-200x55', cfg1, ONLY, { keyIntervalMs: 250 });
if (want('m1')) {
  await scenario(`matched-${RATE}MiBs-1pane-200x55`, cfg1, ONLY, { keyIntervalMs: 250, targetMiBs: RATE });
}
if (want('f8')) await scenario('flood-8pane-100x27', cfg8, ONLY, { keyIntervalMs: 250 });
if (want('m8')) {
  await scenario(`matched-${RATE}MiBs-8pane-100x27`, cfg8, ONLY, { keyIntervalMs: 250, targetMiBs: RATE });
}

const stray = assertParked();
if (stray.length) console.error('WARNING: windows had escaped to', stray);

parking.stop();
await browser.close();
server.close();

const out = args.json ? String(args.json) : 'results.json';
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`\nwrote ${out}`);
