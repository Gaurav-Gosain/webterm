// Browser tests for the window chrome.
//
// The chrome is judged by eye as much as by assertion, so this suite does two
// things: it asserts the structure, the accessibility contract and the places
// where a fractional device pixel ratio could open a seam, and it captures the
// presets as screenshots at both pixel ratios so a regression in the look is
// visible rather than merely untested.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '../..');

async function boot(page, query = '') {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`/test/fixtures/chrome.html${query}`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30_000 });
  if (errors.length) throw new Error(`the fixture threw during boot:\n${errors.join('\n')}`);
}

/** Save a screenshot under test/screenshots/<project>/, and return its path. */
async function shoot(page, testInfo, name, locator) {
  const path = resolve(ROOT, 'test/screenshots', testInfo.project.name, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await (locator ?? page).screenshot({ path });
  return path;
}

test.describe('structure', () => {
  test('renders a frame with three lights and a slot', async ({ page }) => {
    await boot(page, '?terminal=0&title=webterm');

    await expect(page.locator('.webterm-chrome-window')).toBeVisible();
    await expect(page.locator('.webterm-chrome-light')).toHaveCount(3);
    await expect(page.locator('.webterm-chrome-title')).toHaveText('webterm');

    const kinds = await page.$$eval('.webterm-chrome-light', (nodes) =>
      nodes.map((node) => node.dataset.light),
    );
    expect(kinds).toEqual(['close', 'minimize', 'maximize']);
  });

  test('the lights carry the platform colours and spacing', async ({ page }) => {
    await boot(page, '?terminal=0');

    const boxes = await page.$$eval('.webterm-chrome-light', (nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          left: rect.left,
          color: getComputedStyle(node).backgroundColor,
          radius: getComputedStyle(node).borderRadius,
        };
      }),
    );

    for (const box of boxes) {
      expect(box.width).toBeCloseTo(12, 1);
      expect(box.height).toBeCloseTo(12, 1);
      expect(box.radius).toBe('50%');
    }
    // 12px wide with an 8px gap, so 20px centre to centre.
    expect(boxes[1].left - boxes[0].left).toBeCloseTo(20, 1);
    expect(boxes[2].left - boxes[1].left).toBeCloseTo(20, 1);

    expect(boxes[0].color).toBe('rgb(255, 95, 87)');
    expect(boxes[1].color).toBe('rgb(254, 188, 46)');
    expect(boxes[2].color).toBe('rgb(40, 200, 64)');
  });

  test('an unfocused window greys its lights', async ({ page }) => {
    await boot(page, '?terminal=0');
    await page.evaluate(() => window.chrome_.setFocused(false));

    // Polled rather than read once: the colour change is a transition, so an
    // immediate read catches three different points on three interpolations.
    await expect
      .poll(async () => {
        const colors = await page.$$eval('.webterm-chrome-light', (nodes) =>
          nodes.map((node) => getComputedStyle(node).backgroundColor),
        );
        return new Set(colors).size;
      })
      .toBe(1);
  });

  test('the title is centred on the window, not on the space beside the lights', async ({
    page,
  }) => {
    await boot(page, '?terminal=0&title=a%20centred%20title');

    const offset = await page.evaluate(() => {
      const title = document.querySelector('.webterm-chrome-title').getBoundingClientRect();
      const win = document.querySelector('.webterm-chrome-window').getBoundingClientRect();
      return title.left + title.width / 2 - (win.left + win.width / 2);
    });
    expect(Math.abs(offset)).toBeLessThan(1);
  });

  test('the title bar can be omitted', async ({ page }) => {
    await boot(page, '?terminal=0&titleBar=0');
    await expect(page.locator('.webterm-chrome-titlebar')).toHaveCount(0);
    await expect(page.locator('.webterm-chrome-content')).toBeVisible();
  });
});

