/**
 * The kitty keyboard protocol, driven through a real browser.
 *
 * Every key here is pressed through Playwright's keyboard, which goes through
 * the browser's own input pipeline and produces trusted events, so what is
 * asserted is what the terminal emits for a genuine keypress. A synthetic
 * dispatchEvent would prove the encoder runs; it would not prove the key
 * reaches it, that xterm's own handling was suppressed, or that the character
 * is not also delivered a second time through the keypress path.
 *
 * The mode is always set the way an application sets it, by writing the control
 * sequence into the terminal, never by reaching into the instance.
 */
import { expect, test } from '@playwright/test';
import { boot } from './helpers.mjs';

/** Put the terminal in a known mode and start collecting from empty. */
async function arm(page, sequence = '') {
  await page.evaluate(async (seq) => {
    if (seq) window.term.write(seq);
    await window.term.flush();
    window.term.focus();
    window.clearData();
  }, sequence);
}

const data = (page) => page.evaluate(() => window.dataText());

test.beforeEach(async ({ page }) => {
  await boot(page);
});

// --- Nothing enabled ---------------------------------------------------------

test('with no flags every key keeps its legacy encoding', async ({ page }) => {
  await arm(page);

  await page.keyboard.press('Control+a');
  expect(await data(page)).toBe('\x01');

  await arm(page);
  await page.keyboard.press('Escape');
  expect(await data(page)).toBe('\x1b');

  await arm(page);
  await page.keyboard.press('ArrowUp');
  expect(await data(page)).toBe('\x1b[A');

  await arm(page);
  await page.keyboard.press('a');
  expect(await data(page)).toBe('a');
});

// --- Disambiguate ------------------------------------------------------------

test('pushing the disambiguate flag changes the encoding of ctrl+a', async ({ page }) => {
  await arm(page);
  await page.keyboard.press('Control+a');
  expect(await data(page)).toBe('\x01');

  // The same key, the same browser, the only difference being that the
  // application asked for the protocol.
  await arm(page, '\x1b[>1u');
  await page.keyboard.press('Control+a');
  expect(await data(page)).toBe('\x1b[97;5u');
});

test('disambiguate reports escape unambiguously', async ({ page }) => {
  await arm(page, '\x1b[>1u');
  await page.keyboard.press('Escape');
  expect(await data(page)).toBe('\x1b[27u');
});

test('ctrl+i and Tab stop colliding under disambiguate', async ({ page }) => {
  await arm(page, '\x1b[>1u');
  await page.keyboard.press('Control+i');
  const ctrlI = await data(page);

  await arm(page);
  await page.keyboard.press('Tab');
  const tab = await data(page);

  // In legacy encoding both of these are the single byte 0x09 and an
  // application cannot tell them apart. Tab keeps that byte, because on its own
  // it is not ambiguous; ctrl+i is the one that moves.
  expect(ctrlI).toBe('\x1b[105;5u');
  expect(tab).toBe('\t');
  expect(ctrlI).not.toBe(tab);
});

test('plain text is still plain text under disambiguate', async ({ page }) => {
  await arm(page, '\x1b[>1u');
  await page.keyboard.press('a');
  expect(await data(page)).toBe('a');
});

// --- Progressive enhancement -------------------------------------------------

test('push and pop actually change the encoding on the wire', async ({ page }) => {
  // Legacy.
  await arm(page);
  await page.keyboard.press('Control+a');
  expect(await data(page)).toBe('\x01');

  // Pushed: the protocol form.
  await arm(page, '\x1b[>1u');
  await page.keyboard.press('Control+a');
  expect(await data(page)).toBe('\x1b[97;5u');

  // Pushed again, this time reporting every key.
  await arm(page, '\x1b[>9u');
  await page.keyboard.press('a');
  expect(await data(page)).toBe('\x1b[97u');

  // Popped once: back to the disambiguate level, where a plain letter is text
  // again but ctrl+a is still the protocol form.
  await arm(page, '\x1b[<1u');
  await page.keyboard.press('a');
  expect(await data(page)).toBe('a');
  await arm(page);
  await page.keyboard.press('Control+a');
  expect(await data(page)).toBe('\x1b[97;5u');

  // Popped again: all the way back to legacy.
  await arm(page, '\x1b[<1u');
  await page.keyboard.press('Control+a');
  expect(await data(page)).toBe('\x01');
});

/** Write a sequence and read what came back, without clearing the reply. */
async function ask(page, sequence) {
  return page.evaluate(async (seq) => {
    window.clearData();
    window.term.write(seq);
    await window.term.flush();
    return window.dataText();
  }, sequence);
}

