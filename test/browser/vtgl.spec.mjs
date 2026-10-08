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
