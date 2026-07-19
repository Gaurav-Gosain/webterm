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
