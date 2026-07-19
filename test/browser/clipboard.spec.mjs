// The clipboard layer: OSC 52 decoding, strategy selection and copy-on-select.
//
// The insecure-origin case is exercised by deleting navigator.clipboard in the
// page rather than by serving the fixture from a LAN IP. Chromium treats
// localhost as a secure context, so an http origin here would not reproduce the
// condition anyway, and stubbing the capability is what the code actually
// branches on.
import { expect, test } from '@playwright/test';

import { boot } from './helpers.mjs';

/** An OSC 52 sequence carrying `text`, UTF-8 encoded then base64, as apps emit. */
function osc52(text, targets = 'c') {
  const bytes = new TextEncoder().encode(text);
  return `\x1b]52;${targets};${Buffer.from(bytes).toString('base64')}\x07`;
}

test('OSC 52 writes the text to the clipboard', async ({ page }) => {
  await boot(page);

  await page.evaluate(async (sequence) => {
    window.term.write(sequence);
    await window.term.flush();
  }, osc52('copied through osc 52'));

  await page.waitForFunction(() => window.events.clipboard.length > 0, null, { timeout: 10_000 });
  const event = await page.evaluate(() => window.events.clipboard.at(-1));
  expect(event.text).toBe('copied through osc 52');
  expect(event.written).toBe(true);

  const onSystemClipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(onSystemClipboard).toBe('copied through osc 52');
});

test('a non-Latin-1 payload survives, which the naive atob path would mangle', async ({ page }) => {
  await boot(page);
  const text = '日本語 と emoji 👨‍👩‍👧‍👦 と ünïcode';

  await page.evaluate(async (sequence) => {
    window.term.write(sequence);
    await window.term.flush();
  }, osc52(text));

  await page.waitForFunction(() => window.events.clipboard.length > 0, null, { timeout: 10_000 });
  expect(await page.evaluate(() => window.events.clipboard.at(-1).text)).toBe(text);
});

test('an OSC 52 read request is answered with nothing by default', async ({ page }) => {
  // Answering would echo the user's system clipboard back to the remote.
  await boot(page);

  const result = await page.evaluate(async () => {
    await navigator.clipboard.writeText('a secret already on the clipboard');
    window.events.data.length = 0;
    window.events.clipboard.length = 0;
    window.term.write('\x1b]52;c;?\x07');
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 300));
    return { data: window.events.data.length, clipboard: window.events.clipboard.length };
  });

  expect(result.data).toBe(0);
  expect(result.clipboard).toBe(0);
});

test('the clear form writes an empty string rather than being ignored', async ({ page }) => {
  await boot(page);

  await page.evaluate(async () => {
    window.term.write('\x1b]52;c;\x07');
    await window.term.flush();
  });

  await page.waitForFunction(() => window.events.clipboard.length > 0, null, { timeout: 10_000 });
  expect(await page.evaluate(() => window.events.clipboard.at(-1).text)).toBe('');
});

test('a malformed OSC 52 body is not treated as a copy', async ({ page }) => {
  await boot(page);

  const count = await page.evaluate(async () => {
    window.events.clipboard.length = 0;
    window.term.write('\x1b]52;no-separator\x07');
    await window.term.flush();
    await new Promise((r) => setTimeout(r, 200));
    return window.events.clipboard.length;
  });

  expect(count).toBe(0);
});

test('without navigator.clipboard the write falls back to execCommand', async ({ page }) => {
  await boot(page);

  const result = await page.evaluate(async () => {
    const original = navigator.clipboard;
    // What an insecure origin looks like: the API is absent entirely.
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });

    let execCalled = 0;
    let selected = '';
    const originalExec = document.execCommand;
    document.execCommand = (command) => {
      if (command === 'copy') {
        execCalled++;
        selected = document.activeElement?.value ?? '';
        return true;
      }
      return originalExec.call(document, command);
    };

    try {
      const clipboard = new (await import('/dist/index.js')).Clipboard({}, () => {});
      const strategy = clipboard.strategy();
      clipboard.write('written without the async api');
      return { strategy, execCalled, selected };
    } finally {
      document.execCommand = originalExec;
      Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
    }
  });

  expect(result.strategy).toBe('exec-command');
  expect(result.execCalled).toBe(1);
  expect(result.selected).toBe('written without the async api');
});

