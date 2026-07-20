// DEC mode 2026, synchronized output, under sustained load.
//
// xterm.js honours the mode in two places, and the second one is a bug:
// `RenderService._renderRows` re-checks the mode inside the animation frame and
// declines to draw. Under output whose synchronized updates arrive more often
// than once per frame, every frame lands inside an update, and the terminal
// stops repainting outright, with the pending refresh dropped rather than
// deferred. src/sync-output.ts puts a ceiling on how long a repaint can be
// withheld.
//
// These run on the canvas renderer so the suite can read pixels back through
// `canvas.toDataURL()` on a tight loop. Screenshots cost tens of milliseconds
// each, and the tearing check has to see a 50 ms window. Nothing here asserts a
// frame rate; the assertions are repaint counts and distinct framebuffers, both
// of which are properties of the code path rather than of the rasteriser.

import { expect, test } from '@playwright/test';
import { boot } from './helpers.mjs';

const RENDERER = 'renderer=canvas';

/**
 * One frame's worth of a flood, in the shape the shipping product produces.
 *
 * webterm coalesces everything that arrives within one animation frame into a
 * single `term.write`, so the unit that reaches xterm is a chunk. Each chunk
 * here holds several complete synchronized updates and then opens one more
 * without closing it, which is what a capture bracketed end to end in mode 2026
 * does: whatever byte the chunk stops on, the mode is set. That is the whole
 * pathology. A chunk that ended on a closed update would leave the mode clear
 * at frame time and draw normally.
 */
function floodChunk(seq) {
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += `\x1b[?2026h\x1b[1;1Hflood ${seq}.${i} ${'#'.repeat(40)}\x1b[?2026l`;
  }
  out += `\x1b[?2026h\x1b[2;1Hpartial ${seq}`;
  return out;
}

/**
 * Feed `ms` of flood, one chunk per animation frame, then report what happened.
 *
 * The canvas is sampled on the same animation frames, which is the finest grain
 * available and is the grain the bug operates at.
 */
