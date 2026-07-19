// The kitty graphics overlay.
//
// This is the package's headline feature and it rests on one upstream API,
// term.parser.registerApcHandler. @xterm/xterm 6.0.0 shipped without it and
// 6.1.0 restored it, so the first test here fails loudly on a version bump
// rather than leaving every graphics test to fail as a mystery.
import { expect, test } from '@playwright/test';

import { apc, boot, solidRgba, toBase64 } from './helpers.mjs';

/** Transmit a solid RGBA image under `id` and place it at the cursor. */
function transmitAndPlace(id, width, height, colour, extra = '') {
  const payload = toBase64(solidRgba(width, height, colour));
  return [
    apc(`a=t,f=32,i=${id},s=${width},v=${height},t=d`, payload),
    apc(`a=p,i=${id}${extra ? `,${extra}` : ''}`),
  ].join('');
}

/** Wait for the overlay to hold `count` placements, or fail with what it has. */
async function waitForPlacements(page, count) {
  await page.waitForFunction(
    (n) => window.term.kitty && window.term.kitty.placementCount === n,
    count,
    { timeout: 10_000 },
  );
}

test('the running xterm build exposes the APC parser the overlay needs', async ({ page }) => {
  await boot(page);
  const supported = await page.evaluate(
    () => typeof window.term.xterm.parser.registerApcHandler === 'function',
  );
  expect(
    supported,
    'this @xterm/xterm has no parser.registerApcHandler, so kitty graphics cannot work at all',
  ).toBe(true);
  expect(await page.evaluate(() => !!window.term.kitty)).toBe(true);
});

test('a transmitted image is placed as a canvas in the overlay', async ({ page }) => {
  await boot(page);

  await page.evaluate(async (sequence) => {
    window.term.write(sequence);
    await window.term.flush();
  }, transmitAndPlace(1, 32, 32, [255, 0, 0]));
  await waitForPlacements(page, 1);

  const canvas = page.locator('.webterm-kitty-overlay canvas');
  await expect(canvas).toHaveCount(1);
  const box = await canvas.boundingBox();
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
});

test('the placed pixels are the colour that was transmitted', async ({ page }) => {
  await boot(page);

  await page.evaluate(async (sequence) => {
    window.term.write(sequence);
    await window.term.flush();
  }, transmitAndPlace(2, 16, 16, [0, 200, 100]));
  await waitForPlacements(page, 1);

  const pixel = await page.evaluate(() => {
    const canvas = document.querySelector('.webterm-kitty-overlay canvas');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1)
      .data;
    return [data[0], data[1], data[2], data[3]];
  });

  expect(pixel[0]).toBeLessThan(30);
  expect(pixel[1]).toBeGreaterThan(170);
  expect(pixel[2]).toBeGreaterThan(70);
  expect(pixel[3]).toBe(255);
});

test('a chunked transmission assembles into one image', async ({ page }) => {
  await boot(page);

  await page.evaluate(
    async ({ chunks, place }) => {
      for (const chunk of chunks) window.term.write(chunk);
      window.term.write(place);
      await window.term.flush();
    },
    (() => {
      const payload = toBase64(solidRgba(16, 16, [10, 20, 240]));
      // Base64 splits on a 4-character boundary, as a real sender does.
      const size = Math.ceil(payload.length / 3 / 4) * 4;
      const parts = [];
      for (let i = 0; i < payload.length; i += size) parts.push(payload.slice(i, i + size));
      const chunks = parts.map((part, index) =>
        index === 0
          ? apc(`a=t,f=32,i=3,s=16,v=16,t=d,m=1`, part)
          : apc(`a=t,i=3,m=${index === parts.length - 1 ? 0 : 1}`, part),
      );
      return { chunks, place: apc('a=p,i=3') };
    })(),
  );
  await waitForPlacements(page, 1);

  const pixel = await page.evaluate(() => {
    const canvas = document.querySelector('.webterm-kitty-overlay canvas');
    const data = canvas.getContext('2d').getImageData(2, 2, 1, 1).data;
    return [data[0], data[1], data[2]];
  });
  expect(pixel[2]).toBeGreaterThan(200);
});