test('the hidden textarea is removed and focus is restored', async ({ page }) => {
  await boot(page);

  const result = await page.evaluate(async () => {
    const original = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const originalExec = document.execCommand;
    document.execCommand = () => true;

    const before = document.activeElement;
    window.term.focus();
    const focusedBefore = document.activeElement;

    try {
      const { Clipboard } = await import('/dist/index.js');
      new Clipboard({}, () => {}).write('x');
      return {
        textareasLeft: [...document.querySelectorAll('textarea')].filter(
          (t) => t.style.left === '-9999px',
        ).length,
        focusRestored: document.activeElement === focusedBefore,
        hadFocus: focusedBefore !== before,
      };
    } finally {
      document.execCommand = originalExec;
      Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
    }
  });

  expect(result.textareasLeft).toBe(0);
  expect(result.focusRestored).toBe(true);
});

test('a refused write is retried on the next user gesture', async ({ page }) => {
  await boot(page);

  const result = await page.evaluate(async () => {
    const original = navigator.clipboard;
    let attempts = 0;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(text) {
          attempts++;
          // Refused the first time, as a browser does when there is no user
          // gesture behind the call.
          return attempts === 1 ? Promise.reject(new Error('no user gesture')) : Promise.resolve(text);
        },
      },
    });

    try {
      const { Clipboard } = await import('/dist/index.js');
      const results = [];
      const clipboard = new Clipboard({}, (event) => results.push(event));
      clipboard.write('deferred');
      await new Promise((r) => setTimeout(r, 50));
      const beforeGesture = { attempts, results: results.length };

      window.dispatchEvent(new PointerEvent('pointerdown'));
      await new Promise((r) => setTimeout(r, 50));
      clipboard.dispose();
      return { beforeGesture, attempts, results };
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
    }
  });

  expect(result.beforeGesture.attempts).toBe(1);
  expect(result.beforeGesture.results).toBe(0);
  expect(result.attempts).toBe(2);
  expect(result.results.at(-1)).toEqual({ text: 'deferred', written: true });
});

test('a custom write path replaces the whole strategy', async ({ page }) => {
  await boot(page);

  const written = await page.evaluate(async () => {
    const { Clipboard } = await import('/dist/index.js');
    const seen = [];
    const clipboard = new Clipboard({ write: (text) => seen.push(text) }, () => {});
    const strategy = clipboard.strategy();
    clipboard.write('through the host');
    await new Promise((r) => setTimeout(r, 20));
    return { strategy, seen };
  });

  expect(written.strategy).toBe('custom');
  expect(written.seen).toEqual(['through the host']);
});

test('copy-on-select is off by default and copies when turned on', async ({ page }) => {
  await boot(page);

  const off = await page.evaluate(async () => {
    window.term.write('selectable text on this line');
    await window.term.flush();
    window.events.clipboard.length = 0;
    window.term.xterm.selectAll();
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return window.events.clipboard.length;
  });
  expect(off).toBe(0);

  const on = await page.evaluate(async () => {
    // Read live from the options, so a toggle takes effect without rebinding.
    window.term.setOptions({ clipboard: { copyOnSelect: true } });
    window.events.clipboard.length = 0;
    window.term.xterm.selectAll();
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return window.events.clipboard.at(-1);
  });

  expect(on.text).toContain('selectable text on this line');
  expect(on.written).toBe(true);
});

test('a selection is reported as an event', async ({ page }) => {
  await boot(page);

  const selection = await page.evaluate(async () => {
    window.term.write('some selectable output');
    await window.term.flush();
    let seen = '';
    window.term.on('selection', (text) => {
      seen = text;
    });
    window.term.xterm.selectAll();
    await new Promise((r) => setTimeout(r, 100));
    return seen;
  });

  expect(selection).toContain('some selectable output');
});