test.describe('accessibility', () => {
  test('decorative lights are not announced and are not focusable', async ({ page }) => {
    await boot(page, '?terminal=0');

    await expect(page.locator('.webterm-chrome-lights')).toHaveAttribute('aria-hidden', 'true');
    const tags = await page.$$eval('.webterm-chrome-light', (nodes) =>
      nodes.map((node) => node.tagName),
    );
    expect(tags).toEqual(['SPAN', 'SPAN', 'SPAN']);
    expect(await page.locator('.webterm-chrome-light').first().evaluate((n) => n.tabIndex)).toBe(
      -1,
    );
  });

  test('interactive lights are real buttons with labels, and they emit', async ({ page }) => {
    await boot(page, '?terminal=0&lights=interactive');

    await expect(page.locator('.webterm-chrome-lights')).not.toHaveAttribute('aria-hidden', 'true');
    const labels = await page.$$eval('button.webterm-chrome-light', (nodes) =>
      nodes.map((node) => node.getAttribute('aria-label')),
    );
    expect(labels).toEqual(['Close', 'Minimize', 'Maximize']);

    await page.click('button.webterm-chrome-light[data-light="close"]');
    await page.click('button.webterm-chrome-light[data-light="maximize"]');
    const events = await page.evaluate(() => window.chromeEvents);
    expect(events.close).toBe(1);
    expect(events.maximize).toBe(1);
    expect(events.minimize).toBe(0);
  });

  test('visual-only tabs stay out of the accessibility tree', async ({ page }) => {
    await boot(page, '?terminal=0&tabs=one,two,three');

    await expect(page.locator('.webterm-chrome-tabs')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('.webterm-chrome-tab')).toHaveCount(3);
    const tags = await page.$$eval('.webterm-chrome-tab', (n) => n.map((x) => x.tagName));
    expect(tags).toEqual(['DIV', 'DIV', 'DIV']);
  });

  test('interactive tabs navigate by keyboard', async ({ page }) => {
    await boot(page, '?terminal=0&tabs=one,two,three&tabsInteractive=1');

    await expect(page.locator('.webterm-chrome-tabs')).toHaveAttribute('role', 'tablist');
    // Roving tabindex: only the selected tab is a tab stop.
    expect(await page.$$eval('.webterm-chrome-tab', (n) => n.map((x) => x.tabIndex))).toEqual([
      0, -1, -1,
    ]);

    await page.locator('.webterm-chrome-tab').first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.webterm-chrome-tab').nth(1)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('End');
    await expect(page.locator('.webterm-chrome-tab').nth(2)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Wraps.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.webterm-chrome-tab').nth(0)).toHaveAttribute(
      'aria-selected',
      'true',
    );

    expect(await page.evaluate(() => window.chromeEvents.tabchange)).toEqual(['t1', 't2', 't0']);
    expect(await page.evaluate(() => window.chrome_.activeTab)).toBe('t0');
  });
});

test.describe('appearance', () => {
  test('auto follows prefers-color-scheme and an explicit choice overrides it', async ({
    page,
  }) => {
    const titleColor = () =>
      page.$eval('.webterm-chrome-title', (n) => getComputedStyle(n).color);

    await page.emulateMedia({ colorScheme: 'dark' });
    await boot(page, '?terminal=0&title=t');
    expect(await page.$eval('.webterm-chrome', (n) => n.dataset.appearance)).toBeUndefined();
    const autoDark = await titleColor();

    await page.emulateMedia({ colorScheme: 'light' });
    const autoLight = await titleColor();
    expect(autoLight).not.toBe(autoDark);

    // An explicit light frame stays light on a dark system.
    await page.emulateMedia({ colorScheme: 'dark' });
    await boot(page, '?terminal=0&title=t&appearance=light');
    expect(await titleColor()).toBe(autoLight);
  });

  test('every background preset resolves to a paintable value', async ({ page }) => {
    await boot(page, '?terminal=0');
    const names = await page.evaluate(() => Object.keys(window.backgrounds));
    expect(names.length).toBeGreaterThanOrEqual(8);

    for (const name of names) {
      await page.evaluate((n) => window.chrome_.update({ background: n }), name);
      const painted = await page.$eval('.webterm-chrome', (n) => {
        const style = getComputedStyle(n);
        return { image: style.backgroundImage, color: style.backgroundColor };
      });
      if (name === 'none') {
        expect(painted.image).toBe('none');
      } else {
        // Every preset is a gradient, which lands in background-image.
        expect(painted.image, `${name} painted nothing`).toContain('gradient');
      }
    }
  });

  test('reduced motion removes every transition', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await boot(page, '?terminal=0&tabs=one,two&tabsInteractive=1');

    const durations = await page.$$eval(
      '.webterm-chrome-light, .webterm-chrome-tab',
      (nodes) => nodes.map((node) => getComputedStyle(node).transitionDuration),
    );
    for (const duration of durations) expect(duration).toBe('0s');
  });
});

