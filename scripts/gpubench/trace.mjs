// Main-thread occupancy from a real Chrome trace.
//
// Metric 1 is the one the whole review turns on, so it is not inferred from
// anything the page can see about itself. `RunTask` is the top-level slice
// Chrome emits around every task the renderer main thread runs, including the
// ones this harness did not schedule, so summing its durations over a window
// is main-thread busy time by construction. The in-page PerformanceObserver
// long-task count is collected separately and cross-checked against it.

export async function startTrace(cdp) {
  collected.set(cdp, []);
  if (!hooked.has(cdp)) {
    hooked.add(cdp);
    cdp.on('Tracing.dataCollected', (e) => {
      const arr = collected.get(cdp);
      if (arr) for (const ev of e.value) arr.push(ev);
    });
  }
  await cdp.send('Tracing.start', {
    traceConfig: {
      recordMode: 'recordAsMuchAsPossible',
      // Only what metric 1 needs. Pulling in the whole devtools.timeline
      // category produced traces large enough that the IO stream read failed
      // outright on the eight-pane runs, which showed up as missing rows.
      includedCategories: ['toplevel', '__metadata'],
    },
    // Events are delivered as CDP notifications instead of through an IO
    // stream, so there is no handle to fail to read.
    transferMode: 'ReportEvents',
  });
}

const collected = new Map();
const hooked = new Set();

export async function endTrace(cdp) {
  const done = new Promise((res) => cdp.once('Tracing.tracingComplete', res));
  await cdp.send('Tracing.end');
  await done;
  const out = collected.get(cdp) ?? [];
  collected.set(cdp, []);
  return out;
}

/**
 * Busy time per named thread.
 *
 * Returns microseconds of RunTask per (pid,tid), the thread names, the number
 * of tasks over 50 ms, and the wall span the trace covers, so the caller can
 * turn it into busy-ms-per-second without guessing the window.
 */
export function analyze(events) {
  const names = new Map();
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'thread_name') {
      names.set(`${e.pid}/${e.tid}`, e.args?.name ?? '?');
    }
  }

  const byThread = new Map();
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of events) {
    // The top-level task slice is called RunTask under devtools.timeline and
    // ThreadControllerImpl::RunTask under toplevel. Matching only the former
    // produced an empty thread list that read as "no data" rather than as a
    // name mismatch, so both are accepted.
    if (e.ph !== 'X' || (e.name !== 'RunTask' && e.name !== 'ThreadControllerImpl::RunTask')) continue;
    const k = `${e.pid}/${e.tid}`;
    let s = byThread.get(k);
    if (!s) byThread.set(k, (s = { key: k, name: names.get(k) ?? '?', busyUs: 0, tasks: 0, long: [], durs: [] }));
    s.busyUs += e.dur ?? 0;
    s.tasks++;
    s.durs.push((e.dur ?? 0) / 1000);
    if ((e.dur ?? 0) > 50000) s.long.push((e.dur ?? 0) / 1000);
    if (e.ts < lo) lo = e.ts;
    if (e.ts + (e.dur ?? 0) > hi) hi = e.ts + (e.dur ?? 0);
  }

  const span = (hi - lo) / 1000; // ms
  const out = [...byThread.values()].map((s) => {
    const sorted = s.durs.sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))];
    const ls = s.long.slice().sort((a, b) => a - b);
    return {
      thread: s.name,
      key: s.key,
      busyMs: s.busyUs / 1000,
      tasks: s.tasks,
      taskP50Ms: q(0.5),
      taskP95Ms: q(0.95),
      taskMaxMs: sorted[sorted.length - 1],
      longTasks: s.long.length,
      longTaskP95Ms: ls.length ? ls[Math.min(ls.length - 1, Math.round(0.95 * (ls.length - 1)))] : null,
      longTaskMaxMs: ls.length ? ls[ls.length - 1] : null,
    };
  });
  out.sort((a, b) => b.busyMs - a.busyMs);
  return { spanMs: span, threads: out };
}

/** The page's own renderer main thread: the busiest CrRendererMain. */
export function mainThread(a) {
  return a.threads.filter((t) => t.thread === 'CrRendererMain')[0] ?? null;
}

export function workerThreads(a) {
  return a.threads.filter((t) => /Worker/i.test(t.thread));
}
