// The query and report sequences: the geometry an application has to ask for
// before it can size an image, the colours it has to ask for before it can
// match the theme, and the two DCS requests xterm.js answers wrongly or not at
// all.
//
// Every assertion here is against the built bundle in a real browser, because
// half of what is measured does not exist outside one. xterm.js answers the
// pixel geometry out of its render service and the colour queries out of its
// theme service, and a headless terminal has neither, which is exactly why the
// conformance harness in scripts/vtconf reports them as unanswered and this
// suite exists to check them where they are real.
import { expect, test } from '@playwright/test';

import { boot } from './helpers.mjs';

/** Write `sequence` and return everything the terminal sent back. */
async function ask(page, sequence) {
  return page.evaluate(async (seq) => {
    window.clearData();
    window.term.write(seq);
    await window.term.flush();
    // A reply produced inside a parser callback is emitted synchronously, but
    // the write itself is batched to a frame, so wait one out.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)));
    return window.dataText();
  }, sequence);
}

/** The geometry the reports are checked against, read from public API. */
async function geometry(page) {
  return page.evaluate(() => ({
    cols: window.term.cols,
    rows: window.term.rows,
    pixel: window.term.pixelSize,
    cell: window.term.xterm.dimensions?.css.cell,
  }));
}

/** Assert all three geometry reports against what the terminal measures. */
async function expectGeometryReports(page) {
  const g = await geometry(page);
  expect(g.pixel.width).toBeGreaterThan(0);
  expect(g.cell.width).toBeGreaterThan(0);

  // CSI 14 t: the text area in pixels, as CSI 4 ; height ; width t.
  const winPixels = await ask(page, '\x1b[14t');
  expect(winPixels).toMatch(/^\x1b\[4;\d+;\d+t$/);
  const [, height, width] = winPixels.match(/^\x1b\[4;(\d+);(\d+)t$/);
  // xterm reports the render service's canvas box and pixelSize measures the
  // screen element, so they are two readings of the same thing and are allowed
  // to differ by the rounding each does, not by a cell.
  expect(Math.abs(Number(width) - g.pixel.width)).toBeLessThan(g.cell.width);
  expect(Math.abs(Number(height) - g.pixel.height)).toBeLessThan(g.cell.height);

  // CSI 16 t: one cell in pixels, as CSI 6 ; height ; width t.
  const cellPixels = await ask(page, '\x1b[16t');
  expect(cellPixels).toMatch(/^\x1b\[6;\d+;\d+t$/);
  const [, cellHeight, cellWidth] = cellPixels.match(/^\x1b\[6;(\d+);(\d+)t$/);
  expect(Number(cellWidth)).toBe(Math.round(g.cell.width));
  expect(Number(cellHeight)).toBe(Math.round(g.cell.height));

  // CSI 18 t: the text area in cells, as CSI 8 ; rows ; cols t.
  expect(await ask(page, '\x1b[18t')).toBe(`\x1b[8;${g.rows};${g.cols}t`);

  return g;
}

test('the geometry reports answer with the real pixel and cell size', async ({ page }) => {
  await boot(page);
  await expectGeometryReports(page);
});

test('the geometry reports follow a resize', async ({ page }) => {
  await boot(page);
  const before = await expectGeometryReports(page);

  await page.setViewportSize({ width: 640, height: 380 });
  await page.waitForFunction((cols) => window.term.cols !== cols, before.cols, { timeout: 10_000 });
  const after = await expectGeometryReports(page);

  // A report that never moved would pass the assertions above by reporting a
  // stale figure that still happens to be self-consistent.
  expect(after.cols).not.toBe(before.cols);
});

test('the geometry reports follow a font size change', async ({ page }) => {
  await boot(page);
  const before = await expectGeometryReports(page);

  await page.evaluate(() => window.term.setOptions({ fontSize: 22 }));
  await page.waitForFunction((w) => window.term.xterm.dimensions?.css.cell.width !== w, before.cell.width, {
    timeout: 10_000,
  });
  const after = await expectGeometryReports(page);

  expect(after.cell.width).toBeGreaterThan(before.cell.width);
});

test('nothing that acts on the window is answered', async ({ page }) => {
  await boot(page);

  // The XTWINOPS gate is open for the three geometry reports and for nothing
  // else, so an application cannot raise, move, resize or retitle the page.
  for (const sequence of ['\x1b[1t', '\x1b[2t', '\x1b[3;10;10t', '\x1b[4;300;300t', '\x1b[9;1t', '\x1b[21t']) {
    expect(await ask(page, sequence)).toBe('');
  }
  // The grid is untouched by all of it.
  const g = await geometry(page);
  expect(g.cols).toBeGreaterThan(20);
});

test('the colour queries answer with the theme that is applied', async ({ page }) => {
  await boot(page);

  // A theme out of the corpus, applied the way a consumer applies one.
  const theme = await page.evaluate(async () => {
    const { getTheme } = await import('/dist/themes/index.js');
    const theme = getTheme('tokyo-night');
    window.term.setTheme(theme);
    return theme;
  });
  await page.waitForTimeout(100);

  /** '#rrggbb' as the rgb:rrrr/gggg/bbbb an OSC colour reply carries. */
  const spec = (hex) =>
    [1, 3, 5]
      .map((i) => hex.slice(i, i + 2).repeat(2))
      .join('/');

  expect(await ask(page, '\x1b]11;?\x07')).toBe(`\x1b]11;rgb:${spec(theme.background)}\x1b\\`);
  expect(await ask(page, '\x1b]10;?\x07')).toBe(`\x1b]10;rgb:${spec(theme.foreground)}\x1b\\`);
  expect(await ask(page, '\x1b]12;?\x07')).toBe(`\x1b]12;rgb:${spec(theme.cursor)}\x1b\\`);
  // OSC 4 indexes the palette; 1 is red.
  expect(await ask(page, '\x1b]4;1;?\x07')).toBe(`\x1b]4;1;rgb:${spec(theme.red)}\x1b\\`);
});

test('the colour queries follow a theme change', async ({ page }) => {
  await boot(page);

  const read = () => ask(page, '\x1b]11;?\x07');
  const dark = await page.evaluate(async () => {
    const { getTheme } = await import('/dist/themes/index.js');
    window.term.setTheme(getTheme('tokyo-night'));
    return getTheme('tokyo-night').background;
  });
  await page.waitForTimeout(100);
  const first = await read();

  const light = await page.evaluate(async () => {
    const { getTheme } = await import('/dist/themes/index.js');
    window.term.setTheme(getTheme('atom-one-light'));
    return getTheme('atom-one-light').background;
  });
  await page.waitForTimeout(100);
  const second = await read();

  expect(dark).not.toBe(light);
  expect(first).not.toBe(second);
  expect(second.toLowerCase()).toContain(light.slice(1, 3).repeat(2).toLowerCase());
});

test('DECRQSS reports the cursor style the application set, not the configured one', async ({
  page,
}) => {
  await boot(page);

  // The terminal is configured with a steady block, so this is the answer that
  // is right only if the reply is built from the application's DECSCUSR.
  expect(await ask(page, '\x1bP$q q\x1b\\')).toBe('\x1bP1$r2 q\x1b\\');

  for (const [param, expected] of [
    [1, 1],
    [3, 3],
    [4, 4],
    [5, 5],
    [6, 6],
  ]) {
    expect(await ask(page, `\x1b[${param} q\x1bP$q q\x1b\\`)).toBe(`\x1bP1$r${expected} q\x1b\\`);
  }

  // DECSCUSR 0 hands the cursor back to the terminal's own configuration.
  expect(await ask(page, '\x1b[0 q\x1bP$q q\x1b\\')).toBe('\x1bP1$r2 q\x1b\\');
});

test('a hard reset takes the cursor style back to the configured one', async ({ page }) => {
  await boot(page);

  expect(await ask(page, '\x1b[5 q\x1bP$q q\x1b\\')).toBe('\x1bP1$r5 q\x1b\\');
  // RIS, then DECSTR, both of which clear the private mode xterm keeps it in.
  expect(await ask(page, '\x1bc\x1bP$q q\x1b\\')).toBe('\x1bP1$r2 q\x1b\\');
  expect(await ask(page, '\x1b[5 q\x1b[!p\x1bP$q q\x1b\\')).toBe('\x1bP1$r2 q\x1b\\');
});

test('the other DECRQSS settings still come from xterm', async ({ page }) => {
  await boot(page);

  // Only the cursor style is intercepted; everything else falls through, and a
  // handler that swallowed the identifier would silence these.
  expect(await ask(page, '\x1b[2;5r\x1bP$qr\x1b\\')).toBe('\x1bP1$r2;5r\x1b\\');
  expect(await ask(page, '\x1bP$qm\x1b\\')).toMatch(/^\x1bP1\$r.*m\x1b\\$/);
  // An unsupported setting is refused rather than answered.
  expect(await ask(page, '\x1bP$qZZ\x1b\\')).toBe('\x1bP0$r\x1b\\');
});

test('XTGETTCAP answers the terminal name, which xterm.js answers not at all', async ({ page }) => {
  await boot(page);

  const hex = (s) =>
    [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()).join('');

  expect(await ask(page, '\x1bP+q544e\x1b\\')).toBe(`\x1bP1+r544E=${hex('xterm-256color')}\x1b\\`);
  expect(await ask(page, `\x1bP+q${hex('Co')}\x1b\\`)).toBe(`\x1bP1+r${hex('Co')}=${hex('256')}\x1b\\`);
  // A capability this layer cannot judge gets no answer, so the application
  // falls back to its terminfo entry rather than being told the terminal lacks
  // something it may well have.
  expect(await ask(page, `\x1bP+q${hex('Smulx')}\x1b\\`)).toBe('');
});

test('a read-only terminal answers nothing', async ({ page }) => {
  await boot(page);

  await page.evaluate(() => window.term.setOptions({ input: { readOnly: true } }));
  for (const sequence of ['\x1b[14t', '\x1b[18t', '\x1b]11;?\x07', '\x1bP$q q\x1b\\', '\x1bP+q544e\x1b\\']) {
    expect(await ask(page, sequence)).toBe('');
  }
});