test.describe('geometry', () => {
  // A fractional container size is what turns a layout mistake into a visible
  // hairline of the decorative background between the title bar and the
  // content, so these run against one.
  const FRACTIONAL = '&hostWidth=901.5px&hostHeight=541.5px';

  test('no gap opens where the title bar meets the content', async ({ page }) => {
    await boot(page, `?terminal=0&tabs=one,two${FRACTIONAL}`);

    const strays = await page.evaluate(() => {
      const win = document.querySelector('.webterm-chrome-window').getBoundingClientRect();
      const inside = new Set(
        ['titlebar', 'tabs', 'content'].map((part) =>
          document.querySelector(`.webterm-chrome-${part}`),
        ),
      );
      const out = [];
      // Every quarter pixel down the window, skipping the rounded corners,
      // where the stage is legitimately visible past the frame's arc.
      const radius = parseFloat(
        getComputedStyle(document.querySelector('.webterm-chrome-window')).borderTopLeftRadius,
      );
      for (let y = win.top + radius; y < win.bottom - radius; y += 0.25) {
        for (const x of [win.left + 1, win.left + win.width / 2, win.right - 1]) {
          const el = document.elementFromPoint(x, y);
          let node = el;
          while (node && !inside.has(node)) node = node.parentElement;
          if (!node) out.push({ x, y, tag: el?.className ?? null });
        }
      }
      return out.slice(0, 5);
    });
    expect(strays).toEqual([]);
  });

  test('the content slot spans the full window width', async ({ page }) => {
    await boot(page, `?terminal=0${FRACTIONAL}`);
    const delta = await page.evaluate(() => {
      const win = document.querySelector('.webterm-chrome-window').getBoundingClientRect();
      const content = document.querySelector('.webterm-chrome-content').getBoundingClientRect();
      return { left: content.left - win.left, right: win.right - content.right };
    });
    expect(Math.abs(delta.left)).toBeLessThan(0.01);
    expect(Math.abs(delta.right)).toBeLessThan(0.01);
  });

  test('the radius and padding options reach the frame', async ({ page }) => {
    await boot(page, '?terminal=0&radius=18&padding=80');
    const measured = await page.evaluate(() => ({
      radius: getComputedStyle(document.querySelector('.webterm-chrome-window')).borderTopLeftRadius,
      padding: getComputedStyle(document.querySelector('.webterm-chrome')).paddingTop,
    }));
    expect(measured.radius).toBe('18px');
    expect(measured.padding).toBe('80px');
  });
});

