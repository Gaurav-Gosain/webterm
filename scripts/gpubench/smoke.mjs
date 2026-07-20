import { serve, launch, park, verifyGpu } from './launch.mjs';

const { server, port } = await serve();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
page.on('console', (m) => console.log(`[page:${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.error('[pageerror]', e.stack ?? e.message));

await page.goto(`http://127.0.0.1:${port}/smoke.html`);
console.log('parked windows:', park());
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });

const gpu = await verifyGpu(page);
console.log('gpu guard:', JSON.stringify(gpu, null, 1));

for (const stream of ['btop-200x55', 'sgr-bat', 'vim-200x55']) {
  const r = await page.evaluate(
    ([s]) => window.smoke(s, 200, 55, 2_000_000),
    [stream],
  );
  console.log(`\n== ${stream}`);
  console.log(JSON.stringify(r, null, 1));
}

await browser.close();
server.close();
