// Half-block sprites: every cell is two colours.
//
// A colorscript (pokemon-colorscripts, and everything else that paints an
// image into text) emits one character per pixel pair: U+2580 or U+2584 with a
// 24-bit foreground and a 24-bit background. The top half of the cell is one
// colour and the bottom half is the other, so a sprite is nothing but cells
// whose two halves must each land on an exact RGB value.
//
// That makes the correct picture computable rather than eyeballed: for U+2580
// the top half is the foreground and the bottom half is the background, and
// for U+2584 the two swap. Any cell whose halves do not hold those values is a
// rendering defect, and the suite can count them.
//
// Half blocks reach the screen by a different route from text. The WebGL
// renderer does not rasterise them from the font: it fills them as rectangles
// on an eight by eight grid and caches the result in the glyph atlas under the
// glyph together with its full foreground and background. A sprite is the only
// content that drives that route at scale, tens of colour pairs deep, which is
// why an atlas stress test built from ordinary text walks straight past it.
//
// These suites were written to chase reported speckle in a sprite and did not
// find any: every renderer reproduces every cell exactly, here and in the
// application that reported it. They stay because the route is real, it is
// uncovered by anything else in this package, and a regression in it would
// otherwise be visible only to someone printing a colorscript.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { ROOT } from '../port.mjs';
import { boot } from './helpers.mjs';

const COLS = 40;
const ROWS = 20;

/**
 * How far a rendered pixel may sit from the colour that was asked for.
 *
 * Two, not a comfortable margin. Every suite here passes at exact equality on
 * both SwiftShader and a real GPU, so the slack exists only to absorb a future
 * driver rounding a blend by a unit, and anything larger would start hiding
 * the quantisation defects this is meant to catch.
 */
const TOLERANCE = 2;

/** Upper half block. Top half foreground, bottom half background. */
const UPPER = '▀';
/** Lower half block. Top half background, bottom half foreground. */
const LOWER = '▄';

/**
 * What the two halves of a cell must hold, given its glyph and its colours.
 *
 * U+2580 inks the top half, U+2584 the bottom, and a space inks neither, so a
 * blank cell is background twice over rather than half foreground.
 */
function halves(glyph, fg, bg) {
  if (glyph === UPPER) return { glyph: 'upper', top: fg, bottom: bg };
  if (glyph === LOWER) return { glyph: 'lower', top: bg, bottom: fg };
  return { glyph: 'blank', top: bg, bottom: bg };
}

/**
 * A deterministic pseudo-random colour, so a failure is reproducible and the
 * grid still holds hundreds of distinct 24-bit values rather than a handful.
 *
 * A sprite's colours are near neighbours far more often than they are random,
 * which is what makes a cache keyed on too little of the colour look correct
 * on a synthetic grid of widely spaced values. `spread` narrows the range so
 * adjacent cells differ by single digits.
 */
function colorAt(seed, spread) {
  let h = seed * 2654435761;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  const base = 40;
  return [
    base + (Math.abs(h) % spread),
    base + (Math.abs(h >>> 8) % spread),
    base + (Math.abs(h >>> 16) % spread),
  ];
}

/**
 * A grid of half-block cells with a known foreground and background each.
 *
 * Written the way a colorscript writes it: SGR, glyph, SGR, glyph, with a
 * reset only at end of line, so the terminal has to carry attributes forward
 * across cells exactly as it does for the real thing.
 */
function buildGrid({ cols, rows, spread = 200 }) {
  const cells = [];
  let text = '\x1b[H';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const glyph = (x + y) % 2 === 0 ? UPPER : LOWER;
      const fg = colorAt(y * cols + x, spread);
      const bg = colorAt((y * cols + x) * 7919 + 13, spread);
      text += `\x1b[38;2;${fg.join(';')}m\x1b[48;2;${bg.join(';')}m${glyph}`;
      cells.push({ x, y, ...halves(glyph, fg, bg) });
    }
    text += '\x1b[0m';
    if (y < rows - 1) text += '\r\n';
  }
  return { text, cells };
}

