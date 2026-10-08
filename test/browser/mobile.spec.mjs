// The touch key bar, driven with real touch events against a real WebTerm.
//
// Moved here from sip's clienttests/mobile.spec.mjs with the key bar itself.
// Every assertion goes through either the input the fixture recorded (what
// the page would have put on the wire) or the DOM state the bar is supposed to
// leave behind. None of it is inferred from a synthesized click, because a
// click is exactly the thing the bar does not use: the whole gesture is
// cancelled at touchstart and the tap is reconstructed from the touch
// sequence.
//
// The pan test is the one that matters most. The bar used to be an
// overflow-x: auto strip and the browser scrolled it, which cost the software
// keyboard: a native touch scroll arrives at the page with cancelable false, so
// the page cannot stop it, and Blink takes the keyboard down when a scroll
// starts under it. The fix is that the strip is overflow: hidden and the pan is
// done by assigning scrollLeft. What that test asserts is the shape of the fix:
// the strip moved, the touch sequence stayed cancellable, and focus never left
// the element the keyboard is riding on. Anyone who reverts to a native
// scroller will see it fail.

import { test, expect } from '@playwright/test';

import { bootMobile, clearSent, sentCodes } from './helpers.mjs';

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };

/** The centre of a bar button, by its label. */
async function keyCentre(page, label, ns = 'webterm') {
  const btn = page.locator(`#${ns}-keybar button`, { hasText: new RegExp(`^${label}$`) }).first();
  const box = await btn.boundingBox();
  if (!box) throw new Error(`no bar button labelled ${label}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, btn };
}

async function tapKey(page, label, ns) {
  const { x, y } = await keyCentre(page, label, ns);
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(80);
}

/** A multi-step touch pan through CDP, which Playwright's touchscreen cannot do. */
async function pan(page, start, distance) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y: start.y, id: 1 }],
    });
  await touch('touchStart', start.x);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', start.x - (i * distance) / 10);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd', start.x - distance);
  await page.waitForTimeout(400);
}

const paddingBottom = (page) =>
  page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('wrap')).paddingBottom));

const keybarH = (page, ns = 'webterm') =>
  page.evaluate(
    (n) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--${n}-keybar-h`)),
    ns,
  );

test.describe('touch key bar', () => {
  test('is not installed without a touch screen', async ({ page }) => {
    await bootMobile(page);
    await expect(page.locator('#webterm-keybar')).toHaveCount(0);
    expect(await page.evaluate(() => document.body.classList.contains('webterm-touch'))).toBe(false);
    expect(await page.evaluate(() => window.bar.enabled)).toBe(false);
    // The inert controller hands input back untouched.
    expect(await page.evaluate(() => window.bar.transformInput('c'))).toBe('c');
  });

  test('a floating control is draggable and remembers where it was left', async ({ page }) => {
    await bootMobile(page);
    const gear = page.locator('#gear');
    const box = await gear.boundingBox();

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 120, box.y - 200, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(50);

    const moved = await gear.boundingBox();
    expect(Math.abs(moved.x - box.x)).toBeGreaterThan(50);
    // Letting go of a drag must not also press the button it was dragged by.
    expect(await page.evaluate(() => window.gearClicks)).toBe(0);

    const stored = await page.evaluate(() => localStorage.getItem('webterm-fixture-gear'));
    expect(JSON.parse(stored)).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });

    // A plain click is still a click.
    await gear.click();
    expect(await page.evaluate(() => window.gearClicks)).toBe(1);
  });

  test('a namespace that is not a CSS identifier is refused', async ({ page }) => {
    await bootMobile(page);
    const message = await page.evaluate(() => {
      try {
        window.mobile.installKeyBar({ send() {} }, { namespace: 'a b' });
        return 'installed';
      } catch (e) {
        return String(e);
      }
    });
    expect(message).toContain('namespace must be a CSS identifier');
  });
});

