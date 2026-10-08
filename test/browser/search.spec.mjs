// Buffer search: WebTerm.search finds what the program printed, selects it and
// scrolls to it. It came from sip's client, where it backed the page API, and
// these cases came with it.
import { expect, test } from '@playwright/test';

import { boot } from './helpers.mjs';

/** Write text and wait until xterm has parsed it. */
async function print(page, text) {
  await page.evaluate(async (t) => {
    window.term.write(t);
    await window.term.flush();
  }, text);
}

test('finds text on the screen, case-insensitively by default, and selects it', async ({ page }) => {
  await boot(page, '?cols=40&rows=10');
  await print(page, 'first line\r\nthe Z9MARKER is here\r\n');

  const hit = await page.evaluate(() => window.term.search.find('z9marker'));
  expect(hit).toEqual({ row: 1, col: 4, length: 8 });
  expect(await page.evaluate(() => window.term.xterm.getSelection())).toBe('Z9MARKER');

  // Case-sensitive: the lower-case query no longer matches.
  expect(await page.evaluate(() => window.term.search.find('z9marker', { caseSensitive: true }))).toBeNull();
});

test('finds a match that straddles a wrapped row', async ({ page }) => {
  await boot(page, '?cols=20&rows=10');
  // 16 characters of padding put the marker across the row boundary.
  await print(page, `${'y'.repeat(16)}WRAPMARK\r\n`);

  const hit = await page.evaluate(() => window.term.search.find('WRAPMARK'));
  expect(hit).toEqual({ row: 0, col: 16, length: 8 });
  expect(await page.evaluate(() => window.term.xterm.getSelection())).toBe('WRAPMARK');
});

test('next and previous walk the matches and wrap around the buffer', async ({ page }) => {
  await boot(page, '?cols=40&rows=10');
  await print(page, 'hit one\r\nnothing\r\nhit two\r\nhit three\r\n');

  const walk = await page.evaluate(() => {
    const s = window.term.search;
    const rows = [s.find('hit').row];
    rows.push(s.findNext().row, s.findNext().row, s.findNext().row);
    rows.push(s.findPrevious().row);
    return rows;
  });
  // 0, 2, 3, then around to 0, and back to 3.
  expect(walk).toEqual([0, 2, 3, 0, 3]);
});

test('previous from a match at the start of a line moves on', async ({ page }) => {
  await boot(page, '?cols=40&rows=10');
  await print(page, 'ab ab\r\nab\r\n');

  const walk = await page.evaluate(() => {
    const s = window.term.search;
    const at = (m) => [m.row, m.col];
    // Forward: (0,0), (0,3), (1,0). Then backward from (1,0).
    const out = [at(s.find('ab')), at(s.findNext()), at(s.findNext())];
    out.push(at(s.findPrevious()), at(s.findPrevious()));
    // Now on (0,0), the start of a line. Backward from there wraps to the
    // last match. A search that searched backward from index 0 inclusive
    // would find the match it is sitting on and stay at (0,0).
    out.push(at(s.findPrevious()));
    return out;
  });
  expect(walk).toEqual([
    [0, 0],
    [0, 3],
    [1, 0],
    [0, 3],
    [0, 0],
    [1, 0],
  ]);
});

test('a wide character is one character and two cells', async ({ page }) => {
  await boot(page, '?cols=40&rows=10');
  await print(page, '漢字 wide 漢字X\r\n');

  const hit = await page.evaluate(() => window.term.search.find('字X'));
  // 漢字 wide 漢 is 2+2+1+4+1+2 = 12 cells before 字.
  expect(hit).toEqual({ row: 0, col: 12, length: 2 });
  expect(await page.evaluate(() => window.term.xterm.getSelection())).toBe('字X');
});

test('finds a match in the scrollback and scrolls it into view', async ({ page }) => {
  await boot(page, '?cols=40&rows=5');
  await print(page, 'OLDMARK\r\n' + Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n'));

  const before = await page.evaluate(() => window.term.xterm.buffer.active.viewportY);
  expect(before).toBeGreaterThan(0);
  const hit = await page.evaluate(() => window.term.search.find('oldmark'));
  expect(hit.row).toBe(0);
  const after = await page.evaluate(() => window.term.xterm.buffer.active.viewportY);
  expect(after).toBe(0);
});

test('clear forgets the query and drops the selection; bad queries find nothing', async ({ page }) => {
  await boot(page, '?cols=40&rows=10');
  await print(page, 'something\r\n');

  const out = await page.evaluate(() => {
    const s = window.term.search;
    s.find('some');
    s.clear();
    return {
      query: s.query,
      selection: window.term.xterm.getSelection(),
      next: s.findNext(),
      empty: s.find(''),
      tooLong: s.find('x'.repeat(257)),
      missing: s.find('absent'),
    };
  });
  expect(out).toEqual({ query: '', selection: '', next: null, empty: null, tooLong: null, missing: null });
});
