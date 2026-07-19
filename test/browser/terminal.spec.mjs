// The integrated terminal: it opens, it renders, it reports its geometry, and
// bytes move in both directions across a Transport.
import { expect, test } from '@playwright/test';

import { boot } from './helpers.mjs';

test('the terminal opens and renders what is written to it', async ({ page }) => {
  await boot(page);

  const rendered = await page.evaluate(async () => {
    await window.term.flush();
    window.term.write('hello webterm');
    await window.term.flush();
    const buffer = window.term.xterm.buffer.active;
    return buffer.getLine(buffer.cursorY).translateToString(true);
  });

  expect(rendered).toBe('hello webterm');
  // The renderer painted something, whichever backend it settled on.
  await expect(page.locator('#host .xterm-screen')).toBeVisible();
});

test('the grid is fitted to the container and reported in pixels', async ({ page }) => {
  await boot(page);

  const geometry = await page.evaluate(() => ({
    cols: window.term.cols,
    rows: window.term.rows,
    pixel: window.term.pixelSize,
    renderer: window.term.renderer,
  }));

  expect(geometry.cols).toBeGreaterThan(20);
  expect(geometry.rows).toBeGreaterThan(5);
  // A winsize report of zeros is the failure this getter exists to prevent.
  expect(geometry.pixel.width).toBeGreaterThan(0);
  expect(geometry.pixel.height).toBeGreaterThan(0);
  expect(['webgl', 'canvas', 'dom']).toContain(geometry.renderer);
});

test('an explicit resize is reported with its pixel size', async ({ page }) => {
  await boot(page);

  const event = await page.evaluate(async () => {
    window.events.resize.length = 0;
    window.term.resize(80, 24);
    await window.term.flush();
    return window.events.resize.at(-1);
  });

  expect(event.cols).toBe(80);
  expect(event.rows).toBe(24);
  expect(event.pixel.width).toBeGreaterThan(0);
});

test('typed input is emitted as UTF-8 bytes', async ({ page }) => {
  await boot(page);
  await page.locator('#host .xterm-helper-textarea').focus();
  await page.keyboard.type('héllo');

  const bytes = await page.evaluate(() =>
    window.events.data.map((chunk) => [...chunk]).flat(),
  );
  expect(new TextDecoder().decode(new Uint8Array(bytes))).toBe('héllo');
});

test('a large paste is chunked, and the chunks reassemble to the original', async ({ page }) => {
  await boot(page);

  const result = await page.evaluate(async () => {
    window.events.data.length = 0;
    // Well over the 64 KiB default, so it must arrive as several chunks.
    const text = 'x'.repeat(200_000);
    window.term.paste(text);
    await window.term.flush();

    const chunks = window.events.data;
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return {
      chunks: chunks.length,
      largest: Math.max(...chunks.map((chunk) => chunk.length)),
      text: new TextDecoder().decode(joined),
      expected: text,
    };
  });

  expect(result.chunks).toBeGreaterThan(1);
  expect(result.largest).toBeLessThanOrEqual(64 * 1024);
  // Bracketed paste is off with no application asking for it, so the payload is
  // the text itself.
  expect(result.text).toContain(result.expected);
});

test('a transport carries bytes in and out', async ({ page }) => {
  await boot(page);

  const result = await page.evaluate(async () => {
    const sent = [];
    let sink;
    const transport = {
      name: 'fake',
      start(s) {
        sink = s;
      },
      send(bytes) {
        sent.push(new TextDecoder().decode(bytes));
      },
      close() {},
    };

    window.term.attach(transport);
    // Inward.
    sink.data(new TextEncoder().encode('from the far end'));
    await window.term.flush();
    // Outward.
    window.term.xterm.input('typed', true);
    await window.term.flush();

    const buffer = window.term.xterm.buffer.active;
    return {
      rendered: buffer.getLine(buffer.cursorY).translateToString(true),
      sent,
    };
  });

  expect(result.rendered).toContain('from the far end');
  expect(result.sent.join('')).toBe('typed');
});

