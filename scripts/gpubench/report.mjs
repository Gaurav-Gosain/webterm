// Turn results.json into the tables the report quotes. Nothing is computed
// here that is not in the JSON.
import { readFileSync } from 'node:fs';

const r = JSON.parse(readFileSync(process.argv[2] ?? 'results-full.json', 'utf8'));
const f = (x, d = 1) => (x == null || Number.isNaN(x) ? '-' : Number(x).toFixed(d));

console.log('machine/toolchain');
console.log(JSON.stringify(r.meta, null, 1));

console.log('\nverify');
for (const k of Object.keys(r.verify ?? {})) {
  const v = r.verify[k];
  if (typeof v !== 'object' || v === null) {
    console.log(` ${k}: ${v}`);
    continue;
  }
  if (v.pixels !== undefined || v.checksum !== undefined) {
    console.log(
      ` ${k}: cells=${v.checksum ?? '-'} px=${v.pixels?.hash ?? '-'} ${v.pixels?.w}x${v.pixels?.h} ` +
        `colors=${v.pixels?.distinctColors ?? '-'} nonbg=${f((v.pixels?.nonBgFraction ?? 0) * 100)}% ` +
        `proof=${JSON.stringify(v.proof ?? null)}`,
    );
  } else {
    console.log(` ${k}: ${JSON.stringify(v)}`);
  }
}

const scen = [...new Set(r.scenarios.map((s) => s.scenario))];
for (const sc of scen) {
  console.log(`\n### ${sc}`);
  const hdr =
    'id'.padEnd(4) +
    'mainBusy/s'.padStart(11) +
    'wkrBusy/s'.padStart(10) +
    'taskP95'.padStart(9) +
    'taskMax'.padStart(9) +
    'LT'.padStart(4) +
    'rAFfps'.padStart(8) +
    'iv p95'.padStart(8) +
    '>16.7'.padStart(7) +
    '>33'.padStart(6) +
    'key50'.padStart(8) +
    'key95'.padStart(8) +
    'evt50'.padStart(8) +
    'MiB/s'.padStart(8) +
    'cpu/s'.padStart(7) +
    'gpu ms/s'.padStart(9);
  console.log(hdr);
  console.log('-'.repeat(hdr.length));
  for (const s of r.scenarios.filter((x) => x.scenario === sc)) {
    if (s.error) {
      console.log(s.contender.padEnd(4) + '  ERROR: ' + s.error);
      continue;
    }
    const t = s.trace ?? {};
    const gpu = (t.gpuProcess ?? []).reduce((a, b) => a + b.busyMs, 0);
    console.log(
      s.contender.padEnd(4) +
        f(t.mainBusyMsPerSec).padStart(11) +
        f(t.workerBusyMsPerSec).padStart(10) +
        f(t.main?.taskP95Ms, 2).padStart(9) +
        f(t.main?.taskMaxMs, 1).padStart(9) +
        String(t.main?.longTasks ?? '-').padStart(4) +
        f(s.rafFps).padStart(8) +
        f(s.rafInterval?.p95).padStart(8) +
        String(s.longFrames?.over16_7 ?? '-').padStart(7) +
        String(s.longFrames?.over33 ?? '-').padStart(6) +
        f(s.keyEchoMs?.p50).padStart(8) +
        f(s.keyEchoMs?.p95).padStart(8) +
        f(s.eventTimingMs?.p50).padStart(8) +
        f(s.mibPerSec).padStart(8) +
        f(s.cpu?.cpuPerSecond, 2).padStart(7) +
        f(t.spanMs ? (gpu / t.spanMs) * 1000 : null).padStart(9),
    );
  }
}

console.log('\n### stage detail (ms per frame, p50/p95)');
for (const s of r.scenarios) {
  if (s.error) continue;
  const bits = [];
  if (s.packMs) bits.push(`pack ${f(s.packMs.p50, 2)}/${f(s.packMs.p95, 2)}`);
  if (s.adoptMs) bits.push(`adopt ${f(s.adoptMs.p50, 3)}/${f(s.adoptMs.p95, 3)}`);
  if (s.renderMs) bits.push(`render ${f(s.renderMs.p50, 2)}/${f(s.renderMs.p95, 2)}`);
  if (s.worker?.packMs) bits.push(`wkr-pack ${f(s.worker.packMs.p50, 2)}/${f(s.worker.packMs.p95, 2)}`);
  if (s.worker?.renderMs) bits.push(`wkr-render ${f(s.worker.renderMs.p50, 2)}/${f(s.worker.renderMs.p95, 2)}`);
  if (s.frameWorkMs) bits.push(`rAFwork ${f(s.frameWorkMs.p50, 2)}/${f(s.frameWorkMs.p95, 2)}`);
  if (s.torn) bits.push(`TORN ${s.torn}`);
  if (s.trace?.error) bits.push(`TRACE-ERR ${s.trace.error}`);
  console.log(` ${s.scenario.padEnd(30)} ${s.contender}  ${bits.join('  ')}`);
}
