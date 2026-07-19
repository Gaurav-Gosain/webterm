// Unicode placeholder placements (U=1), the mode yazi uses.
//
// A client in this mode transmits the image with U=1, which places it
// virtually rather than at the cursor, and then writes a grid of U+10EEEE
// characters whose row and column are carried in combining diacritics and
// whose image id is carried in the foreground colour. The terminal draws the
// image over exactly those cells. No font has a glyph for U+10EEEE, so any
// cell of that grid the image fails to cover shows as a coloured tofu box.
//
// The invariant every test here is built around is the one the user sees: once
// the image is on screen, not one placeholder cell of the reserved grid is
// visible. These assertions are taken from a screenshot of the live page
// rather than from the overlay's own numbers, because the overlay's numbers
// agreeing with themselves is exactly the failure mode being guarded against.
import { expect, test } from '@playwright/test';

import { apc, boot, solidRgba, toBase64 } from './helpers.mjs';

/**
 * The row/column diacritics, from kitty's rowcolumn-diacritics.txt. The index
 * of a code point in this list is the row or column it encodes.
 */
const DIACRITICS = [
  0x305, 0x30d, 0x30e, 0x310, 0x312, 0x33d, 0x33e, 0x33f, 0x346, 0x34a, 0x34b, 0x34c, 0x350, 0x351,
  0x352, 0x357, 0x35b, 0x363, 0x364, 0x365, 0x366, 0x367, 0x368, 0x369, 0x36a, 0x36b, 0x36c, 0x36d,
  0x36e, 0x36f, 0x483, 0x484, 0x485, 0x486, 0x487, 0x592, 0x593, 0x594, 0x595, 0x597, 0x598, 0x599,
  0x59c, 0x59d, 0x59e, 0x59f, 0x5a0, 0x5a1, 0x5a8, 0x5a9, 0x5ab, 0x5ac, 0x5af, 0x5c4, 0x610, 0x611,
  0x612, 0x613, 0x614, 0x615, 0x616, 0x617, 0x657, 0x658, 0x659, 0x65a, 0x65b, 0x65d, 0x65e, 0x6d6,
  0x6d7, 0x6d8, 0x6d9, 0x6da, 0x6db, 0x6dc, 0x6df, 0x6e0, 0x6e1, 0x6e2, 0x6e4, 0x6e7, 0x6e8, 0x6eb,
  0x6ec, 0x730, 0x732, 0x733, 0x735, 0x736, 0x73a, 0x73d, 0x73f, 0x740, 0x741, 0x743, 0x745, 0x747,
  0x749, 0x74a, 0x7eb, 0x7ec, 0x7ed, 0x7ee, 0x7ef, 0x7f0, 0x7f1, 0x7f3, 0x816, 0x817, 0x818, 0x819,
  0x81b, 0x81c, 0x81d, 0x81e, 0x81f, 0x820, 0x821, 0x822, 0x823, 0x825, 0x826, 0x827, 0x829, 0x82a,
  0x82b, 0x82c, 0x82d, 0x951, 0x953, 0x954, 0xf82, 0xf83, 0xf86, 0xf87, 0x135d, 0x135e, 0x135f,
  0x17dd, 0x193a, 0x1a17, 0x1a75, 0x1a76, 0x1a77, 0x1a78, 0x1a79, 0x1a7a, 0x1a7b, 0x1a7c, 0x1b6b,
  0x1b6d, 0x1b6e, 0x1b6f, 0x1b70, 0x1b71, 0x1b72, 0x1b73, 0x1cd0, 0x1cd1, 0x1cd2, 0x1cda, 0x1cdb,
  0x1ce0, 0x1dc0, 0x1dc1, 0x1dc3, 0x1dc4, 0x1dc5, 0x1dc6, 0x1dc7, 0x1dc8, 0x1dc9, 0x1dcb, 0x1dcc,
  0x1dd1, 0x1dd2, 0x1dd3, 0x1dd4, 0x1dd5, 0x1dd6, 0x1dd7, 0x1dd8, 0x1dd9, 0x1dda, 0x1ddb, 0x1ddc,
  0x1ddd, 0x1dde, 0x1ddf, 0x1de0, 0x1de1, 0x1de2, 0x1de3, 0x1de4, 0x1de5, 0x1de6, 0x1dfe, 0x20d0,
  0x20d1, 0x20d4, 0x20d5, 0x20d6, 0x20d7, 0x20db, 0x20dc, 0x20e1, 0x20e7, 0x20e9, 0x20f0, 0x2cef,
  0x2cf0, 0x2cf1, 0x2de0, 0x2de1, 0x2de2, 0x2de3, 0x2de4, 0x2de5, 0x2de6, 0x2de7, 0x2de8, 0x2de9,
  0x2dea, 0x2deb, 0x2dec, 0x2ded, 0x2dee, 0x2def, 0x2df0, 0x2df1, 0x2df2, 0x2df3, 0x2df4, 0x2df5,
  0x2df6, 0x2df7, 0x2df8, 0x2df9, 0x2dfa, 0x2dfb, 0x2dfc, 0x2dfd, 0x2dfe, 0x2dff, 0xa66f, 0xa67c,
  0xa67d, 0xa6f0, 0xa6f1, 0xa8e0, 0xa8e1, 0xa8e2, 0xa8e3, 0xa8e4, 0xa8e5, 0xa8e6, 0xa8e7, 0xa8e8,
  0xa8e9, 0xa8ea, 0xa8eb, 0xa8ec, 0xa8ed, 0xa8ee, 0xa8ef, 0xa8f0, 0xa8f1, 0xaab0, 0xaab2, 0xaab3,
  0xaab7, 0xaab8, 0xaabe, 0xaabf, 0xaac1, 0xfe20, 0xfe21, 0xfe22, 0xfe23, 0x10a0f, 0x10a38, 0x1d185,
  0x1d186, 0x1d187, 0x1d188, 0x1d189, 0x1d1aa, 0x1d1ab, 0x1d1ac, 0x1d1ad, 0x1d242, 0x1d243, 0x1d244,
];

