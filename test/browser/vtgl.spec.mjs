// The vtgl renderer is a separate entry. A page that hands it in gets it; a
// page that asks for it by name without handing it in falls back, and says so.
import { expect, test } from '@playwright/test';

import { boot } from './helpers.mjs';

test('prefer vtgl with the vtgl entry handed in draws through vtgl', async ({ page }) => {
  await boot(page, '?renderer=vtgl&vtgl=1&vtglShaper=forms');
  expect(await page.evaluate(() => window.term.renderer)).toBe('vtgl');

  // vtgl mounts its own canvas inside xterm's screen element.
  const text = await page.evaluate(async () => {
    window.term.write('drawn by vtgl');
    await window.term.flush();
    return window.term.xterm.buffer.active.getLine(0).translateToString(true);
  });
  expect(text).toBe('drawn by vtgl');
  expect(await page.locator('#host .xterm-screen canvas').count()).toBeGreaterThan(0);
});

// vtgl measures the font itself and xterm measures it again, and the two
// disagree. xterm's screen element is the box a page lays out, so it has to be
// the size of the grid vtgl draws. When it kept the size the DOM renderer gave
// it, a host that centred the screen drew the grid about 200 px too low and
// cut off its bottom rows (the Learn tuios page did).
test('the vtgl screen element is the size of the grid vtgl draws', async ({ page }) => {
  await boot(page, '?renderer=vtgl&vtgl=1');
  expect(await page.evaluate(() => window.term.renderer)).toBe('vtgl');

  const boxes = await page.evaluate(() => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, height: r.height };
    };
    const screen = document.querySelector('#host .xterm-screen');
    return { screen: box(screen), canvas: box(screen.querySelector('canvas.xterm-vtgl-canvas')) };
  });
  expect(boxes.canvas.height).toBeGreaterThan(0);
  expect(boxes.screen).toEqual(boxes.canvas);
});

test('prefer vtgl without the vtgl entry falls back to an xterm renderer and warns', async ({ page }) => {
  const warnings = [];
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text());
  });
  await boot(page, '?renderer=vtgl');
  expect(['webgl', 'canvas', 'dom']).toContain(await page.evaluate(() => window.term.renderer));
  expect(warnings.some((w) => w.includes("prefer 'vtgl' needs renderer.vtgl"))).toBe(true);
});

test('the core ESM entry never loads vtgl', async ({ page }) => {
  const requested = [];
  page.on('request', (r) => requested.push(r.url()));
  await boot(page, '?renderer=auto');
  expect(requested.filter((u) => u.includes('vtgl'))).toEqual([]);
});
