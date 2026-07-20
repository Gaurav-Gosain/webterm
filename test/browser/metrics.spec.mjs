// Text metrics and glyph tiling.
//
// Ported from sip's clienttests, with one change of method. sip derived its
// expectations from the hhea tables of the font it shipped; this package ships
// no fonts at all, so the cell expectation is derived from the font the browser
// actually resolved, measured through canvas measureText. That is still an
// expectation derived from the font rather than from what the code does, which
// is the property that makes the test worth having.
//
// The defect being pinned: a client that multiplies an already gap-inclusive
// line box by a further 1.2 line-height factor renders glyph ink taller than
// the cell, and four stacked rows of U+2588 show a background-coloured seam
// wherever two rows meet.
import { expect, test } from '@playwright/test';

import { boot, readScanline } from './helpers.mjs';

/** xterm's own measured cell geometry, in CSS pixels. */
function cellMetrics(page) {
  return page.evaluate(() => {
    const term = window.term.xterm;
    const core = term._core;
    const dims = core._renderService.dimensions.css.cell;
    const screen = term.element.querySelector('.xterm-screen');
    return {
      fontSize: term.options.fontSize,
      fontFamily: term.options.fontFamily,
      lineHeight: term.options.lineHeight,
      letterSpacing: term.options.letterSpacing,
      cellWidth: dims.width,
      cellHeight: dims.height,
      rows: term.rows,
      cols: term.cols,
      screenWidth: screen.clientWidth,
      screenHeight: screen.clientHeight,
      // The advance the font itself reports at this size, measured
      // independently of anything xterm did.
      measuredAdvance: (() => {
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = `${term.options.fontSize}px ${term.options.fontFamily}`;
        return ctx.measureText('W'.repeat(100)).width / 100;
      })(),
    };
  });
}

test('lineHeight is 1, because the font line box already includes its gap', async ({ page }) => {
  await boot(page);
  const m = await cellMetrics(page);

  expect(m.lineHeight, 'a line-height multiplier double-counts the font line gap').toBe(1);
  expect(m.letterSpacing).toBe(0);
});

test('the cell width is the advance the font reports', async ({ page }) => {
  await boot(page);
  const m = await cellMetrics(page);

  // Half a pixel of slack: the browser rounds a fractional advance onto the
  // device pixel grid.
  expect(
    Math.abs(m.cellWidth - m.measuredAdvance),
    `cell width ${m.cellWidth} against the font's measured advance ${m.measuredAdvance}`,
  ).toBeLessThanOrEqual(0.5);
});

test('the cell height is a line box, not a line box multiplied again', async ({ page }) => {
  await boot(page);
  const m = await cellMetrics(page);

  // A monospace line box runs roughly 1.15 to 1.35 times the em. Anything at or
  // above 1.5 is the 1.2 multiplier having been applied on top of it, which is
  // the exact defect this pins.
  const ratio = m.cellHeight / m.fontSize;
  expect(ratio, `cell height ${m.cellHeight} at font size ${m.fontSize} looks multiplied`).toBeLessThan(1.5);
  expect(ratio).toBeGreaterThan(1.0);
});