const PLACEHOLDER = '\u{10EEEE}';

/**
 * The image id yazi and kitten icat put in the foreground colour is an
 * arbitrary 24-bit number. A green one is used here so a visible placeholder
 * is unmistakable against a red image on the fixture's dark background, which
 * is exactly how the bug was first reported.
 */
const IMAGE_ID = 0x00c800;
const ID_RGB = [(IMAGE_ID >> 16) & 0xff, (IMAGE_ID >> 8) & 0xff, IMAGE_ID & 0xff];

/**
 * The cell box the sending application believed in.
 *
 * A real client learns this from `CSI 16 t` or from the window pixel size, and
 * it is not the browser's cell box. yazi was captured asking for 8 by 16 and
 * sizing its transmission to exactly that, so the numbers here are its
 * numbers. The mismatch is the point: the reserved grid is whatever the client
 * says it is, and the terminal has to cover it whatever its own arithmetic
 * says.
 */
const SENDER_CELL = { width: 8, height: 16 };

/** The placeholder grid yazi writes: `ESC [ row ; col H` then one row of cells. */
function placeholderGrid({ cols, rows, originRow, originCol, id = IMAGE_ID }) {
  const rgb = [(id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff];
  const out = [`\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`];
  for (let r = 0; r < rows; r++) {
    out.push(`\x1b[${originRow + r + 1};${originCol + 1}H`);
    for (let c = 0; c < cols; c++) {
      out.push(PLACEHOLDER, String.fromCodePoint(DIACRITICS[r]), String.fromCodePoint(DIACRITICS[c]));
    }
  }
  out.push('\x1b[0m');
  return out.join('');
}

/** yazi's transmission: a=T with U=1 and C=1, raw RGB, no `c` or `r`. */
function transmitVirtual({ cols, rows, colour = [220, 30, 30], id = IMAGE_ID }) {
  const width = cols * SENDER_CELL.width;
  const height = rows * SENDER_CELL.height;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = colour[0];
    rgb[i + 1] = colour[1];
    rgb[i + 2] = colour[2];
  }
  return apc(`a=T,q=2,C=1,U=1,f=24,s=${width},v=${height},i=${id},t=d`, toBase64(rgb));
}

/** The cell box the terminal itself is using, in CSS pixels. */
async function cellPixels(page) {
  return page.evaluate(() => {
    const cell = window.term.xterm._core._renderService.dimensions.css.cell;
    return { width: cell.width, height: cell.height };
  });
}

/**
 * Scan a screenshot of the reserved grid for any pixel carrying the image id's
 * colour. A placeholder glyph is drawn in that colour and nothing else on the
 * page is, so one such pixel is one visible placeholder.
 */