test('a place that arrives before the decode settles is still honoured', async ({ page }) => {
  // createImageBitmap is asynchronous and a sender emits a=t then a=p back to
  // back, so the place lands on the parser before the bitmap does. This is the
  // deferred-placement queue.
  await boot(page);

  await page.evaluate(async (sequence) => {
    // Written as one string so both sequences are parsed in the same pass,
    // which is exactly the race the queue exists for.
    window.term.write(sequence);
    await window.term.flush();
  }, transmitAndPlace(4, 24, 24, [200, 200, 0]));

  await waitForPlacements(page, 1);
  expect(await page.locator('.webterm-kitty-overlay canvas').count()).toBe(1);
});

test('re-placing the same image and placement id moves the canvas rather than stacking', async ({
  page,
}) => {
  await boot(page);

  const positions = await page.evaluate(async ({ first, second }) => {
    window.term.write(first);
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 300));
    const before = document.querySelector('.webterm-kitty-overlay canvas').style.transform;

    window.term.write(second);
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 300));
    const after = document.querySelector('.webterm-kitty-overlay canvas').style.transform;

    return {
      before,
      after,
      canvases: document.querySelectorAll('.webterm-kitty-overlay canvas').length,
    };
  }, {
    first: transmitAndPlace(5, 16, 16, [255, 0, 255]),
    // Move the cursor, then place the same image and placement id again.
    second: `\x1b[10;20H${apc('a=p,i=5,p=1')}`,
  });

  expect(positions.canvases).toBe(1);
  expect(positions.after).not.toBe(positions.before);
});

test('a re-transmit under an existing id refreshes what the placement shows', async ({ page }) => {
  // This is what makes per-frame video work: the sender keeps i= constant and
  // refreshes the data, and every placement referencing the id must repaint.
  await boot(page);

  const colours = await page.evaluate(async ({ first, second }) => {
    const sample = () => {
      const canvas = document.querySelector('.webterm-kitty-overlay canvas');
      const data = canvas.getContext('2d').getImageData(2, 2, 1, 1).data;
      return [data[0], data[1], data[2]];
    };

    window.term.write(first);
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 300));
    const before = sample();

    window.term.write(second);
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 300));
    return { before, after: sample(), canvases: document.querySelectorAll('.webterm-kitty-overlay canvas').length };
  }, {
    first: transmitAndPlace(6, 16, 16, [255, 0, 0]),
    second: apc('a=t,f=32,i=6,s=16,v=16,t=d', toBase64(solidRgba(16, 16, [0, 0, 255]))),
  });

  expect(colours.canvases).toBe(1);
  expect(colours.before[0]).toBeGreaterThan(200);
  expect(colours.after[2]).toBeGreaterThan(200);
  expect(colours.after[0]).toBeLessThan(60);
});

test('a placement is deleted by placement id without discarding the image', async ({ page }) => {
  await boot(page);

  const counts = await page.evaluate(async ({ place, remove, again }) => {
    window.term.write(place);
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 300));
    const placed = window.term.kitty.placementCount;

    window.term.write(remove);
    await window.term.flush();
    const deleted = window.term.kitty.placementCount;
    const imagesAfterDelete = window.term.kitty.imageCount;

    // The image bytes survived, so a re-place works with no re-transmit.
    window.term.write(again);
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 200));
    return { placed, deleted, imagesAfterDelete, replaced: window.term.kitty.placementCount };
  }, {
    place: transmitAndPlace(7, 16, 16, [0, 255, 0], 'p=3'),
    remove: apc('a=d,d=p,i=7,p=3'),
    again: apc('a=p,i=7,p=3'),
  });

  expect(counts.placed).toBe(1);
  expect(counts.deleted).toBe(0);
  expect(counts.imagesAfterDelete).toBe(1);
  expect(counts.replaced).toBe(1);
});

test('an uppercase delete by image id frees the image data as well', async ({ page }) => {
  await boot(page);

  const counts = await page.evaluate(async ({ place, remove }) => {
    window.term.write(place);
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 300));
    window.term.write(remove);
    await window.term.flush();
    return {
      placements: window.term.kitty.placementCount,
      images: window.term.kitty.imageCount,
    };
  }, {
    place: transmitAndPlace(8, 16, 16, [123, 45, 67]),
    remove: apc('a=d,d=I,i=8'),
  });

  expect(counts.placements).toBe(0);
  expect(counts.images).toBe(0);
});

