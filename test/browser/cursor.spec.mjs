// The cursor shape an application asks for, read back from the pixels.
//
// DECSCUSR (`CSI Ps SP q`) selects the shape: 1 and 2 a block, 3 and 4 an
// underline, 5 and 6 a bar, odd blinking and even steady, 0 the configured
// shape. xterm.js keeps it apart from the options, and only its own DOM
// renderer used to draw it: the canvas addon drew every shape as a block, the
// WebGL addon never started its blink clock for one, and vtgl drew every shape
// as a block and hid the cursor on blur. Each renderer is checked here the
// same way, by the colour of the cursor in a screenshot of its cell.
import { test, expect } from '@playwright/test';
import { boot } from './helpers.mjs';

const MAGENTA = [255, 0, 255];

async function write(page, data) {
  await page.evaluate((d) => new Promise((resolve) => window.term.xterm.write(d, resolve)), data);
  // One frame for the renderer to draw what was parsed.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/**
 * The pixels of one cell that carry `rgb`, classified as a cursor shape.
 *
 * Screenshots in device pixels, so a line's thickness is measured as drawn.
 */
async function shape(page, col, row, rgb = MAGENTA) {
  const box = await page.evaluate(
    ([c, r]) => {
      const screen = document.querySelector('#host .xterm-screen').getBoundingClientRect();
      const cell = window.term.xterm._core._renderService.dimensions.css.cell;
      return { x: screen.left + c * cell.width, y: screen.top + r * cell.height, width: cell.width, height: cell.height };
    },
    [col, row],
  );
  const png = await page.screenshot({ clip: box, scale: 'device' });
  return page.evaluate(
    async ([base64, [r, g, b]]) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const { data, width: w, height: h } = ctx.getImageData(0, 0, image.width, image.height);
      const hit = (x, y) => {
        const i = (y * w + x) * 4;
        return Math.abs(data[i] - r) < 50 && Math.abs(data[i + 1] - g) < 50 && Math.abs(data[i + 2] - b) < 50;
      };
      let count = 0;
      const columns = new Array(w).fill(0);
      const rows = new Array(h).fill(0);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!hit(x, y)) continue;
          count++;
          columns[x]++;
          rows[y]++;
        }
      }
      const fullColumns = columns.map((n) => n >= h - 1);
      const fullRows = rows.map((n) => n >= w - 1);
      const run = (flags, from, step) => {
        let n = 0;
        for (let i = from; i >= 0 && i < flags.length && flags[i]; i += step) n++;
        return n;
      };
      if (count === 0) return { kind: 'none' };
      if (count >= w * h * 0.9) return { kind: 'block' };
      const half = Math.floor(h / 2);
      if (fullRows[0] && fullRows[h - 1] && fullColumns[0] && fullColumns[w - 1]) {
        const inside = rows.slice(2, h - 2).every((n) => n <= 4);
        if (inside) return { kind: 'outline' };
      }
      if (fullColumns[0] && count === run(fullColumns, 0, 1) * h) {
        return { kind: 'bar', thickness: run(fullColumns, 0, 1) };
      }
      // An underline sits on the cell's bottom edge, give or take the pixel a
      // renderer rounds its cell height by, and nothing is drawn above it.
      const bottom = fullRows.lastIndexOf(true);
      if (bottom >= h - 3 && rows.slice(0, half).every((n) => n === 0)) {
        return { kind: 'underline', thickness: run(fullRows, bottom, -1) };
      }
      return { kind: 'other', count, w, h };
    },
    [png.toString('base64'), rgb],
  );
}

/** The cursor's shape at column 2 of row 1, for `expect.poll`. */
async function kind(page, rgb = MAGENTA) {
  return (await shape(page, 2, 1, rgb)).kind;
}

/** The shapes seen while sampling the cursor for longer than one blink phase. */
async function shapesOver(page, ms) {
  const seen = new Set();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    seen.add((await shape(page, 2, 1)).kind);
    await page.waitForTimeout(80);
  }
  return [...seen].sort();
}

const RENDERERS = [
  ['webgl', '?renderer=webgl'],
  ['canvas', '?renderer=canvas'],
  ['dom', '?renderer=dom'],
  ['vtgl', '?renderer=vtgl&vtgl=1'],
];