test.describe('touch key bar (touch viewport)', () => {
  test.use(PHONE);

  test('installs and reserves its height', async ({ page }) => {
    await bootMobile(page);
    await expect(page.locator('#webterm-keybar')).toHaveCount(1);
    expect(await page.evaluate(() => document.body.classList.contains('webterm-touch'))).toBe(true);

    // The bar's height is published as a custom property and the page pads
    // itself with it, which is what keeps the bottom row of the terminal out
    // from under the strip.
    const barH = await keybarH(page);
    expect(barH).toBeGreaterThan(20);
    expect(await paddingBottom(page)).toBeCloseTo(barH, 0);
    expect(await page.locator('#webterm-keybar button').count()).toBeGreaterThan(10);
  });

  test('the sip namespace emits the names sip has always used', async ({ page }) => {
    // sip and the tuios web client select these names in their own suites,
    // so the namespace is a compatibility promise, not a cosmetic one.
    await bootMobile(page, {
      namespace: 'sip',
      prefix: { key: 'b', code: 'KeyB', ctrl: true },
      rows: [
        { label: 'chords', collapsible: true, keys: [{ label: 'pfx', title: 'Prefix', prefix: true }] },
        { keys: [{ label: 'esc', title: 'Escape', key: 'Escape' }] },
      ],
    });
    for (const sel of [
      '#sip-keybar',
      '#sip-keybar-rows',
      '#sip-keybar-pin',
      '.sip-keybar-row',
      '.sip-keybar-scroll',
      'style#sip-mobile-style',
      'style#sip-touch-style',
    ]) {
      expect(await page.locator(sel).count(), sel).toBeGreaterThan(0);
    }
    await expect(page.locator('#webterm-keybar')).toHaveCount(0);
    expect(await page.evaluate(() => document.body.classList.contains('sip-touch'))).toBe(true);
    expect(await keybarH(page, 'sip')).toBeGreaterThan(20);
    expect(await paddingBottom(page)).toBeCloseTo(await keybarH(page, 'sip'), 0);

    // The fold is remembered under the namespace.
    await tapKey(page, '▾', 'sip');
    expect(await page.evaluate(() => localStorage.getItem('sip.keybar.rows'))).toBe('0');

    // The touch mouse names its ring and hint the same way.
    const c = await page.evaluate(() => {
      const r = document.querySelector('.xterm-screen').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 3) };
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y, id: 1 }] });
    await page.waitForTimeout(600);
    await expect(page.locator('#sip-touch-ring')).toHaveClass(/on/);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y, id: 1 }] });
    for (let i = 1; i <= 4; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: c.x, y: c.y - i * 15, id: 1 }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('#sip-touch-hint')).toHaveClass(/on/);
    expect(await page.evaluate(() => localStorage.getItem('sip.touch.hint'))).toBe('1');
  });

  test('a caller key set replaces the default one', async ({ page }) => {
    await bootMobile(page, {
      keys: [
        { label: 'esc', title: 'Escape', key: 'Escape' },
        { label: '^C', title: 'Interrupt', key: 'c', ctrl: true },
      ],
    });

    const labels = await page.locator('.webterm-keybar-scroll button').allTextContents();
    expect(labels.slice(0, 2)).toEqual(['esc', '^C']);
    expect(labels).not.toContain('ctrl');

    await clearSent(page);
    await tapKey(page, '\\^C');
    expect(await sentCodes(page)).toEqual([0x03]);
  });

  test('a tap sends the key', async ({ page }) => {
    await bootMobile(page);
    await clearSent(page);
    await tapKey(page, 'esc');
    expect(await sentCodes(page)).toEqual([0x1b]);

    await clearSent(page);
    await tapKey(page, 'tab');
    expect(await sentCodes(page)).toEqual([0x09]);

    await clearSent(page);
    await tapKey(page, '←');
    expect(await sentCodes(page)).toEqual([0x1b, 0x5b, 0x44]); // ESC [ D
  });

  test('a page action runs and sends nothing', async ({ page }) => {
    // A short row, so the action is on screen: the default row overflows a
    // phone and the action would sit past its right edge.
    await bootMobile(page, { keys: [{ label: 'esc', title: 'Escape', key: 'Escape' }], actions: ['act'] });
    await clearSent(page);
    const btn = (await keyCentre(page, 'act')).btn;
    await expect(btn).toHaveClass(/action/);
    await tapKey(page, 'act');
    expect(await page.evaluate(() => window.actionRuns)).toBe(1);
    expect(await sentCodes(page)).toEqual([]);
  });

  test('ctrl arms for one key, then locks', async ({ page }) => {
    await bootMobile(page);
    const ctrl = (await keyCentre(page, 'ctrl')).btn;

    await tapKey(page, 'ctrl');
    await expect(ctrl).toHaveClass(/armed/);

    // Typed on the keyboard, so this proves the fold happens on the byte path:
    // xterm has already encoded the key by the time the host sees it.
    await clearSent(page);
    await page.keyboard.type('c');
    await page.waitForTimeout(80);
    expect(await sentCodes(page)).toEqual([0x03]);
    await expect(ctrl).not.toHaveClass(/armed/);

    // ... and the next key is unmodified, because it was a one-shot.
    await clearSent(page);
    await page.keyboard.type('c');
    await page.waitForTimeout(80);
    expect(await sentCodes(page)).toEqual([0x63]);

    // Two taps lock it until it is tapped off.
    await tapKey(page, 'ctrl');
    await tapKey(page, 'ctrl');
    await expect(ctrl).toHaveClass(/locked/);
    await clearSent(page);
    await page.keyboard.type('aa');
    await page.waitForTimeout(120);
    expect(await sentCodes(page)).toEqual([0x01, 0x01]);

    await tapKey(page, 'ctrl');
    await expect(ctrl).not.toHaveClass(/locked/);
  });

  test('an armed modifier reaches a bar key and a cursor key', async ({ page }) => {
    await bootMobile(page);
    await tapKey(page, 'ctrl');
    await clearSent(page);
    await tapKey(page, '←');
    // ESC [ 1 ; 5 D
    expect(await sentCodes(page)).toEqual([0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x44]);
  });

  test('a mouse report does not spend an armed modifier', async ({ page }) => {
    await bootMobile(page);
    await tapKey(page, 'ctrl');
    // A multi-byte sequence on the input path is not a keystroke. Spending the
    // modifier on it would take it away from the key the user is about to
    // press, so it passes through and the arm survives.
    const out = await page.evaluate(() => window.bar.transformInput('\x1b[<0;5;3M'));
    expect(out).toBe('\x1b[<0;5;3M');
    expect(await page.evaluate(() => window.bar.mods.ctrl)).toBe(1);
  });

  test('a pan moves the strip by hand and keeps the keyboard focus', async ({ page }) => {
    await bootMobile(page);

    // Focus is what the software keyboard rides on, so the whole point of the
    // hand-driven pan is that this element still holds it afterwards.
    await page.evaluate(() => window.term.xterm.textarea.focus());
    const focused = () => page.evaluate(() => document.activeElement === window.term.xterm.textarea);
    expect(await focused()).toBe(true);

    const scrollLeft = () => page.evaluate(() => document.querySelector('.webterm-keybar-scroll').scrollLeft);
    expect(await scrollLeft()).toBe(0);

    // Record whether the browser ever handed us a non-cancellable touch event,
    // which is what a native scroll looks like from the page's side.
    await page.evaluate(() => {
      window.__uncancellable = 0;
      for (const type of ['touchmove', 'touchend']) {
        document.getElementById('webterm-keybar').addEventListener(
          type,
          (e) => {
            if (!e.cancelable) window.__uncancellable++;
          },
          { capture: true },
        );
      }
    });

    const start = await keyCentre(page, 'esc');
    await clearSent(page);
    await pan(page, start, 120);

    expect(await scrollLeft()).toBeGreaterThan(50);
    expect(await page.evaluate(() => window.__uncancellable)).toBe(0);
    expect(await focused()).toBe(true);
    // A flick past a button is not a press of it.
    expect(await sentCodes(page)).toEqual([]);
  });

  test('keyBar false keeps the layout and the modifiers but draws no strip', async ({ page }) => {
    await bootMobile(page, { keyBar: false });
    await expect(page.locator('#webterm-keybar')).toHaveCount(0);
    expect(await page.evaluate(() => window.bar.enabled)).toBe(true);
    expect(await page.evaluate(() => document.body.classList.contains('webterm-touch'))).toBe(true);
  });
});