test('delete all clears every placement', async ({ page }) => {
  await boot(page);

  const after = await page.evaluate(async ({ a, b, clear }) => {
    window.term.write(a + '\r\n' + b);
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 400));
    const before = window.term.kitty.placementCount;
    window.term.write(clear);
    await window.term.flush();
    return { before, after: window.term.kitty.placementCount };
  }, {
    a: transmitAndPlace(9, 16, 16, [1, 2, 3]),
    b: transmitAndPlace(10, 16, 16, [4, 5, 6]),
    clear: apc('a=d,d=a'),
  });

  expect(after.before).toBe(2);
  expect(after.after).toBe(0);
});

test('a scrollback-anchored placement scrolls away with its text', async ({ page }) => {
  // The default. An image belongs to the row that introduced it, which is what
  // a shell running an image viewer expects.
  await boot(page);

  const result = await page.evaluate(async (sequence) => {
    window.term.write(sequence);
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 300));
    const canvas = document.querySelector('.webterm-kitty-overlay canvas');
    const before = canvas.style.transform;

    // Push it well past the top of the viewport.
    window.term.write('\r\n'.repeat(window.term.rows + 10));
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 300));
    return { before, after: canvas.style.transform, display: canvas.style.display };
  }, transmitAndPlace(11, 16, 16, [90, 90, 90]));

  expect(result.after).not.toBe(result.before);
  expect(result.display).toBe('none');
});

test('a viewport-anchored placement stays pinned to the visible grid', async ({ page }) => {
  // What a compositor needs: it re-emits every placement each frame and never
  // uses scrollback, so an image must not be parked in history by a newline.
  await boot(page, '?anchor=viewport');

  const result = await page.evaluate(async (sequence) => {
    window.term.write(sequence);
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 300));
    const canvas = document.querySelector('.webterm-kitty-overlay canvas');
    const before = canvas.style.transform;

    window.term.write('\r\n'.repeat(window.term.rows + 10));
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 300));
    return { before, after: canvas.style.transform, display: canvas.style.display };
  }, transmitAndPlace(12, 16, 16, [90, 90, 90]));

  expect(result.after).toBe(result.before);
  expect(result.display).toBe('block');
});

test('a zlib compressed transmission is inflated', async ({ page }) => {
  await boot(page);

  // Compressed in the page with CompressionStream, so the fixture and the
  // overlay agree on the wire format rather than on a hardcoded blob.
  await page.evaluate(async () => {
    const raw = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < raw.length; i += 4) {
      raw[i] = 0;
      raw[i + 1] = 0;
      raw[i + 2] = 255;
      raw[i + 3] = 255;
    }
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
    const deflated = new Uint8Array(await new Response(stream).arrayBuffer());
    let binary = '';
    for (const byte of deflated) binary += String.fromCharCode(byte);
    const payload = btoa(binary);

    window.term.write(`\x1b_Ga=t,f=32,o=z,i=13,s=16,v=16,t=d;${payload}\x1b\\`);
    window.term.write('\x1b_Ga=p,i=13\x1b\\');
    await window.term.flush();
  });
  await waitForPlacements(page, 1);

  const pixel = await page.evaluate(() => {
    const canvas = document.querySelector('.webterm-kitty-overlay canvas');
    const data = canvas.getContext('2d').getImageData(2, 2, 1, 1).data;
    return [data[0], data[1], data[2]];
  });
  expect(pixel[2]).toBeGreaterThan(200);
});

test('an unknown action and a malformed payload are swallowed, not printed', async ({ page }) => {
  await boot(page);

  const screen = await page.evaluate(async () => {
    window.term.write('\x1b_Ga=Z,i=1;bm90aGluZw==\x1b\\');
    window.term.write('\x1b_Ga=t,f=32,i=99,s=4,v=4,t=d;!!!not base64!!!\x1b\\');
    window.term.write('after');
    await window.term.flush();
    const buffer = window.term.xterm.buffer.active;
    return buffer.getLine(buffer.cursorY).translateToString(true);
  });

  // Nothing from the APC leaked into the cell buffer.
  expect(screen).toBe('after');
});