test('the query reports the flags in effect', async ({ page }) => {
  // The reply is how an application detects support at all: a terminal without
  // the protocol answers nothing.
  expect(await ask(page, '\x1b[?u')).toBe('\x1b[?0u');

  await arm(page, '\x1b[>5u');
  expect(await ask(page, '\x1b[?u')).toBe('\x1b[?5u');

  await arm(page, '\x1b[<1u');
  expect(await ask(page, '\x1b[?u')).toBe('\x1b[?0u');
});

test('set replaces flags without touching the stack', async ({ page }) => {
  await arm(page, '\x1b[>1u');
  // Mode 1 replaces everything with the given set.
  await arm(page, '\x1b[=9;1u');
  await page.keyboard.press('a');
  expect(await data(page)).toBe('\x1b[97u');

  // Popping returns to what was in effect before the push, not before the set.
  await arm(page, '\x1b[<1u');
  await page.keyboard.press('Control+a');
  expect(await data(page)).toBe('\x01');
});

// --- Report all keys ---------------------------------------------------------

test('report-all-keys encodes plain letters and does not double them', async ({ page }) => {
  await arm(page, '\x1b[>8u');
  await page.keyboard.press('a');
  // Exactly one sequence. If xterm's keypress path also fired, the literal 'a'
  // would be appended here and this would be '\x1b[97ua'.
  expect(await data(page)).toBe('\x1b[97u');
});

test('report-all-keys reports shift as a modifier on the base key', async ({ page }) => {
  await arm(page, '\x1b[>8u');
  await page.keyboard.press('Shift+A');
  // Two sequences: the shift key itself, then the letter. Reporting the
  // modifier key on its own is the point of this flag, and it is what lets a
  // program implement a hold-to-activate binding.
  expect(await data(page)).toBe('\x1b[57441;2u\x1b[97;2u');
});

test('an unmodified cursor key keeps its bare legacy form', async ({ page }) => {
  await arm(page, '\x1b[>8u');
  await page.keyboard.press('ArrowUp');
  expect(await data(page)).toBe('\x1b[A');
});

// --- Event types -------------------------------------------------------------

test('key release is reported only when the flag asks for it', async ({ page }) => {
  await arm(page, '\x1b[>8u');
  await page.keyboard.press('a');
  expect(await data(page)).toBe('\x1b[97u');

  await arm(page, '\x1b[>10u');
  await page.keyboard.press('a');
  // Press then release, as two separate sequences.
  expect(await data(page)).toBe('\x1b[97u\x1b[97;1:3u');
});

test('modifier keys report their own press and release', async ({ page }) => {
  await arm(page, '\x1b[>10u');
  await page.keyboard.down('Control');
  expect(await data(page)).toBe('\x1b[57442;5u');

  await arm(page);
  await page.keyboard.up('Control');
  expect(await data(page)).toBe('\x1b[57442;1:3u');
});

// --- Alternate keys and associated text --------------------------------------

test('alternate keys report the shifted character', async ({ page }) => {
  await arm(page, '\x1b[>12u');
  await page.keyboard.press('Shift+A');
  // The key is reported as 'a' with 'A' as its shifted alternate, so an
  // application can match on the base key and still know what was produced.
  expect(await data(page)).toBe('\x1b[57441;2u\x1b[97:65;2u');
});

test('alternate keys report the base key of a shifted punctuation key', async ({ page }) => {
  await arm(page, '\x1b[>12u');
  await page.keyboard.press('Shift+Digit1');
  // '!' with '1' as the key it sits on. Lowercasing cannot recover that, so
  // this comes from the physical key rather than from the character.
  expect(await data(page)).toBe('\x1b[57441;2u\x1b[49:33;2u');
});

test('associated text is appended as codepoints', async ({ page }) => {
  await arm(page, '\x1b[>24u');
  await page.keyboard.press('a');
  expect(await data(page)).toBe('\x1b[97;1;97u');
});

// --- Isolation ---------------------------------------------------------------

test('the alternate screen keeps its own keyboard state', async ({ page }) => {
  await arm(page, '\x1b[>1u');

  // Enter the alternate screen and enable everything there.
  await arm(page, '\x1b[?1049h\x1b[>8u');
  await page.keyboard.press('a');
  expect(await data(page)).toBe('\x1b[97u');

  // Leaving it must restore what the main screen had, not carry the alternate
  // screen's mode back out with it.
  await arm(page, '\x1b[?1049l');
  await page.keyboard.press('a');
  expect(await data(page)).toBe('a');
  await arm(page);
  await page.keyboard.press('Control+a');
  expect(await data(page)).toBe('\x1b[97;5u');
});

test('a terminal reset returns to legacy encoding', async ({ page }) => {
  await arm(page, '\x1b[>8u');
  await page.keyboard.press('a');
  expect(await data(page)).toBe('\x1b[97u');

  await page.evaluate(async () => {
    window.term.reset();
    await window.term.flush();
    window.term.focus();
    window.clearData();
  });
  await page.keyboard.press('a');
  expect(await data(page)).toBe('a');
});
