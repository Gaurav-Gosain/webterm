// Browser tests for the demo page.
//
// The demo is the first thing anyone sees of this package, so the two things
// it can get wrong that a screenshot would catch are asserted here instead:
// that the frame paints its stated default on the first paint, and that the
// fake shell does not echo the terminal's own replies back at the prompt.
import { expect, test } from '@playwright/test';

/** Load the demo and wait for both terminals to be open. */
async function boot(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('/demo/index.html');
  await page.waitForFunction(() => window.demo !== undefined, null, { timeout: 30_000 });
  if (errors.length) throw new Error(`the demo threw during boot:\n${errors.join('\n')}`);
}

/** Every line of the framed terminal's screen, joined. */
function screenText(page) {
  return page.evaluate(() => {
    const buffer = window.demo.framed.xterm.buffer.active;
    const lines = [];
    for (let y = 0; y <= buffer.baseY + buffer.cursorY; y++) {
      lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  });
}

test('the frame paints its default background on the first paint', async ({ page }) => {
  await boot(page);

  // No interaction at all: the control still reads aurora, and so must the
  // stage. Reading the select as well as the stage is what distinguishes a
  // wrong default from a control that never got populated.
  await expect(page.locator('#background')).toHaveValue('aurora');

  const painted = await page.$eval('.webterm-chrome', (node) => {
    const style = getComputedStyle(node);
    return { image: style.backgroundImage, custom: style.getPropertyValue('--webterm-chrome-background') };
  });
  expect(painted.image).toContain('gradient');
  expect(painted.custom.trim()).not.toBe('');
});

test('the shell does not echo the terminal replies', async ({ page }) => {
  await boot(page);

  // The capability probe is answered with `ESC _ Gi=99;OK ESC \` on the data
  // channel, which is the same route a keystroke takes, so the shell's own
  // listener receives it too. The screen is read only once the answer has
  // actually been sent, tapped from that same event: polling for the button's
  // printed output instead would race the reply.
  await page.evaluate(() => {
    window.seen = '';
    window.demo.framed.on('data', (bytes) => {
      window.seen += new TextDecoder().decode(bytes);
    });
  });
  await page.click('#gfx-probe');
  await expect.poll(() => page.evaluate(() => window.seen)).toContain(';OK');
  await expect.poll(() => screenText(page)).toContain('probe answered');

  // The reply is quoted once, by the button's own report. Anywhere else on the
  // screen it is the shell having echoed it.
  const text = await screenText(page);
  const quoted = text.split('\n').filter((line) => line.includes('probe answered'));
  const rest = text
    .split('\n')
    .filter((line) => !line.includes('probe answered'))
    .join('\n');
  expect(quoted).toHaveLength(1);
  expect(rest).not.toMatch(/_G/);
  expect(rest).not.toMatch(/;OK/);
});

test('a reply split across two data events is still swallowed', async ({ page }) => {
  await boot(page);

  // The framing has to survive a split anywhere, including between the ESC and
  // the backslash of the string terminator, which is the one place a parser
  // that scans for a two-character token rather than holding state gets wrong.
  const before = await screenText(page);
  await page.evaluate(() => {
    const shell = window.demo.shell;
    const reply = '\x1b_Gi=2;OK\x1b\\';
    for (const cut of [1, 4, reply.length - 1]) {
      shell.onInput(reply.slice(0, cut));
      shell.onInput(reply.slice(cut));
    }
    // A CSI reply and an OSC ending at BEL, split the same way.
    shell.onInput('\x1b[?62;1;');
    shell.onInput('2c');
    shell.onInput('\x1b]11;rgb:1e1e/1e1e/2e2');
    shell.onInput('e\x07');
  });

  expect(await screenText(page)).toBe(before);
  // Nothing accumulated in the line editor either, so the next Enter runs an
  // empty line rather than a command made of reply fragments.
  expect(await page.evaluate(() => window.demo.shell.line)).toBe('');
});

test('the shell still echoes ordinary typing', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.demo.framed.focus());
  await page.keyboard.type('help');
  await expect.poll(() => page.evaluate(() => window.demo.shell.line)).toBe('help');
  expect(await screenText(page)).toContain('help');
});