test('disposing removes the overlay from the container', async ({ page }) => {
  await boot(page);

  const after = await page.evaluate(async (sequence) => {
    window.term.write(sequence);
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 300));
    const before = document.querySelectorAll('.webterm-kitty-overlay').length;
    window.term.dispose();
    return { before, after: document.querySelectorAll('.webterm-kitty-overlay').length };
  }, transmitAndPlace(14, 16, 16, [7, 7, 7]));

  expect(after.before).toBe(1);
  expect(after.after).toBe(0);
});

// --- cursor advance and cell reservation -----------------------------------
//
// The protocol: "After placing an image on the screen the cursor must be moved
// to the right by the number of cols in the image placement rectangle and down
// by the number of rows". kitten icat depends on it entirely, emitting only a
// trailing CR LF of its own, so a terminal that skips it draws the next prompt
// straight through the image. These assert the cell buffer, not the canvas.

/** The cell box the overlay sizes placements against. */
async function cellBox(page) {
  return page.evaluate(() => {
    const cell = window.term.xterm._core._renderService.dimensions.css.cell;
    return { width: cell.width, height: cell.height };
  });
}

test('placing an image advances the cursor past it, in rows and columns', async ({ page }) => {
  await boot(page);
  const cell = await cellBox(page);
  const [w, h] = [200, 120];

  const result = await page.evaluate(async (sequence) => {
    const buf = () => window.term.xterm.buffer.active;
    window.term.write('\x1b[5;3H');
    await window.term.flush();
    const before = { y: buf().cursorY, x: buf().cursorX };
    window.term.write(sequence);
    await window.term.flush();
    return { before, after: { y: buf().cursorY, x: buf().cursorX } };
  }, transmitAndPlace(20, w, h, [10, 120, 200]));

  // Derived from the transmitted pixels against the cell box: the sender sent
  // no c or r, exactly as icat does.
  const rows = Math.ceil(h / cell.height);
  const cols = Math.ceil(w / cell.width);
  expect(result.after.y - result.before.y).toBe(rows);
  expect(result.after.x - result.before.x).toBe(cols);
});

test('the rows an image occupies are consumed, so following text lands below it', async ({
  page,
}) => {
  // The maintainer's case, reduced: icat emits CR, a column offset, the image,
  // then CR LF, and the shell prompt follows in the same stream. Before the
  // fix the prompt was written straight over the image.
  await boot(page);
  const cell = await cellBox(page);
  const [w, h] = [160, 100];
  const rows = Math.ceil(h / cell.height);

  const result = await page.evaluate(async (sequence) => {
    const buf = () => window.term.xterm.buffer.active;
    window.term.write('\x1b[1;1H');
    await window.term.flush();
    // One chunk, as it arrives from the pty: image then CR LF then the prompt.
    window.term.write(`\r\x1b[10C${sequence}\r\nPROMPT$ `);
    await window.term.flush();
    const lines = [];
    for (let i = 0; i < 12; i++) lines.push(buf().getLine(i)?.translateToString(true) ?? '');
    return { lines, cursorY: buf().cursorY };
  }, transmitAndPlace(21, w, h, [200, 30, 30]));

  // The prompt is below the image, and every row the image covers is untouched.
  const promptRow = result.lines.findIndex((l) => l.startsWith('PROMPT$'));
  expect(promptRow).toBeGreaterThan(rows - 1);
  for (let i = 0; i < rows; i++) expect(result.lines[i]).toBe('');
});

test('C=1 places the image without moving the cursor', async ({ page }) => {
  await boot(page);

  const result = await page.evaluate(async (sequence) => {
    const buf = () => window.term.xterm.buffer.active;
    window.term.write('\x1b[4;7H');
    await window.term.flush();
    const before = { y: buf().cursorY, x: buf().cursorX };
    window.term.write(sequence);
    await window.term.flush();
    const after = { y: buf().cursorY, x: buf().cursorX };
    // The decode is asynchronous, so the canvas lands after the cursor check.
    await new Promise((r) => setTimeout(r, 300));
    return { before, after, placements: window.term.kitty.placementCount };
  }, transmitAndPlace(22, 120, 80, [0, 180, 90], 'C=1'));

  expect(result.after).toEqual(result.before);
  expect(result.placements).toBe(1);
});