// The leader chord, which is the reason the bar can drive tmux, screen, zellij
// or emacs at all. None of them can be reached from a phone otherwise: their
// bindings all start with a modifier held while a letter is pressed, and a
// touch screen cannot hold anything.
//
// Every assertion here is a recorded input. A chord that lights the button and
// sends nothing, or sends the leader twice, looks identical from the DOM and is
// exactly the failure worth catching.
test.describe('leader chords and rows (touch viewport)', () => {
  test.use(PHONE);

  // A tmux-shaped key set, written the way a stranger would write one:
  // nothing here knows anything about the program on the other end except its
  // leader and three of its bindings.
  const TMUX = {
    prefix: { key: 'b', code: 'KeyB', ctrl: true },
    rows: [
      {
        label: 'tmux',
        collapsible: true,
        keys: [
          { label: 'pfx', title: 'Prefix, then a key', prefix: true },
          { label: 'new', title: 'New window', key: 'c', code: 'KeyC', prefixed: true },
          { label: 'next', title: 'Next window', key: 'n', code: 'KeyN', prefixed: true },
          { label: 'prev', title: 'Last pane', key: 'o', code: 'KeyO', ctrl: true, prefixed: true },
        ],
      },
      {
        keys: [
          { label: 'esc', title: 'Escape', key: 'Escape', code: 'Escape' },
          { label: 'ctrl', title: 'Ctrl', mod: 'ctrl' },
        ],
      },
    ],
  };

  test('a chord button sends the leader and then the key, bare', async ({ page }) => {
    await bootMobile(page, TMUX);
    await clearSent(page);
    await tapKey(page, 'new');
    // Ctrl+B, then a plain c. Not Ctrl+B Ctrl+C, which is a different chord.
    expect(await sentCodes(page)).toEqual([0x02, 0x63]);

    await clearSent(page);
    await tapKey(page, 'next');
    expect(await sentCodes(page)).toEqual([0x02, 0x6e]);
  });

  test('a chord button carries the modifiers it declares', async ({ page }) => {
    await bootMobile(page, TMUX);
    await clearSent(page);
    await tapKey(page, 'prev');
    // Ctrl+B, then Ctrl+O. A chord whose second half is itself modified is
    // half of what a leader-driven program binds, and a button that dropped
    // the Ctrl would send Ctrl+B O, which is a different binding or none.
    expect(await sentCodes(page)).toEqual([0x02, 0x0f]);
  });

  test('the prefix button arms the chord for the software keyboard', async ({ page }) => {
    await bootMobile(page, TMUX);
    const pfx = (await keyCentre(page, 'pfx')).btn;

    await clearSent(page);
    await tapKey(page, 'pfx');
    expect(await sentCodes(page)).toEqual([0x02]);
    await expect(pfx).toHaveClass(/armed/);
    expect(await page.evaluate(() => window.bar.pending)).toBe(true);

    // The half of the feature the bar cannot supply buttons for: every other
    // binding the program has, typed on the keyboard proper.
    await clearSent(page);
    await page.keyboard.type('d');
    await page.waitForTimeout(80);
    expect(await sentCodes(page)).toEqual([0x64]);
    await expect(pfx).not.toHaveClass(/armed/);
  });

  test('arming by hand and then tapping a chord does not send the leader twice', async ({ page }) => {
    await bootMobile(page, TMUX);
    await tapKey(page, 'pfx');
    await clearSent(page);
    await tapKey(page, 'new');
    expect(await sentCodes(page)).toEqual([0x63]);
    await expect((await keyCentre(page, 'pfx')).btn).not.toHaveClass(/armed/);
  });

  test('a sticky modifier is cleared by a chord, not folded into it', async ({ page }) => {
    await bootMobile(page, TMUX);
    const ctrl = (await keyCentre(page, 'ctrl')).btn;
    await tapKey(page, 'ctrl');
    await expect(ctrl).toHaveClass(/armed/);

    await clearSent(page);
    await tapKey(page, 'new');
    // A stuck Ctrl folded in would make this 0x02 0x03: a different chord
    // from the one on the button, sent by a user who pressed one button.
    expect(await sentCodes(page)).toEqual([0x02, 0x63]);
    await expect(ctrl).not.toHaveClass(/armed/);
  });

  test('with no prefix configured the button is left out and a chord key sends itself', async ({ page }) => {
    await bootMobile(page, { ...TMUX, prefix: undefined });

    // A button that armed a chord which is never sent would be a lie, so it
    // is not built. The keys around it still work.
    await expect(page.locator('#webterm-keybar button', { hasText: /^pfx$/ })).toHaveCount(0);
    await clearSent(page);
    await tapKey(page, 'new');
    expect(await sentCodes(page)).toEqual([0x63]);
  });

  test('rows stack, fold away, and are remembered', async ({ page }) => {
    await bootMobile(page, TMUX);

    const rows = page.locator('.webterm-keybar-row');
    await expect(rows).toHaveCount(2);
    // Declared order is drawn order, and the typing row goes last because it
    // is the one nearest the thumb already on the keyboard.
    const first = await rows.nth(0).boundingBox();
    const second = await rows.nth(1).boundingBox();
    expect(first.y).toBeLessThan(second.y);

    const open = await keybarH(page);

    await tapKey(page, '▾');
    await expect(rows.nth(0)).toBeHidden();
    await expect(rows.nth(1)).toBeVisible();
    // Folding has to give the space back, or it is only hiding the buttons.
    expect(await keybarH(page)).toBeLessThan(open);
    expect(await paddingBottom(page)).toBeCloseTo(await keybarH(page), 0);
    expect(await page.evaluate(() => localStorage.getItem('webterm.keybar.rows'))).toBe('0');

    await bootMobile(page, TMUX);
    await expect(page.locator('.webterm-keybar-row').nth(0)).toBeHidden();
    await tapKey(page, '▴');
    await expect(page.locator('.webterm-keybar-row').nth(0)).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('webterm.keybar.rows'))).toBe('1');
  });

  test('each row pans on its own', async ({ page }) => {
    await bootMobile(page, {
      prefix: TMUX.prefix,
      rows: [
        { label: 'wide', keys: Array.from({ length: 24 }, (_, i) => ({ label: `a${i}`, key: 'a' })) },
        { label: 'also wide', keys: Array.from({ length: 24 }, (_, i) => ({ label: `b${i}`, key: 'b' })) },
      ],
    });

    const offsets = () =>
      page.evaluate(() => Array.from(document.querySelectorAll('.webterm-keybar-scroll')).map((el) => el.scrollLeft));
    expect(await offsets()).toEqual([0, 0]);

    await pan(page, await keyCentre(page, 'b0'), 120);

    const [top, bottom] = await offsets();
    expect(bottom).toBeGreaterThan(50);
    // The row the finger did not touch stayed where it was. One shared
    // scroller would move both, which puts every key on the other row
    // somewhere else between one tap and the next.
    expect(top).toBe(0);
  });
});