async function idColouredPixels(page, rect) {
  const png = await page.screenshot({
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  });
  return page.evaluate(
    async ({ bytes, id }) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const hits = [];
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        // Antialiased glyph edges land between the id colour and whatever is
        // behind them, so this looks for the id's hue rather than its exact
        // value: green clearly dominant, red and blue clearly not.
        if (g > 70 && g > r + 40 && g > b + 40) {
          const pixel = i / 4;
          hits.push({ x: pixel % canvas.width, y: Math.floor(pixel / canvas.width), rgb: [r, g, b] });
        }
      }
      return { width: canvas.width, height: canvas.height, count: hits.length, sample: hits.slice(0, 8), id };
    },
    { bytes: [...png], id: ID_RGB },
  );
}

/**
 * The reserved grid inflated by a cell on every side, in CSS pixels.
 *
 * A tofu box is wider than the cell it stands in, so an uncovered placeholder
 * shows up outside the grid as well as inside it. Checking only the grid
 * misses exactly the artefact that was reported, which appeared at the image's
 * right edge rather than within it. Nothing else is written near the grid in
 * these tests, so the margin has to be clean.
 */
function region(grid, cell, part = {}) {
  const left = part.left ?? 0;
  const top = part.top ?? 0;
  const cols = part.cols ?? grid.cols;
  const rows = part.rows ?? grid.rows;
  return {
    x: Math.max(0, (grid.originCol + left - 1) * cell.width),
    y: Math.max(0, (grid.originRow + top - 1) * cell.height),
    width: (cols + 2) * cell.width,
    height: (rows + 2) * cell.height,
  };
}