async function flood(page, ms) {
  return page.evaluate(
    ({ ms, chunkSource }) => {
      const chunk = new Function('seq', `return (${chunkSource})(seq)`);
      const encoder = new TextEncoder();
      const hashes = new Set();
      const startRenders = window.renderCount;
      let seq = 0;
      return new Promise((resolve) => {
        const t0 = performance.now();
        const tick = () => {
          const h = window.canvasHash();
          if (h !== null) hashes.add(h);
          if (performance.now() - t0 >= ms) {
            resolve({
              renders: window.renderCount - startRenders,
              distinctFrames: hashes.size,
              forced: window.term.forcedRepaints,
              chunks: seq,
              seconds: (performance.now() - t0) / 1000,
            });
            return;
          }
          window.term.write(encoder.encode(chunk(seq++)));
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    },
    { ms, chunkSource: floodChunk.toString() },
  );
}

test.describe('synchronized output, mode 2026', () => {
  test('a flood repaints with the watchdog and does not without it', async ({ page }) => {
    // The fixed arm. The watchdog is at its default 150 ms.
    await boot(page, `?${RENDERER}`);
    const fixed = await flood(page, 2000);

    // The control arm, identical in every way except that the watchdog is off,
    // which leaves xterm's behaviour untouched. It exists so that the fixed arm
    // cannot pass by accident: if this fixture ever stopped producing the
    // pathology, by dropping the mode 2026 sequences, by closing the update at
    // the end of each chunk, or by feeding slowly enough that frames land in
    // the gaps, then this arm would start repainting and fail here rather than
    // leaving the fixed arm asserting nothing.
    await boot(page, `?${RENDERER}&syncTimeout=0`);
    const control = await flood(page, 2000);

    // A terminal with nothing written to it, to prove the framebuffer hash is
    // not simply noise. Without it, "the control produced one distinct frame"
    // would be equally consistent with a hash that never changes at all.
    await boot(page, `?${RENDERER}`);
    const idle = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const hashes = new Set();
          const t0 = performance.now();
          const tick = () => {
            const h = window.canvasHash();
            if (h !== null) hashes.add(h);
            if (performance.now() - t0 >= 1000) resolve({ distinctFrames: hashes.size });
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );

    // The pathology is present: without the watchdog, a terminal being fed
    // megabytes draws nothing at all and shows one framebuffer throughout.
    expect(control.chunks).toBeGreaterThan(30);
    expect(control.renders).toBe(0);
    expect(control.distinctFrames).toBe(1);
    expect(control.forced).toBe(0);

    // The hash can tell frames apart, and does not invent differences.
    expect(idle.distinctFrames).toBe(1);

    // The fix: repaints happen, and the pixels change with them. Both are
    // asserted, because the first without the second is what the original
    // instrumentation of this bug got wrong.
    expect(fixed.renders).toBeGreaterThan(0);
    expect(fixed.forced).toBeGreaterThan(0);
    expect(fixed.distinctFrames).toBeGreaterThan(1);
  });

  test('a paced application still updates atomically', async ({ page }) => {
    // An application that writes one synchronized update in two halves with a
    // gap in the middle, alternating between two whole-screen states. If the
    // terminal ever paints inside the gap, it shows a screen that is half one
    // state and half the other, and a third framebuffer appears.
    const run = (gapMs, cycles) =>
      page.evaluate(
        ({ gapMs, cycles }) => {
          const encoder = new TextEncoder();
          const write = (s) => window.term.write(encoder.encode(s));
          const rows = window.term.xterm.rows;
          const cols = window.term.xterm.cols;
          const half = Math.floor(rows / 2);
          const band = (ch, n) => (ch.repeat(cols) + '\r\n').repeat(n);
          const hashes = new Set();
          let sampling = true;

          const sample = () => {
            if (!sampling) return;
            const h = window.canvasHash();
            if (h !== null) hashes.add(h);
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);

          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          return (async () => {
            const startForced = window.term.forcedRepaints;
            for (let i = 0; i < cycles; i++) {
              const ch = i % 2 === 0 ? 'X' : 'Y';
              write('\x1b[?2026h\x1b[H');
              write(band(ch, half));
              await sleep(gapMs);
              write(band(ch, rows - half));
              write('\x1b[?2026l');
              await sleep(120);
            }
            await sleep(200);
            sampling = false;
            return {
              distinctFrames: hashes.size,
              forced: window.term.forcedRepaints - startForced,
            };
          })();
        },
        { gapMs, cycles },
      );

    // The watchdog at its default 150 ms, against a 50 ms gap. It must not fire
    // and must not tear: the only framebuffers on screen are the two whole
    // states, plus the blank one the terminal started in.
    await boot(page, `?${RENDERER}`);
    const paced = await run(50, 8);
    expect(paced.forced).toBe(0);
    expect(paced.distinctFrames).toBeLessThanOrEqual(3);

    // The same fixture with the ceiling set below the gap, so the watchdog is
    // obliged to paint inside the update. This is the check on the check: it
    // proves the sampling is fast enough and the hash sensitive enough to see a
    // torn frame at all. Without it, "no tearing" would also be the result of a
    // detector that could never detect any.
    await boot(page, `?${RENDERER}&syncTimeout=10`);
    const torn = await run(50, 8);
    expect(torn.forced).toBeGreaterThan(0);
    expect(torn.distinctFrames).toBeGreaterThan(paced.distinctFrames);
  });

  test('an application that stops mid-update does not freeze the terminal', async ({ page }) => {
    // Forcing a repaint runs through the code that cancels xterm's own 1000 ms
    // stuck-mode timeout, so the watchdog owes that recovery itself. The first
    // cut of this fix handed the mode back unconditionally and left every
    // terminal that had ever seen a flood frozen afterwards.
    await boot(page, `?${RENDERER}`);
    const result = await page.evaluate(async () => {
      const encoder = new TextEncoder();
      const write = (s) => window.term.write(encoder.encode(s));
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      // Enough flood to make the watchdog force at least once, so xterm's own
      // timeout is cancelled and the recovery is the watchdog's to do.
      for (let i = 0; i < 40; i++) {
        write(`\x1b[?2026h\x1b[1;1Hburst ${i}\x1b[?2026l`);
      }
      await sleep(400);

      // Now stop mid-update and never send the end.
      write('\x1b[?2026h\x1b[3;1Hstopped mid-update');
      const before = window.canvasHash();
      const renders = window.renderCount;
      await sleep(900);
      return {
        painted: window.renderCount > renders,
        changed: window.canvasHash() !== before,
        modeStillSet: window.term.xterm.modes.synchronizedOutputMode,
      };
    });

    expect(result.painted).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.modeStillSet).toBe(false);
  });
});