test('explicit r and c drive the advance rather than the pixel size', async ({ page }) => {
  await boot(page);

  const result = await page.evaluate(async (sequence) => {
    const buf = () => window.term.xterm.buffer.active;
    window.term.write('\x1b[2;1H');
    await window.term.flush();
    const before = buf().cursorY;
    window.term.write(sequence);
    await window.term.flush();
    return { advanced: buf().cursorY - before, x: buf().cursorX };
  }, transmitAndPlace(23, 300, 300, [80, 80, 200], 'c=7,r=4'));

  expect(result.advanced).toBe(4);
  expect(result.x).toBe(7);
});

test('with only c given the rows follow the aspect ratio', async ({ page }) => {
  await boot(page);
  const cell = await cellBox(page);

  const result = await page.evaluate(async (sequence) => {
    const buf = () => window.term.xterm.buffer.active;
    window.term.write('\x1b[2;1H');
    await window.term.flush();
    const before = buf().cursorY;
    window.term.write(sequence);
    await window.term.flush();
    return buf().cursorY - before;
  }, transmitAndPlace(24, 200, 100, [30, 30, 30], 'c=10'));

  // 10 cols wide, so the height is 10 cells of width times the 100/200 ratio.
  const expected = Math.max(1, Math.round((10 * cell.width * 100) / (200 * cell.height)));
  expect(result).toBe(expected);
});

test('a second image lands below the first rather than overlapping it', async ({ page }) => {
  await boot(page);

  const boxes = await page.evaluate(
    async ({ first, second }) => {
      window.term.write('\x1b[1;1H');
      await window.term.flush();
      window.term.write(first);
      await window.term.flush();
      // A carriage return, then the next image, as a shell running two icats
      // in sequence produces.
      window.term.write(`\r${second}`);
      await window.term.flush();
      await new Promise((r) => setTimeout(r, 300));
      return [...document.querySelectorAll('.webterm-kitty-overlay canvas')].map((c) => {
        const y = Number(/translate\([^,]+,\s*([-\d.]+)px\)/.exec(c.style.transform)[1]);
        return { y, height: parseFloat(c.style.height) };
      });
    },
    {
      first: transmitAndPlace(25, 120, 90, [255, 0, 0]),
      second: transmitAndPlace(26, 120, 90, [0, 0, 255]),
    },
  );

  expect(boxes).toHaveLength(2);
  const [a, b] = boxes.sort((p, q) => p.y - q.y);
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
});

test('an image placed at the bottom scrolls the viewport and travels with its text', async ({
  page,
}) => {
  await boot(page);

  const result = await page.evaluate(async (sequence) => {
    const xterm = window.term.xterm;
    // Park the cursor on the last row, so the placement has to scroll.
    window.term.write('\x1b[999;1H');
    await window.term.flush();
    const baseBefore = xterm.buffer.active.baseY;

    window.term.write(sequence);
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 300));

    const canvas = document.querySelector('.webterm-kitty-overlay canvas');
    const readY = () => Number(/translate\([^,]+,\s*([-\d.]+)px\)/.exec(canvas.style.transform)[1]);
    const settled = readY();

    // Now push it up with more text; it must move up by the same amount.
    window.term.write('\r\n\r\n\r\n');
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 300));

    return {
      scrolled: xterm.buffer.active.baseY - baseBefore,
      settled,
      afterMoreText: readY(),
      rows: xterm.rows,
    };
  }, transmitAndPlace(27, 160, 100, [12, 200, 12]));

  // The placement scrolled the screen rather than being clipped at the bottom.
  expect(result.scrolled).toBeGreaterThan(0);
  // And it kept moving up as text pushed it, rather than staying pinned.
  expect(result.afterMoreText).toBeLessThan(result.settled);
});