/** Write a sequence and let the overlay settle. */
async function write(page, sequence) {
  await page.evaluate(async (data) => {
    window.term.write(data);
    await window.term.flush();
  }, sequence);
  await page.waitForFunction(() => window.term.kitty.placementCount > 0, null, { timeout: 10_000 });
  // One more frame so the overlay has repositioned against the written cells.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

const GRID = { cols: 36, rows: 12, originRow: 2, originCol: 5 };

test('an image in unicode placeholder mode covers every cell of the reserved grid', async ({
  page,
}) => {
  await boot(page, '?cols=100&rows=30');
  await write(
    page,
    `\x1b[2J\x1b[H${transmitVirtual(GRID)}${placeholderGrid(GRID)}`,
  );

  const cell = await cellPixels(page);
  const rect = region(GRID, cell);

  // The measurement the bug is about: how many columns and rows the overlay
  // decided to cover, against how many the application reserved.
  const covered = await page.evaluate(() => {
    const kitty = window.term.kitty;
    const anchored = [...kitty.placements.values()].map((p) => ({
      cols: p.cols,
      rows: p.rows,
      cellX: p.cellX,
    }));
    const runs = kitty.virtualRuns.map((r) => ({
      cols: r.cols,
      rows: r.rows,
      cellX: r.cellX,
      screenRow: r.screenRow,
    }));
    return { anchored, runs };
  });
  console.log(
    `reserved ${GRID.cols}x${GRID.rows} at column ${GRID.originCol} row ${GRID.originRow}; ` +
      `terminal cell ${cell.width}x${cell.height}, sender cell ${SENDER_CELL.width}x${SENDER_CELL.height}; ` +
      `cursor-anchored placements ${JSON.stringify(covered.anchored)}; ` +
      `placeholder runs ${JSON.stringify(covered.runs)}`,
  );
  // The reserved grid is one rectangle, so it must come back as one run
  // covering exactly it. Anything else means the overlay invented geometry.
  expect(covered.anchored).toEqual([]);
  expect(covered.runs).toEqual([
    { cols: GRID.cols, rows: GRID.rows, cellX: GRID.originCol, screenRow: GRID.originRow },
  ]);

  const found = await idColouredPixels(page, rect);
  expect(
    found.count,
    `${found.count} pixels of the placeholder colour are visible inside the reserved ` +
      `${GRID.cols}x${GRID.rows} grid; first at ${JSON.stringify(found.sample)}`,
  ).toBe(0);
});

test('the reserved grid is covered when it is flush against the right edge', async ({ page }) => {
  // The last column of the screen is where a floored width loses its column
  // silently: there is no column after it to spill into.
  await boot(page, '?cols=100&rows=30');
  const grid = { cols: 20, rows: 6, originRow: 4, originCol: 80 };
  await write(page, `\x1b[2J\x1b[H${transmitVirtual(grid)}${placeholderGrid(grid)}`);

  const cell = await cellPixels(page);
  const found = await idColouredPixels(page, region(grid, cell));
  expect(found.count, `placeholder pixels visible: ${JSON.stringify(found.sample)}`).toBe(0);
});

test('the bottom row and the left column of the reserved grid are covered', async ({ page }) => {
  await boot(page, '?cols=100&rows=30');
  const grid = { cols: 24, rows: 8, originRow: 0, originCol: 0 };
  await write(page, `\x1b[2J\x1b[H${transmitVirtual(grid)}${placeholderGrid(grid)}`);

  const cell = await cellPixels(page);
  // The bottom row and the left column on their own, so a failure names the
  // edge rather than the whole rectangle.
  const bottom = await idColouredPixels(page, region(grid, cell, { top: grid.rows - 1, rows: 1 }));
  expect(bottom.count, `bottom row: ${JSON.stringify(bottom.sample)}`).toBe(0);

  const left = await idColouredPixels(page, region(grid, cell, { cols: 1 }));
  expect(left.count, `left column: ${JSON.stringify(left.sample)}`).toBe(0);

  const right = await idColouredPixels(page, region(grid, cell, { left: grid.cols - 1, cols: 1 }));
  expect(right.count, `right column: ${JSON.stringify(right.sample)}`).toBe(0);

  const top = await idColouredPixels(page, region(grid, cell, { rows: 1 }));
  expect(top.count, `top row: ${JSON.stringify(top.sample)}`).toBe(0);
});

test('a placeholder grid written before its image arrives is covered once it does', async ({
  page,
}) => {
  // yazi redraws the placeholder grid on every frame and only re-transmits
  // when the preview changes, so the grid routinely exists on screen before
  // the bytes for it do.
  await boot(page, '?cols=100&rows=30');
  const grid = { cols: 18, rows: 5, originRow: 3, originCol: 10 };

  await page.evaluate(async (data) => {
    window.term.write(data);
    await window.term.flush();
  }, `\x1b[2J\x1b[H${placeholderGrid(grid)}`);
  await write(page, transmitVirtual(grid));

  const cell = await cellPixels(page);
  const found = await idColouredPixels(page, region(grid, cell));
  expect(found.count, `placeholder pixels visible: ${JSON.stringify(found.sample)}`).toBe(0);
});

test('a placeholder grid whose image never arrives draws nothing at all', async ({ page }) => {
  // The placeholder character has no glyph in any shipping font, so a terminal
  // that leaves it to the text renderer fills the grid with tofu whenever the
  // image is missing, evicted or still in flight.
  await boot(page, '?cols=100&rows=30');
  const grid = { cols: 16, rows: 4, originRow: 6, originCol: 12 };
  await page.evaluate(async (data) => {
    window.term.write(data);
    await window.term.flush();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, `\x1b[2J\x1b[H${placeholderGrid(grid)}`);

  const cell = await cellPixels(page);
  const found = await idColouredPixels(page, region(grid, cell));
  expect(found.count, `tofu drawn for an absent image: ${JSON.stringify(found.sample)}`).toBe(0);
});

test('a virtual placement does not move the cursor', async ({ page }) => {
  // U=1 is explicit that the placement is virtual: the cursor stays put and
  // the application decides where the grid goes.
  await boot(page, '?cols=100&rows=30');
  const before = await page.evaluate(() => {
    window.term.write('\x1b[2J\x1b[10;20H');
    return window.term.flush().then(() => ({
      x: window.term.xterm.buffer.active.cursorX,
      y: window.term.xterm.buffer.active.cursorY,
    }));
  });
  await page.evaluate(async (data) => {
    window.term.write(data);
    await window.term.flush();
  }, transmitVirtual({ cols: 10, rows: 4 }));
  const after = await page.evaluate(() => ({
    x: window.term.xterm.buffer.active.cursorX,
    y: window.term.xterm.buffer.active.cursorY,
  }));
  expect(after).toEqual(before);
});

test('the grid scrolls with its text and stays covered', async ({ page }) => {
  await boot(page, '?cols=100&rows=30');
  const grid = { cols: 20, rows: 6, originRow: 20, originCol: 4 };
  await write(page, `\x1b[2J\x1b[H${transmitVirtual(grid)}${placeholderGrid(grid)}`);

  // Push the grid up by five rows.
  await page.evaluate(async () => {
    window.term.write('\x1b[30;1H' + '\n'.repeat(5));
    await window.term.flush();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });

  const cell = await cellPixels(page);
  const found = await idColouredPixels(page, region({ ...grid, originRow: grid.originRow - 5 }, cell));
  expect(found.count, `after scrolling: ${JSON.stringify(found.sample)}`).toBe(0);
});