test.describe('with a terminal inside', () => {
  test('the terminal opens into the slot and fills it', async ({ page }) => {
    await boot(page, '?title=webterm');

    const state = await page.evaluate(() => ({
      cols: window.term.cols,
      rows: window.term.rows,
      inSlot: !!document.querySelector('.webterm-chrome-content .xterm'),
    }));
    expect(state.inSlot).toBe(true);
    expect(state.cols).toBeGreaterThan(20);
    expect(state.rows).toBeGreaterThan(5);
  });

  test('contentPadding insets the grid rather than overflowing it', async ({ page }) => {
    await boot(page, '?title=t&hostWidth=900px&hostHeight=540px');
    const before = await page.evaluate(() => window.term.cols);

    await boot(page, '?title=t&hostWidth=900px&hostHeight=540px&contentPadding=24');
    const after = await page.evaluate(() => ({
      cols: window.term.cols,
      overflow: (() => {
        const slot = document.querySelector('.webterm-chrome-content').getBoundingClientRect();
        const grid = document.querySelector('.xterm-screen').getBoundingClientRect();
        return grid.right - slot.right;
      })(),
    }));
    expect(after.cols).toBeLessThan(before);
    expect(after.overflow).toBeLessThanOrEqual(0);
  });

  test('resizing the frame resizes the terminal', async ({ page }) => {
    await boot(page, '?title=webterm&hostWidth=900px&hostHeight=540px');
    const before = await page.evaluate(() => ({ cols: window.term.cols, rows: window.term.rows }));

    await page.evaluate(() => {
      const host = document.getElementById('host');
      host.style.width = '600px';
      host.style.height = '380px';
    });
    // The core debounces its fit, so wait for the grid rather than a timeout.
    await page.waitForFunction((cols) => window.term.cols < cols, before.cols, { timeout: 5000 });

    const after = await page.evaluate(() => ({ cols: window.term.cols, rows: window.term.rows }));
    expect(after.cols).toBeLessThan(before.cols);
    expect(after.rows).toBeLessThan(before.rows);
  });

  test('update() rebuilds the frame without disturbing the terminal', async ({ page }) => {
    await boot(page, '?title=before');

    const kept = await page.evaluate(() => {
      const chrome = window.chrome_;
      const content = chrome.content;
      const before = { cols: window.term.cols, node: content.firstElementChild };
      chrome.update({ title: 'after', appearance: 'light', tabs: [{ id: 'a', title: 'shell' }] });
      return {
        sameSlot: chrome.content === content,
        sameChild: chrome.content.firstElementChild === before.node,
        cols: window.term.cols === before.cols,
      };
    });
    expect(kept).toEqual({ sameSlot: true, sameChild: true, cols: true });
    await expect(page.locator('.webterm-chrome-title')).toHaveText('after');
    await expect(page.locator('.webterm-chrome-tab')).toHaveCount(1);
  });

  test('dispose removes the frame', async ({ page }) => {
    await boot(page, '?terminal=0');
    await page.evaluate(() => window.chrome_.dispose());
    await expect(page.locator('.webterm-chrome')).toHaveCount(0);
  });
});

test.describe('screenshots', () => {
  test('the preset gallery', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 920, height: 1200 });
    await page.goto('/test/fixtures/chrome-gallery.html');
    await page.waitForFunction(() => window.ready === true, null, { timeout: 30_000 });
    const path = await shoot(page, testInfo, 'presets-gallery', page.locator('#grid'));
    testInfo.attach('presets-gallery', { path, contentType: 'image/png' });
  });

  const CASES = [
    ['default-zero-config', '?title=webterm'],
    ['dark-frame-ocean', '?appearance=dark&background=ocean&title=zsh'],
    ['light-frame-slate', '?appearance=light&background=slate&theme=catppuccin-latte&title=zsh'],
    ['tabs', '?background=noir&appearance=dark&title=webterm&tabs=server,build,logs'],
    ['no-titlebar', '?titleBar=0&background=sunset&shadow=large&contentPadding=16'],
    ['left-aligned-title', '?titleAlign=left&background=dawn&title=~/projects/webterm'],
    ['no-shadow-tight-padding', '?shadow=none&padding=12&background=mint&appearance=light'],
    ['blocks', '?background=candy&title=colours&demo=blocks'],
  ];

  for (const [name, query] of CASES) {
    test(`preset ${name}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 900, height: 560 });
      await boot(page, query);
      const path = await shoot(page, testInfo, name);
      testInfo.attach(name, { path, contentType: 'image/png' });
    });
  }

  test('the frame with no terminal inside it', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 900, height: 480 });
    await boot(page, '?terminal=0&background=aurora&title=any%20content');
    await page.evaluate(() => {
      const style =
        'display:grid;place-items:center;height:100%;color:#cdd6f4;font:14px ui-sans-serif,system-ui';
      window.chrome_.content.innerHTML = `<div style="${style}">the slot takes any content</div>`;
    });
    const path = await shoot(page, testInfo, 'no-terminal');
    testInfo.attach('no-terminal', { path, contentType: 'image/png' });
  });
});