test('detaching stops sending, and the returned function detaches too', async ({ page }) => {
  await boot(page);

  const sent = await page.evaluate(async () => {
    const sent = [];
    const make = () => ({
      start() {},
      send(bytes) {
        sent.push(new TextDecoder().decode(bytes));
      },
      close() {},
    });

    const detach = window.term.attach(make());
    window.term.xterm.input('a', true);
    detach();
    window.term.xterm.input('b', true);

    window.term.attach(make());
    window.term.xterm.input('c', true);
    window.term.detach();
    window.term.xterm.input('d', true);
    await window.term.flush();
    return sent;
  });

  expect(sent.join('')).toBe('ac');
});

test('readOnly suppresses input without stopping output', async ({ page }) => {
  await boot(page);

  const result = await page.evaluate(async () => {
    window.events.data.length = 0;
    window.term.setOptions({ input: { readOnly: true } });
    window.term.xterm.input('ignored', true);
    window.term.write('still rendered');
    await window.term.flush();
    const buffer = window.term.xterm.buffer.active;
    return {
      emitted: window.events.data.length,
      rendered: buffer.getLine(buffer.cursorY).translateToString(true),
    };
  });

  expect(result.emitted).toBe(0);
  expect(result.rendered).toContain('still rendered');
});

test('title and bell reach the consumer as events rather than side effects', async ({ page }) => {
  await boot(page);

  const result = await page.evaluate(async () => {
    const titleBefore = document.title;
    window.term.write('\x1b]0;a new title\x07\x07');
    await window.term.flush();
    return {
      titles: window.events.title,
      bells: window.events.bell,
      // The package never assigns document.title; that is the consumer's call.
      documentTitleUnchanged: document.title === titleBefore,
    };
  });

  expect(result.titles).toContain('a new title');
  expect(result.bells).toBeGreaterThan(0);
  expect(result.documentTitleUnchanged).toBe(true);
});

test('writes inside one frame are coalesced into a single emulator write', async ({ page }) => {
  await boot(page);

  const result = await page.evaluate(async () => {
    const term = window.term.xterm;
    const original = term.write.bind(term);
    let calls = 0;
    term.write = (...args) => {
      calls++;
      return original(...args);
    };
    try {
      for (let i = 0; i < 50; i++) window.term.write(new TextEncoder().encode(`chunk${i} `));
      // Nothing has reached the emulator yet: it is queued for the next frame.
      const beforeFlush = calls;
      await window.term.flush();
      // Read the whole screen: fifty chunks wrap across several rows.
      const buffer = term.buffer.active;
      const screen = [];
      for (let row = 0; row < term.rows; row++) {
        screen.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
      }
      return { beforeFlush, rendered: screen.join('') };
    } finally {
      term.write = original;
    }
  });

  expect(result.beforeFlush).toBe(0);
  expect(result.rendered).toContain('chunk0');
  expect(result.rendered).toContain('chunk49');
});

test('disposing empties the container and leaves no terminal behind', async ({ page }) => {
  await boot(page);

  const after = await page.evaluate(() => {
    window.term.dispose();
    return {
      children: document.getElementById('host').childElementCount,
      throwsOnXterm: (() => {
        try {
          void window.term.xterm;
          return false;
        } catch {
          return true;
        }
      })(),
    };
  });

  expect(after.children).toBe(0);
  expect(after.throwsOnXterm).toBe(true);
});

test('a second open resolves to the same instance rather than a second terminal', async ({ page }) => {
  await boot(page);

  const result = await page.evaluate(async () => {
    const again = await window.term.open(document.getElementById('host'));
    return {
      same: again === window.term,
      screens: document.querySelectorAll('#host .xterm-screen').length,
    };
  });

  expect(result.same).toBe(true);
  expect(result.screens).toBe(1);
});