for (const [name, query] of RENDERERS) {
  test.describe(`cursor on the ${name} renderer`, () => {
    test.beforeEach(async ({ page }) => {
      await boot(page, `${query}&cols=20&rows=6`);
      expect(await page.evaluate(() => window.term.renderer)).toBe(name);
      await page.evaluate(() => window.term.xterm.focus());
      // A cursor colour no glyph or background uses, at column 2 of row 1.
      await write(page, '\x1b[2J\x1b[2;3H\x1b]12;#ff00ff\x07');
    });

    test('DECSCUSR draws the shape it names', async ({ page }) => {
      const dpr = await page.evaluate(() => devicePixelRatio);
      for (const [param, expected] of [
        [1, 'block'],
        [2, 'block'],
        [3, 'underline'],
        [4, 'underline'],
        [5, 'bar'],
        [6, 'bar'],
      ]) {
        await write(page, `\x1b[${param} q`);
        // Polled, because a blinking shape may be caught in its hidden half.
        let got;
        await expect
          .poll(async () => (got = await shape(page, 2, 1)).kind, { timeout: 2000, message: `DECSCUSR ${param}` })
          .toBe(expected);
        if (expected !== 'block') {
          // One CSS pixel at least, scaled with the device pixel ratio, and
          // never more than two.
          expect(got.thickness, `DECSCUSR ${param} thickness`).toBeGreaterThanOrEqual(dpr);
          expect(got.thickness, `DECSCUSR ${param} thickness`).toBeLessThanOrEqual(2 * dpr);
        }
      }
      // 0 hands the cursor back to the configured shape, a block.
      await write(page, '\x1b[0 q');
      await expect.poll(() => kind(page), { timeout: 2000 }).toBe('block');
    });

    test('an odd DECSCUSR blinks and an even one does not', async ({ page }) => {
      // Two seconds is three blink phases, at 600 ms each.
      await write(page, '\x1b[5 q');
      expect(await shapesOver(page, 2000), 'DECSCUSR 5 over two seconds').toEqual(['bar', 'none']);
      await write(page, '\x1b[6 q');
      expect(await shapesOver(page, 2000), 'DECSCUSR 6 over two seconds').toEqual(['bar']);
      await write(page, '\x1b[3 q');
      expect(await shapesOver(page, 2000), 'DECSCUSR 3 over two seconds').toEqual(['none', 'underline']);
      await write(page, '\x1b[2 q');
      expect(await shapesOver(page, 2000), 'DECSCUSR 2 over two seconds').toEqual(['block']);
    });

    test('the shape survives the alternate screen and goes back on a hard reset', async ({ page }) => {
      // The shape is set a frame before the switch. With both in one frame the
      // WebGL addon leaves a block behind at the old cursor cell, which xterm's
      // own refresh does not clear. That is upstream, and it needs a block to
      // change to another shape on the very frame the alternate screen opens.
      await write(page, '\x1b[6 q');
      await write(page, '\x1b[?1049h\x1b[2;3H');
      await expect.poll(() => kind(page), { timeout: 2000, message: 'on the alternate screen' }).toBe('bar');
      await write(page, '\x1b[4 q\x1b[?1049l');
      await expect.poll(() => kind(page), { timeout: 2000, message: 'back on the main screen' }).toBe('underline');
      // RIS also resets the colour xterm keeps, so the probe colour is set again.
      await write(page, '\x1bc\x1b]12;#ff00ff\x07\x1b[2;3H');
      await expect.poll(() => kind(page), { timeout: 2000, message: 'after RIS' }).toBe('block');
      await write(page, '\x1b[6 q\x1b[!p\x1b[2;3H');
      await expect.poll(() => kind(page), { timeout: 2000, message: 'after DECSTR' }).toBe('block');
    });

    test('DECTCEM hides and shows the cursor', async ({ page }) => {
      await write(page, '\x1b[6 q\x1b[?25l');
      await expect.poll(() => kind(page), { timeout: 2000 }).toBe('none');
      await write(page, '\x1b[?25h');
      await expect.poll(() => kind(page), { timeout: 2000 }).toBe('bar');
    });

    test('without the focus the cursor is a hollow block', async ({ page }) => {
      await write(page, '\x1b[6 q');
      await page.evaluate(() => {
        window.term.xterm.blur();
        document.activeElement?.blur();
      });
      await write(page, '');
      await expect.poll(() => kind(page), { timeout: 2000 }).toBe('outline');
      await page.evaluate(() => window.term.xterm.focus());
      await write(page, '');
      await expect.poll(() => kind(page), { timeout: 2000 }).toBe('bar');
    });

    test('OSC 12 sets the cursor colour and OSC 112 gives back the theme one', async ({ page }) => {
      await write(page, '\x1b[2 q\x1b]12;#00ff00\x07');
      await expect.poll(() => kind(page, [0, 255, 0]), { timeout: 2000 }).toBe('block');
      await write(page, '\x1b]112\x07');
      const themeCursor = () =>
        page.evaluate(() => {
          const c = window.term.xterm._core._themeService.colors.cursor.rgba;
          return [(c >>> 24) & 0xff, (c >>> 16) & 0xff, (c >>> 8) & 0xff];
        });
      const dark = await themeCursor();
      await expect.poll(() => kind(page, [0, 255, 0]), { timeout: 2000, message: 'no green left' }).toBe('none');
      expect((await shape(page, 2, 1, dark)).kind, 'the theme colour').toBe('block');

      // A theme change takes the default cursor colour with it.
      await page.evaluate(async () => {
        const { getTheme } = await import('/dist/themes/index.js');
        window.term.setTheme(getTheme('atom-one-light'));
      });
      const light = await themeCursor();
      expect(light, 'the two themes have different cursors').not.toEqual(dark);
      await expect.poll(() => kind(page, light), { timeout: 2000, message: 'the new theme colour' }).toBe('block');
    });
  });
}