test('scrolling up into scrollback and back returns the image to its row', async ({ page }) => {
  await boot(page);

  const result = await page.evaluate(async (sequence) => {
    const xterm = window.term.xterm;
    window.term.write(sequence);
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 300));
    const canvas = document.querySelector('.webterm-kitty-overlay canvas');
    const readY = () => Number(/translate\([^,]+,\s*([-\d.]+)px\)/.exec(canvas.style.transform)[1]);
    const atRest = readY();

    // Push it into scrollback, then scroll back up to it.
    window.term.write('\r\n'.repeat(xterm.rows + 5));
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 300));
    const pushedAway = readY();

    xterm.scrollToTop();
    await new Promise((r) => setTimeout(r, 300));
    const scrolledUp = { y: readY(), display: canvas.style.display };

    xterm.scrollToBottom();
    await new Promise((r) => setTimeout(r, 300));
    return { atRest, pushedAway, scrolledUp, backDown: readY() };
  }, transmitAndPlace(28, 120, 90, [220, 220, 40]));

  // It moved up as the text scrolled, came back into view on scrollback, and
  // returned to where it was when the viewport came back down.
  expect(result.pushedAway).toBeLessThan(result.atRest);
  expect(result.scrolledUp.display).toBe('block');
  expect(result.scrolledUp.y).toBeGreaterThanOrEqual(0);
  expect(result.backDown).toBe(result.pushedAway);
});

test('a placement is dropped once its row falls out of the scrollback', async ({ page }) => {
  // A bare absolute row cannot survive this: once the scrollback saturates,
  // xterm trims lines off the top and every stored row silently drifts by the
  // trim count, so the canvas would sit against unrelated text forever. The
  // placement is anchored to a marker, which xterm keeps correct and disposes
  // with its line.
  await boot(page);

  const result = await page.evaluate(async (sequence) => {
    const xterm = window.term.xterm;
    xterm.options.scrollback = 20;
    window.term.write(sequence);
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 300));
    const placed = window.term.kitty.placementCount;

    // Well past the scrollback, so the anchoring line is trimmed away.
    window.term.write('\r\n'.repeat(xterm.rows + 200));
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 400));
    return {
      placed,
      after: window.term.kitty.placementCount,
      canvases: document.querySelectorAll('.webterm-kitty-overlay canvas').length,
    };
  }, transmitAndPlace(32, 96, 72, [140, 20, 140]));

  expect(result.placed).toBe(1);
  expect(result.after).toBe(0);
  expect(result.canvases).toBe(0);
});

test('a clear screen drops the placements, a partial erase does not', async ({ page }) => {
  // "The clear screen escape code (usually <ESC>[2J) should also clear all
  // images. This is so that the clear command works." The partial erases must
  // leave graphics alone.
  await boot(page);

  const result = await page.evaluate(async ({ a, b }) => {
    window.term.write(a);
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 300));
    const placed = window.term.kitty.placementCount;

    window.term.write('\x1b[0J');
    await window.term.flush();
    const afterPartial = window.term.kitty.placementCount;

    window.term.write('\x1b[2J');
    await window.term.flush();
    const afterClear = window.term.kitty.placementCount;

    // The image data survived the clear, so a re-place still works.
    window.term.write(b);
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 200));
    return { placed, afterPartial, afterClear, replaced: window.term.kitty.placementCount };
  }, { a: transmitAndPlace(29, 64, 64, [5, 5, 200]), b: apc('a=p,i=29') });

  expect(result.placed).toBe(1);
  expect(result.afterPartial).toBe(1);
  expect(result.afterClear).toBe(0);
  expect(result.replaced).toBe(1);
});

test('the alternate screen hides main screen images and discards its own', async ({ page }) => {
  await boot(page);

  const result = await page.evaluate(
    async ({ main, alt }) => {
      window.term.write(main);
      await window.term.flush();
      await new Promise((r) => setTimeout(r, 300));
      const canvas = document.querySelector('.webterm-kitty-overlay canvas');

      // Into the alternate screen: the main screen's image must not be painted
      // over a full-screen application.
      window.term.write('\x1b[?1049h');
      await window.term.flush();
      await new Promise((r) => setTimeout(r, 200));
      const hiddenOnAlt = canvas.style.display;

      // An image placed on the alternate screen belongs to it.
      window.term.write(alt);
      await window.term.flush();
      await new Promise((r) => setTimeout(r, 300));
      const onAlt = window.term.kitty.placementCount;

      window.term.write('\x1b[?1049l');
      await window.term.flush();
      await new Promise((r) => setTimeout(r, 200));
      return {
        hiddenOnAlt,
        onAlt,
        backOnMain: window.term.kitty.placementCount,
        visibleAgain: canvas.style.display,
      };
    },
    { main: transmitAndPlace(30, 96, 72, [200, 100, 0]), alt: transmitAndPlace(31, 96, 72, [0, 100, 200]) },
  );

  expect(result.hiddenOnAlt).toBe('none');
  expect(result.onAlt).toBe(2);
  // Leaving the alternate screen discards what was placed on it, and restores
  // what was placed on the main screen.
  expect(result.backOnMain).toBe(1);
  expect(result.visibleAgain).toBe('block');
});