/**
 * Write into the terminal and wait until the renderer has actually painted.
 *
 * `write`'s callback fires when the parser has consumed the bytes, which is
 * earlier than the frame that shows them. Two animation frames after that is
 * the first moment the canvas is guaranteed to hold the result.
 */
async function writeAndPaint(page, text) {
  await page.evaluate(async (payload) => {
    const term = window.term.xterm;
    term.options.cursorBlink = false;
    await new Promise((resolve) => term.write(payload, resolve));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, text);
  // The DOM renderer commits through style recalculation rather than a canvas
  // draw, and a screenshot can outrun it.
  await page.waitForTimeout(150);
}

/**
 * Write through webterm's own public entry, in byte-sized chunks, the way a
 * transport hands a pty's output over.
 *
 * The chunk sizes are a fixed pseudo-random walk rather than a constant, so
 * boundaries land at varied offsets inside sequences, and they stay the same
 * between runs so a failure can be re-run. Chunks are released across several
 * animation frames because the batching writer coalesces within a frame, and a
 * batch that spans frames is the case it has to get right.
 */
async function writeChunkedAndPaint(page, text) {
  await page.evaluate(async (payload) => {
    const term = window.term;
    term.xterm.options.cursorBlink = false;
    const bytes = new TextEncoder().encode(payload);
    let seed = 1;
    let offset = 0;
    let sinceFrame = 0;
    while (offset < bytes.length) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const size = 1 + (seed % 48);
      term.write(bytes.subarray(offset, Math.min(offset + size, bytes.length)));
      offset += size;
      if (++sinceFrame >= 5) {
        sinceFrame = 0;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }
    await term.flush?.();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, text);
  await page.waitForTimeout(150);
}

/** Assert that no cell holds a colour it was not asked for. */
async function expectNoWrongCells(page, cells, cols, rows, label) {
  const { wrong, badPixels, totalPixels } = await findWrongCells(page, cells, cols, rows);
  const sample = wrong
    .slice(0, 12)
    .map(
      (w) =>
        `  (${w.x},${w.y}) ${w.glyph} ${w.badPixels}px off, top want ${w.wantTop} ` +
        `got ${w.gotTop}, bottom want ${w.wantBottom} got ${w.gotBottom}`,
    )
    .join('\n');
  expect(
    wrong.length,
    `${wrong.length} of ${cells.length} ${label} cells rendered a colour they ` +
      `were not asked for (${badPixels} of ${totalPixels} pixels):\n${sample}`,
  ).toBe(0);
}

/**
 * Compare every cell's two halves against the colours its escape sequence
 * asked for, and return the ones that differ.
 *
 * The whole comparison runs inside the page. A screenshot is the only honest
 * view of what a renderer produced, but moving a full frame's pixels across
 * the browser protocol one number at a time costs tens of seconds, so the
 * frame goes in and only the mismatches come back.
 *
 * Every pixel of each half is checked, not a sample at its centre. The
 * reported artifact is speckle: a handful of stray pixels inside a region that
 * is otherwise the right colour. A one-pixel probe at the middle of each half
 * walks straight past that, and a harness that cannot see the defect returns
 * green for the same reason a fixed one does.
 *
 * The scanned box stops short of the cell edges and of the midline where the
 * two halves meet, because both carry antialiasing that belongs to neither
 * colour.
 */
async function findWrongCells(page, cells, cols, rows, tolerance = TOLERANCE) {
  const screenshot = await page.locator('.xterm-screen').screenshot();
  return page.evaluate(
    async ({ base64, cells, cols, rows, tolerance }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      const { data, width } = ctx.getImageData(0, 0, canvas.width, canvas.height);

      const cellW = canvas.width / cols;
      const cellH = canvas.height / rows;
      const at = (px, py) => {
        const i = (Math.floor(py) * width + Math.floor(px)) * 4;
        return [data[i], data[i + 1], data[i + 2]];
      };
      const off = (got, want) =>
        Math.max(
          Math.abs(got[0] - want[0]),
          Math.abs(got[1] - want[1]),
          Math.abs(got[2] - want[2]),
        );

      // Inset far enough to clear glyph antialiasing at the cell border and at
      // the seam between the two halves, and no further.
      const insetX = Math.max(1, Math.round(cellW * 0.2));
      const insetY = Math.max(1, Math.round(cellH * 0.12));

      // Scan one half's box and report its worst offending pixel, with how
      // many pixels in it were wrong.
      const scan = (cell, want, fromY, toY) => {
        const x0 = Math.floor(cell.x * cellW) + insetX;
        const x1 = Math.ceil((cell.x + 1) * cellW) - insetX;
        const y0 = Math.floor(fromY) + insetY;
        const y1 = Math.ceil(toY) - insetY;
        let worst = 0;
        let worstPixel = null;
        let bad = 0;
        for (let py = y0; py < y1; py++) {
          for (let px = x0; px < x1; px++) {
            const got = at(px, py);
            const delta = off(got, want);
            if (delta > tolerance) bad++;
            if (delta > worst) {
              worst = delta;
              worstPixel = got;
            }
          }
        }
        return { worst, worstPixel, bad, total: Math.max(0, (x1 - x0) * (y1 - y0)) };
      };

      const wrong = [];
      let badPixels = 0;
      let totalPixels = 0;
      for (const cell of cells) {
        const midY = (cell.y + 0.5) * cellH;
        const top = scan(cell, cell.top, cell.y * cellH, midY);
        const bottom = scan(cell, cell.bottom, midY, (cell.y + 1) * cellH);
        badPixels += top.bad + bottom.bad;
        totalPixels += top.total + bottom.total;
        if (top.worst > tolerance || bottom.worst > tolerance) {
          wrong.push({
            x: cell.x,
            y: cell.y,
            glyph: cell.glyph,
            wantTop: cell.top,
            gotTop: top.worstPixel,
            wantBottom: cell.bottom,
            gotBottom: bottom.worstPixel,
            badPixels: top.bad + bottom.bad,
            delta: Math.max(top.worst, bottom.worst),
          });
        }
      }
      return { wrong, badPixels, totalPixels };
    },
    { base64: screenshot.toString('base64'), cells, cols, rows, tolerance },
  );
}

/**
 * Walk a colorscript's own bytes and say what each cell must look like.
 *
 * This is deliberately a second implementation rather than a read of xterm's
 * buffer: asking the emulator what it stored and then checking the screen
 * against that answer cannot catch the emulator storing the wrong thing. The
 * subset here is the whole of what a colorscript emits, which is SGR 0, 38;2
 * and 48;2, half blocks, spaces and newlines.
 */
function parseSprite(text, { defaultFg, defaultBg }, blanks = true) {
  const cells = [];
  let fg = defaultFg;
  let bg = defaultBg;
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\x1b' && text[i + 1] === '[') {
      const end = text.indexOf('m', i);
      if (end === -1) break;
      const params = text.slice(i + 2, end).split(';').map(Number);
      for (let p = 0; p < params.length; p++) {
        if (params[p] === 0) {
          fg = defaultFg;
          bg = defaultBg;
        } else if (params[p] === 39) {
          fg = defaultFg;
        } else if (params[p] === 49) {
          bg = defaultBg;
        } else if ((params[p] === 38 || params[p] === 48) && params[p + 1] === 2) {
          const color = [params[p + 2], params[p + 3], params[p + 4]];
          if (params[p] === 38) fg = color;
          else bg = color;
          p += 4;
        }
      }
      i = end + 1;
      continue;
    }
    if (ch === '\n') {
      y++;
      x = 0;
      i++;
      continue;
    }
    if (ch === '\r') {
      x = 0;
      i++;
      continue;
    }
    if (ch === UPPER || ch === LOWER || (ch === ' ' && blanks)) {
      cells.push({ x, y, ...halves(ch, fg, bg) });
    }
    // Every printable character takes a column, including the ones this does
    // not make a claim about. Skipping them would shift every later cell on
    // the line and turn a correct render into a wall of failures.
    if (ch >= ' ') x++;
    i++;
  }
  return cells;
}

/** The theme colours a default foreground and background resolve to. */
async function defaults(page) {
  return page.evaluate(() => {
    const theme = window.term.xterm.options.theme;
    const rgb = (hex) => [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
    return { defaultFg: rgb(theme.foreground), defaultBg: rgb(theme.background) };
  });
}

const SPRITES = ['bulbasaur', 'charizard', 'venusaur'];

// The colorscript suites boot with sixel on, which loads @xterm/addon-image.
// The addon has no business touching a cell of text, but the report came from
// an application that runs with it loaded, and an addon that hooks the
// renderer is worth holding to that claim rather than assuming it.

for (const renderer of ['webgl', 'canvas', 'dom']) {
  for (const name of SPRITES) {
    test(`${renderer}: the ${name} colorscript renders the colours it asked for`, async ({
      page,
    }) => {
      const cols = 80;
      const rows = 32;
      await boot(page, `?renderer=${renderer}&cols=${cols}&rows=${rows}&sixel=1`);
      const active = await page.evaluate(() => window.term.renderer);
      expect(active, `the ${renderer} renderer did not install`).toBe(renderer);

      const raw = readFileSync(join(ROOT, 'test/fixtures/sprites', `${name}.txt`), 'utf8');
      const cells = parseSprite(raw, await defaults(page));
      expect(cells.length, 'the sprite fixture parsed to nothing').toBeGreaterThan(150);

      // The emulator needs CR before each LF; a colorscript writes into a shell
      // that supplies it through the tty's onlcr.
      await writeAndPaint(page, `\x1b[H${raw.replace(/\r?\n/g, '\r\n')}\x1b[0m`);

      await expectNoWrongCells(page, cells, cols, rows, name);
    });

    test(`${renderer}: the ${name} colorscript survives arriving in transport-sized chunks`, async ({
      page,
    }) => {
      const cols = 80;
      const rows = 32;
      await boot(page, `?renderer=${renderer}&cols=${cols}&rows=${rows}&sixel=1`);

      const raw = readFileSync(join(ROOT, 'test/fixtures/sprites', `${name}.txt`), 'utf8');
      const cells = parseSprite(raw, await defaults(page));

      // The bytes as a pty actually delivers them: split at offsets that fall
      // wherever the read buffer ended, which is inside escape sequences and
      // inside multi-byte characters as often as it is between them. The whole
      // sprite in one write is the one shape a real terminal never sees, and it
      // is the shape a synthetic test reaches for first.
      await writeChunkedAndPaint(page, `\x1b[H${raw.replace(/\r?\n/g, '\r\n')}\x1b[0m`);

      await expectNoWrongCells(page, cells, cols, rows, `${name}, chunked`);
    });

    test(`${renderer}: the ${name} colorscript is still right after it has scrolled`, async ({
      page,
    }) => {
      const cols = 80;
      const rows = 32;
      await boot(page, `?renderer=${renderer}&cols=${cols}&rows=${rows}&sixel=1`);

      const raw = readFileSync(join(ROOT, 'test/fixtures/sprites', `${name}.txt`), 'utf8');
      const cells = parseSprite(raw, await defaults(page));
      const body = `${raw.replace(/\r?\n/g, '\r\n')}\x1b[0m\r\n`;

      // A colorscript printed from a prompt is printed again at every prompt,
      // and the screen scrolls under it. Scrolling is the renderer's
      // incremental path: it reuses what is already drawn and repaints only the
      // rows it believes changed. A sprite written once into a fresh screen
      // never touches that path, which is why writing it once looks clean.
      const height = await page.evaluate(
        async ({ payload, times }) => {
          const term = window.term.xterm;
          term.options.cursorBlink = false;
          for (let n = 0; n < times; n++) {
            await new Promise((resolve) => term.write(payload, resolve));
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return term.buffer.active.cursorY;
        },
        { payload: body, times: 6 },
      );
      await page.waitForTimeout(150);

      // The last copy sits directly above the cursor, and the file's trailing
      // newline puts one blank row between them.
      const spriteRows = body.split('\r\n').length - 1;
      const top = height - spriteRows;
      expect(top, 'the sprite did not end up on screen where the cursor says').toBeGreaterThanOrEqual(
        0,
      );
      const shifted = cells.map((cell) => ({ ...cell, y: cell.y + top }));

      await expectNoWrongCells(page, shifted, cols, rows, `${name}, scrolled`);
    });
  }

  // The stream the report actually came from. `fastfetch --data "$(pokemon-
  // colorscripts ...)"` re-emits the sprite with its own padding and prints
  // system information to the right of it on the same rows. Only the sprite's
  // own half blocks are asserted: the information text is a Nerd Font's
  // private-use glyphs, whose widths this test has no business predicting.
  test(`${renderer}: the sprite keeps its colours inside a fastfetch layout`, async ({ page }) => {
    const cols = 100;
    const rows = 32;
    await boot(page, `?renderer=${renderer}&cols=${cols}&rows=${rows}`);

    const raw = readFileSync(join(ROOT, 'test/fixtures/sprites/fastfetch-bulbasaur.txt'), 'utf8');
    const cells = parseSprite(raw, await defaults(page), false);
    expect(cells.length, 'no half blocks parsed out of the fastfetch capture').toBeGreaterThan(100);

    await writeAndPaint(page, `\x1b[H${raw.replace(/\r?\n/g, '\r\n')}\x1b[0m`);

    await expectNoWrongCells(page, cells, cols, rows, 'fastfetch');
  });

  test(`${renderer}: half-block cells hold the colours the escape sequences asked for`, async ({
    page,
  }) => {
    await boot(page, `?renderer=${renderer}&cols=${COLS}&rows=${ROWS}`);
    const active = await page.evaluate(() => window.term.renderer);
    expect(active, `the ${renderer} renderer did not install`).toBe(renderer);

    const { text, cells } = buildGrid({ cols: COLS, rows: ROWS });
    await writeAndPaint(page, text);

    await expectNoWrongCells(page, cells, COLS, ROWS, 'synthetic grid');
  });

  // The negative control. Everything above reports a count of zero, and a
  // comparison that cannot produce anything else reports zero just as happily
  // against a broken renderer as a working one. This paints the same grid,
  // repaints one cell in a colour the expectation does not know about, and
  // requires that exactly that cell comes back.
  test(`${renderer}: the comparison reports a cell that renders the wrong colour`, async ({
    page,
  }) => {
    await boot(page, `?renderer=${renderer}&cols=${COLS}&rows=${ROWS}`);
    const { text, cells } = buildGrid({ cols: COLS, rows: ROWS });

    const planted = { x: 11, y: 6 };
    // Row and column are one-based in CUP, and the colour is far from anything
    // buildGrid produces, so detection does not rest on the tolerance.
    const overwrite =
      `\x1b[${planted.y + 1};${planted.x + 1}H` + `\x1b[38;2;255;0;255m\x1b[48;2;255;0;255m▀\x1b[0m`;
    await writeAndPaint(page, text + overwrite);

    const { wrong } = await findWrongCells(page, cells, COLS, ROWS);
    expect(
      wrong.map((w) => `${w.x},${w.y}`),
      'the planted cell was not the one and only cell reported',
    ).toEqual([`${planted.x},${planted.y}`]);
    expect(wrong[0].badPixels, 'the planted cell was reported with no wrong pixels').toBeGreaterThan(
      0,
    );
  });
}