test('the cell grid tiles the screen exactly', async ({ page }) => {
  // If cell height times rows does not fill the screen box, the leftover is
  // distributed as sub-pixel drift down the viewport, which is another way a
  // seam appears even when a single cell is the right size.
  await boot(page);
  const m = await cellMetrics(page);

  expect(Math.abs(m.cellHeight * m.rows - m.screenHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(m.cellWidth * m.cols - m.screenWidth)).toBeLessThanOrEqual(1);
});

/**
 * Composite the renderer's canvases and read a vertical strip back.
 *
 * The canvas renderer is pinned because its layers can be composited and read
 * with getImageData; a WebGL context cannot be without preserveDrawingBuffer.
 */
async function sampleColumn(page, text, { columnCell, rows }) {
  return page.evaluate(
    async ({ text, columnCell, rows }) => {
      const t = window.term.xterm;
      t.write('\x1b[H\x1b[2J');
      await new Promise((r) => t.write(text, r));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const canvases = [...document.querySelectorAll('#host canvas')];
      const merged = document.createElement('canvas');
      merged.width = canvases[0].width;
      merged.height = canvases[0].height;
      const ctx = merged.getContext('2d');
      for (const c of canvases) ctx.drawImage(c, 0, 0);

      const dpr = window.devicePixelRatio || 1;
      const dims = t._core._renderService.dimensions.css.cell;
      const cellW = dims.width * dpr;
      const cellH = dims.height * dpr;

      // Down the middle of the requested cell column, spanning `rows` rows and
      // therefore rows-1 row boundaries.
      const x = Math.round(cellW * (columnCell + 0.5));
      const height = Math.round(cellH * rows);
      const data = ctx.getImageData(x, 0, 1, height).data;

      const px = [];
      for (let i = 0; i < data.length; i += 4) px.push([data[i], data[i + 1], data[i + 2]]);
      return { px, cellH, cellW };
    },
    { text, columnCell, rows },
  );
}

// The fixture's default theme.
const BG = [30, 30, 46];
const near = (c, target, tol) =>
  Math.abs(c[0] - target[0]) < tol && Math.abs(c[1] - target[1]) < tol && Math.abs(c[2] - target[2]) < tol;

async function bootCanvas(page) {
  await boot(page, '?renderer=canvas');
  await page.waitForFunction(() => window.term.renderer === 'canvas', null, { timeout: 30_000 });
}

test('stacked block glyphs leave no seam between rows', async ({ page }) => {
  // xterm's canvas and webgl renderers draw box and block characters as vector
  // shapes fitted to the cell rather than rasterising them from the font, so a
  // column through several stacked block rows must be foreground the whole way
  // down.
  await bootCanvas(page);

  const rows = 6;
  const { px } = await sampleColumn(page, Array(rows).fill('█'.repeat(20)).join('\r\n'), {
    columnCell: 3,
    rows,
  });

  const background = px.filter((c) => near(c, BG, 24));
  expect(px.length).toBeGreaterThan(0);
  expect(
    background.length,
    `a background-coloured pixel inside stacked blocks is the seam (${background.length} of ${px.length})`,
  ).toBe(0);
});

test('adjacent block glyphs leave no seam between columns', async ({ page }) => {
  // The vertical seam was the visible one, but xterm floors the cell width to
  // an integer, so a glyph fitted to the wrong box tiles badly across a row as
  // well as down a column.
  await bootCanvas(page);

  const px = await page.evaluate(async () => {
    const t = window.term.xterm;
    t.write('\x1b[H\x1b[2J');
    await new Promise((r) => t.write('█'.repeat(20), r));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const canvases = [...document.querySelectorAll('#host canvas')];
    const merged = document.createElement('canvas');
    merged.width = canvases[0].width;
    merged.height = canvases[0].height;
    const ctx = merged.getContext('2d');
    for (const c of canvases) ctx.drawImage(c, 0, 0);

    const dpr = window.devicePixelRatio || 1;
    const dims = t._core._renderService.dimensions.css.cell;
    // A horizontal strip through the middle of the row, spanning 20 cells and
    // therefore 19 column boundaries.
    const y = Math.round(dims.height * dpr * 0.5);
    const data = ctx.getImageData(0, y, Math.round(dims.width * dpr * 20), 1).data;
    const out = [];
    for (let i = 0; i < data.length; i += 4) out.push([data[i], data[i + 1], data[i + 2]]);
    return out;
  });

  const background = px.filter((c) => near(c, BG, 24));
  expect(px.length).toBeGreaterThan(0);
  expect(
    background.length,
    `a background-coloured pixel between adjacent blocks is a column seam (${background.length} of ${px.length})`,
  ).toBe(0);
});

test('stacked box-drawing verticals leave no seam between rows', async ({ page }) => {
  // The block character is the easy case: it fills its cell in both axes, so a
  // renderer that merely oversized the glyph would still pass. U+2503 draws a
  // stroke that has to meet the cell's top and bottom edge exactly, which is
  // where a rounding error in cell height shows up as a dashed line.
  await bootCanvas(page);

  const rows = 6;
  const { px } = await sampleColumn(page, Array(rows).fill('┃').join('\r\n'), { columnCell: 0, rows });

  const background = px.filter((c) => near(c, BG, 24));
  expect(
    background.length,
    `a gap in a continuous vertical rule is the seam (${background.length} of ${px.length})`,
  ).toBe(0);
});

test('a block-heavy fixture is captured for eyeballing', async ({ page }, testInfo) => {
  // Not an assertion. The seam was found by eye and the pixel checks above only
  // sample two columns, so the run leaves behind an artefact a human can look
  // at: block shades, box-drawing joins and a filled region together.
  await bootCanvas(page);

  await page.evaluate(async () => {
    const t = window.term.xterm;
    const lines = [
      '┏' + '━'.repeat(30) + '┳' + '━'.repeat(20) + '┓',
      ...Array(4).fill('┃' + '█'.repeat(30) + '┃' + '░▒▓'.repeat(6) + ' ┃'),
      '┣' + '━'.repeat(30) + '╋' + '━'.repeat(20) + '┫',
      ...Array(4).fill('┃' + '▄'.repeat(30) + '┃' + '▀'.repeat(20) + '┃'),
      '┗' + '━'.repeat(30) + '┻' + '━'.repeat(20) + '┛',
    ];
    t.write('\x1b[H\x1b[2J');
    await new Promise((r) => t.write(lines.join('\r\n'), r));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });

  // Written to a path rather than attached as a body: the list reporter keeps
  // no report to hold an attachment, so a body would be discarded on success,
  // which is exactly the run where you want the picture.
  const file = testInfo.outputPath('block-and-box-fixture.png');
  await page.locator('#host').screenshot({ path: file });
  await testInfo.attach('block-and-box-fixture.png', { path: file, contentType: 'image/png' });
  console.log(`block and box fixture written to ${file}`);
});

/**
 * The width of the strip down the right edge of the container that a
 * full-screen application's background does not reach, in CSS pixels.
 *
 * Measured from a screenshot rather than from the DOM, because the strip is
 * outside the renderer's canvas and only a picture of the whole container shows
 * it. The application paints every cell in one colour, so anything else at the
 * right edge is space the grid never covered.
 */
async function rightEdgeStrip(page) {
  const paint = [0, 95, 0];
  await page.evaluate(async (colour) => {
    const term = window.term;
    // The alternate screen, every column painted: a full-screen editor.
    let out = `\x1b[?1049h\x1b[2J\x1b[H\x1b[48;2;${colour.join(';')}m`;
    for (let row = 1; row <= term.rows; row++) out += `\x1b[${row};1H${' '.repeat(term.cols)}`;
    term.write(out);
    await term.flush();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, paint);

  const shot = await page.locator('#host').screenshot();
  const { width, row } = await readScanline(page, shot);
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);

  const isPaint = (x) =>
    row[x * 4] === paint[0] && row[x * 4 + 1] === paint[1] && row[x * 4 + 2] === paint[2];
  let x = width - 1;
  while (x >= 0 && !isPaint(x)) x--;
  return (width - 1 - x) / dpr;
}

test('the grid fills the container, leaving no strip down the right edge', async ({ page }) => {
  // The fit reserved room for a scrollbar that floats over the content and
  // never takes that room, so a band of terminal background sat down the right
  // edge of every full-screen application. It reads as a vertical line whenever
  // the application's own background differs from the theme's, which for an
  // editor it almost always does.
  //
  // A grid of whole cells cannot always land exactly on the container's edge,
  // so the bound is one cell: less than that is the remainder no integer grid
  // can avoid, more than that is space that was reserved and wasted.
  await bootCanvas(page);
  const cellWidth = await page.evaluate(
    () => window.term.xterm._core._renderService.dimensions.css.cell.width,
  );

  const strip = await rightEdgeStrip(page);
  expect(
    strip,
    `${strip}px of the container is right of the grid, wider than one ${cellWidth}px cell`,
  ).toBeLessThan(cellWidth);
});

test('the renderer preference is honoured and reported', async ({ page }) => {
  await boot(page, '?renderer=dom');
  expect(await page.evaluate(() => window.term.renderer)).toBe('dom');
  // The DOM renderer is xterm's own default and loads no addon, so there should
  // be no renderer canvas at all.
  expect(await page.locator('#host canvas').count()).toBe(0);
});

test('the atlas cell is the nearest device pixel to the advance, not the floor', async ({
  page,
}) => {
  // Both atlas renderers compute device.char.width as
  // Math.floor(advance * dpr), and the atlas rasterises every glyph into a box
  // of exactly that width, so on a fractional advance every column comes out up
  // to a device pixel narrow and glyphs drawn to the full advance -- powerline
  // separators, box and block glyphs, Nerd Font icons -- lose their right edge.
  // src/cell-metrics.ts corrects it by giving the renderer a char size service
  // that reports an advance floors to the rounded device width. See that file
  // for why letterSpacing is not a substitute and why round beats ceil.
  await bootCanvas(page);
  const m = await page.evaluate(() => {
    const core = window.term.xterm._core;
    return {
      dpr: window.devicePixelRatio,
      advanceCss: core._charSizeService.width,
      deviceCellWidth: core._renderService.dimensions.device.cell.width,
    };
  });

  // The core's own service must still report the real advance: layout,
  // selection and the kitty overlay all measure through it.
  const exact = m.advanceCss * m.dpr;
  expect(m.deviceCellWidth).toBe(Math.round(exact));
  expect(Math.abs(m.deviceCellWidth - exact)).toBeLessThanOrEqual(0.5);
});