// --- capability probes -----------------------------------------------------
//
// Kitty graphics is request/response for detection: a client emits a=q probes
// and refuses to send the image at all unless the terminal answers. An overlay
// that renders placements but never replies leaves every probe unanswered and
// makes kitten icat report no graphics support, so these cover the reply path
// rather than the rendering.

/** Everything the terminal sent to the application while running `sequence`. */
async function captureResponses(page, sequence) {
  return page.evaluate(async (seq) => {
    window.events.data.length = 0;
    window.term.write(seq);
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 100));
    const decoder = new TextDecoder();
    return window.events.data.map((bytes) => decoder.decode(bytes)).join('');
  }, sequence);
}

test('a query for direct transmission is answered OK', async ({ page }) => {
  await boot(page);
  // The first of the three probes kitten icat opens with.
  const sent = await captureResponses(page, '\x1b_Ga=q,f=24,s=1,v=1,S=3,i=1;MTIz\x1b\\');
  expect(sent).toBe('\x1b_Gi=1;OK\x1b\\');
});

test('a query for an unreachable medium is answered with an error', async ({ page }) => {
  await boot(page);
  // t=t and t=s name paths in the far end's filesystem, which a browser cannot
  // read. Reporting the error rather than staying silent is what lets a client
  // settle on stream mode instead of waiting out its timeout.
  const sent = await captureResponses(page, '\x1b_Ga=q,f=24,t=t,s=1,v=1,i=2;L3RtcC94\x1b\\');
  expect(sent).toContain('\x1b_Gi=2;ENOTSUPPORTED:');
  expect(sent).not.toContain('OK');
});

test('quiet mode suppresses the responses it should', async ({ page }) => {
  await boot(page);

  // q=1 drops successes but keeps errors.
  expect(await captureResponses(page, '\x1b_Ga=q,f=24,q=1,s=1,v=1,i=7;MTIz\x1b\\')).toBe('');
  expect(await captureResponses(page, '\x1b_Ga=q,f=24,t=s,q=1,s=1,v=1,i=8;MTIz\x1b\\')).toContain(
    '\x1b_Gi=8;ENOTSUPPORTED:',
  );

  // q=2 drops everything.
  expect(await captureResponses(page, '\x1b_Ga=q,f=24,q=2,s=1,v=1,i=9;MTIz\x1b\\')).toBe('');
  expect(await captureResponses(page, '\x1b_Ga=q,f=24,t=s,q=2,s=1,v=1,i=10;MTIz\x1b\\')).toBe('');

  // A command carrying no id is unaddressable, so there is nothing to answer.
  expect(await captureResponses(page, '\x1b_Ga=q,f=24,s=1,v=1;MTIz\x1b\\')).toBe('');
});

test('a probe reply reaches an attached transport, not just data listeners', async ({ page }) => {
  await boot(page);

  // The reply has to take the same route a keystroke does. Emitting it to
  // `data` alone would satisfy the tests above while leaving every consumer
  // that wires a transport with attach() answering no probes at all.
  const sent = await page.evaluate(async () => {
    const seen = [];
    window.term.attach({
      start(sink) {
        window.sink = sink;
      },
      send(bytes) {
        seen.push(new TextDecoder().decode(bytes));
      },
      close() {},
    });
    window.term.write('\x1b_Ga=q,f=24,s=1,v=1,i=42;MTIz\x1b\\');
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 100));
    return seen.join('');
  });

  expect(sent).toBe('\x1b_Gi=42;OK\x1b\\');
});

test('a read-only terminal answers no probes', async ({ page }) => {
  await boot(page);

  // A viewer must not write into someone else's session, and a protocol reply
  // is a write like any other.
  const sent = await page.evaluate(async () => {
    window.term.setOptions({ input: { readOnly: true } });
    window.events.data.length = 0;
    window.term.write('\x1b_Ga=q,f=24,s=1,v=1,i=5;MTIz\x1b\\');
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 100));
    return window.events.data.length;
  });

  expect(sent).toBe(0);
});
