import { serve, launch, parkUntilFound } from './launch.mjs';
import { startTrace, endTrace, analyze } from './trace.mjs';

const { server, port } = await serve();
const browser = await launch();
await parkUntilFound();
const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
await page.goto(`http://127.0.0.1:${port}/`);
await parkUntilFound();
await page.waitForFunction(() => window.__ready === true);
const cdp = await page.context().newCDPSession(page);
await startTrace(cdp);
await page.evaluate(
  () =>
    new Promise((r) => {
      const t0 = performance.now();
      (function spin() {
        const s = performance.now();
        while (performance.now() - s < 5) {
          /* burn a measurable slice so RunTask has something to record */
        }
        if (performance.now() - t0 < 1500) setTimeout(spin, 0);
        else r();
      })();
    }),
);
const ev = await endTrace(cdp);
console.log('events:', ev.length);
const phs = {};
for (const e of ev) phs[e.ph] = (phs[e.ph] ?? 0) + 1;
console.log('phases:', phs);
console.log('metadata names:', [...new Set(ev.filter((e) => e.ph === 'M').map((e) => e.name))].slice(0, 10));
console.log('X names:', [...new Set(ev.filter((e) => e.ph === 'X').map((e) => e.name))].slice(0, 10));
const a = analyze(ev);
console.log('threads:', JSON.stringify(a.threads.slice(0, 6), null, 1));
await browser.close();
server.close();
