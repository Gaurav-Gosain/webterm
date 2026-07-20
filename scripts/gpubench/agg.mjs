// Median across repetitions. Medians, never means: one GC pause moves a mean
// and does not move a median, and every scenario here has three samples.
import { readFileSync } from 'node:fs';

const r = JSON.parse(readFileSync(process.argv[2] ?? 'results-r3.json', 'utf8'));
const med = (xs) => {
  const s = xs.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const f = (x, d = 1) => (x == null ? '-' : Number(x).toFixed(d));

const pick = (rows, path) =>
  med(
    rows.map((s) =>
      path.split('.').reduce((o, k) => (o == null ? null : o[k]), s),
    ),
  );

const scen = [...new Set(r.scenarios.map((s) => s.scenario))];
const ids = [...new Set(r.scenarios.map((s) => s.contender))];

console.log('## environment');
console.log(JSON.stringify(r.meta, null, 1));
console.log('\n## correctness controls');
for (const k of Object.keys(r.verify ?? {})) {
  const v = r.verify[k];
  if (v && typeof v === 'object' && (v.pixels || v.checksum != null)) {
    console.log(
      ` ${k}: cells=${v.checksum ?? '-'} px=${v.pixels?.hash ?? '-'} ${v.pixels?.w}x${v.pixels?.h} ` +
        `colors=${v.pixels?.distinctColors ?? '-'} nonbg=${f((v.pixels?.nonBgFraction ?? 0) * 100)}%` +
        (v.proof ? ` proof=${JSON.stringify(v.proof)}` : ''),
    );
  } else {
    console.log(` ${k}: ${JSON.stringify(v)}`);
  }
}

for (const sc of scen) {
  console.log(`\n## ${sc}`);
  const hdr =
    'id'.padEnd(4) +
    'mainBusy'.padStart(10) +
    'wkrBusy'.padStart(9) +
    'gpuBusy'.padStart(9) +
    'taskP95'.padStart(9) +
    'taskMax'.padStart(9) +
    'LT>50'.padStart(7) +
    'rAF/s'.padStart(7) +
    'ivP95'.padStart(7) +
    'key50'.padStart(7) +
    'key95'.padStart(7) +
    'MiB/s'.padStart(7) +
    'cpu/s'.padStart(7) +
    'n'.padStart(3);
  console.log(hdr);
  console.log('-'.repeat(hdr.length));
  for (const id of ids) {
    const rows = r.scenarios.filter((s) => s.scenario === sc && s.contender === id && !s.error);
    if (!rows.length) {
      const err = r.scenarios.find((s) => s.scenario === sc && s.contender === id)?.error;
      console.log(id.padEnd(4) + `  all reps failed: ${err}`);
      continue;
    }
    const gpu = med(
      rows.map((s) => {
        const g = (s.trace?.gpuProcess ?? []).reduce((a, b) => a + b.busyMs, 0);
        return s.trace?.spanMs ? (g / s.trace.spanMs) * 1000 : null;
      }),
    );
    console.log(
      id.padEnd(4) +
        f(pick(rows, 'trace.mainBusyMsPerSec')).padStart(10) +
        f(pick(rows, 'trace.workerBusyMsPerSec')).padStart(9) +
        f(gpu).padStart(9) +
        f(pick(rows, 'trace.main.taskP95Ms'), 2).padStart(9) +
        f(pick(rows, 'trace.main.taskMaxMs'), 1).padStart(9) +
        f(pick(rows, 'trace.main.longTasks'), 0).padStart(7) +
        f(pick(rows, 'rafFps')).padStart(7) +
        f(pick(rows, 'rafInterval.p95')).padStart(7) +
        f(pick(rows, 'keyEchoMs.p50')).padStart(7) +
        f(pick(rows, 'keyEchoMs.p95')).padStart(7) +
        f(pick(rows, 'mibPerSec')).padStart(7) +
        f(pick(rows, 'cpu.cpuPerSecond'), 2).padStart(7) +
        String(rows.length).padStart(3),
    );
  }
}

console.log('\n## per-stage detail (median of reps, ms per frame)');
for (const sc of scen) {
  for (const id of ids) {
    const rows = r.scenarios.filter((s) => s.scenario === sc && s.contender === id && !s.error);
    if (!rows.length) continue;
    const bits = [];
    const add = (label, p) => {
      const v = pick(rows, p);
      if (v != null) bits.push(`${label} ${f(v, 3)}`);
    };
    add('pack', 'packMs.p50');
    add('adopt', 'adoptMs.p50');
    add('render', 'renderMs.p50');
    add('wkrPack', 'worker.packMs.p50');
    add('wkrRender', 'worker.renderMs.p50');
    add('rAFwork.p50', 'frameWorkMs.p50');
    add('rAFwork.p95', 'frameWorkMs.p95');
    console.log(` ${sc.padEnd(28)} ${id}  ${bits.join('  ')}`);
  }
}

console.log('\n## spread across reps (mainBusy ms/s, MiB/s, key p50)');
for (const sc of scen) {
  for (const id of ids) {
    const rows = r.scenarios.filter((s) => s.scenario === sc && s.contender === id && !s.error);
    if (!rows.length) continue;
    const g = (p) => rows.map((s) => f(p.split('.').reduce((o, k) => (o == null ? null : o[k]), s)));
    console.log(
      ` ${sc.padEnd(28)} ${id}  busy[${g('trace.mainBusyMsPerSec').join(' ')}]  ` +
        `mib[${g('mibPerSec').join(' ')}]  key[${g('keyEchoMs.p50').join(' ')}]`,
    );
  }
}
