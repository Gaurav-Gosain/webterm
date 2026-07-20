// Generates the README images in docs/images.
//
//   node scripts/capture/capture.mjs            # every shot
//   node scripts/capture/capture.mjs kitty tabs # named shots only
//
// Everything here is the real package doing the real thing. The page imports
// the built bundle from dist, the text on screen is the output of a real
// program on a real pty, and the kitty image is what `kitten icat` actually
// sent after webterm answered its capability probe. Nothing is mocked up and
// no failure is staged; if a shot cannot be produced, it fails loudly rather
// than falling back to something that merely looks right.
//
// Requirements: the system chromium, Playwright, ImageMagick, util-linux
// `script`, JetBrains Mono Nerd Font, and `npm run build` having been run.
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { runOnPty, startOnPty } from './pty.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const OUT = join(ROOT, 'docs/images');
const TMP = join(ROOT, 'scripts/capture/.tmp');
const PORT = Number(process.env.WEBTERM_CAPTURE_PORT ?? 7815);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROMIUM = process.env.WEBTERM_CHROMIUM ?? '/usr/bin/chromium';

const FONT = "'JetBrainsMono Nerd Font Mono', 'JetBrains Mono', monospace";
const BG = '#1e1e2e';
const BG_LIGHT = '#eff1f5';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

/** The static server for the fixture. Owned here, torn down in `finally`. */
function serve() {
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const target = join(ROOT, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!target.startsWith(ROOT)) return void res.writeHead(403).end('forbidden');
    try {
      if (!statSync(target).isFile()) throw new Error('not a file');
    } catch {
      return void res.writeHead(404).end('not found');
    }
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(target).pipe(res);
  });
  return new Promise((ok) => server.listen(PORT, '127.0.0.1', () => ok(server)));
}

/**
 * Record a command on a pty and return its raw bytes.
 *
 * Used where the same output is shown in more than one window: the program
 * really ran, and its bytes are replayed rather than nine copies of it being
 * started. Anything that talks back to the terminal is bridged live instead,
 * through runOnPty.
 */
function record(command, cols, rows, env = {}) {
  const script = `stty rows ${rows} cols ${cols} 2>/dev/null; ${command}`;
  return execFileSync('script', ['-qfec', script, '/dev/null'], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLUMNS: String(cols),
      LINES: String(rows),
      ...env,
    },
  });
}

/** Screenshot #stage at 2x and downsample to `width`, which is what keeps small type legible. */
async function shot(page, name, width) {
  const raw = join(TMP, `${name}.2x.png`);
  await page.locator('#stage').screenshot({ path: raw });
  const out = join(OUT, `${name}.png`);
  execFileSync('magick', [
    raw,
    '-filter', 'Lanczos',
    '-resize', `${width}x`,
    '-strip',
    '-define', 'png:compression-level=9',
    out,
  ]);
  const bytes = statSync(out).size;
  console.log(`  ${name}.png  ${width}px wide, ${(bytes / 1024).toFixed(0)} KB`);
}

/** Build a shot in the page and wait for the terminals to settle. */
async function build(page, spec) {
  await page.goto(`${BASE}/scripts/capture/fixture.html`);
  await page.waitForFunction(() => window.fixtureLoaded === true);
  const sizes = await page.evaluate((s) => window.build(s), spec);
  await page.waitForFunction(() => window.ready === true);
  return sizes;
}

async function feed(page, index, bytes) {
  await page.evaluate(([i, b64]) => window.feed(i, b64), [index, Buffer.from(bytes).toString('base64')]);
}

const settle = (page, ms = 400) =>
  page.evaluate(() => window.settle()).then(() => page.waitForTimeout(ms));

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

/**
 * Every background preset, alternating light and dark frames.
 *
 * A real terminal in each window rather than static markup, so the shot that
 * sells the chrome is not the one shot that is not the product. One recording
 * of `eza` is replayed into all nine.
 */
async function presets(page) {
  // EZA_CONFIG_DIR points at a directory the capture owns and that holds no
  // theme, which does two things. It stops whatever is in the operator's
  // ~/.config/eza from deciding what the shot looks like, and it drops eza back
  // to its built-in palette, which is indexed ANSI rather than 24-bit colour.
  // That second part is the whole reason the light frames were unreadable: a
  // theme file makes eza emit fixed truecolour, truecolour bypasses the xterm
  // palette entirely, and no ITheme can recolour it. The same recording then
  // came out in dark-tuned pastels in every window, including the four sitting
  // on a near-white latte background. Indexed colour goes through the palette,
  // so one recording renders dark under mocha and light under latte, which is
  // also the honest way to show that the theming works.
  const listing = record(
    'eza --long --icons=always --no-user --no-permissions --sort=size src',
    52,
    15,
    { EZA_CONFIG_DIR: join(ROOT, 'scripts/capture/eza') },
  );

  const names = ['aurora', 'ocean', 'noir', 'candy', 'slate', 'dawn', 'mint', 'sunset', 'none'];
  const cells = names.map((name, i) => {
    const dark = i % 2 === 0;
    return {
      chrome: {
        background: name === 'none' ? { color: dark ? '#0d0d11' : '#f6f7fb' } : name,
        appearance: dark ? 'dark' : 'light',
        title: name,
        padding: 26,
        radius: 9,
        contentBackground: dark ? BG : BG_LIGHT,
        contentPadding: 8,
      },
      term: {
        cols: 52,
        rows: 15,
        fontFamily: FONT,
        fontSize: 11,
        theme: dark ? 'catppuccin-mocha' : 'catppuccin-latte',
        renderer: { prefer: 'dom' },
      },
    };
  });

  await build(page, { grid: { columns: 3, cellWidth: 440, cellHeight: 300 }, cells });
  for (let i = 0; i < cells.length; i++) await feed(page, i, listing);
  await settle(page);
  await shot(page, 'chrome-presets', 1320);
}

/**
 * One window with tabs and traffic lights, running a real full-screen TUI.
 *
 * btop rather than a shell prompt because the frame has to hold something that
 * uses the whole grid: box drawing, braille plots, 256 colours and a cursor
 * parked out of the way.
 */
async function tabs(page) {
  const sizes = await build(page, {
    grid: { columns: 1, cellWidth: 1120, cellHeight: 660 },
    cells: [
      {
        chrome: {
          background: 'aurora',
          appearance: 'dark',
          tabs: {
            items: [
              { id: 'btop', title: 'btop' },
              { id: 'build', title: 'npm run build' },
              { id: 'logs', title: 'server.mjs' },
            ],
            activeId: 'btop',
          },
          padding: 40,
          radius: 10,
          shadow: 'large',
          contentBackground: BG,
        },
        // No cols/rows: the grid is fitted to the frame instead of pinned to a
        // pair of hand-picked numbers. Pinning them is what left a band of
        // unpainted background down the right of this shot. The frame is sized
        // in pixels and the grid was sized in cells, the two were chosen
        // independently, and the frame was wide enough for about thirty columns
        // more than the grid had. btop filled the grid exactly; the grid did
        // not fill the window, so the strip beyond the last column stayed at
        // the theme background while btop painted its own black up to it.
        term: {
          fontFamily: FONT,
          fontSize: 13,
          theme: 'catppuccin-mocha',
          renderer: { prefer: 'dom' },
        },
      },
    ],
  });

  // open() fits synchronously when no cols/rows are given, so the size build()
  // reports is already the final one. btop is started at exactly that, which
  // ties the winsize to the measured grid rather than to a timeout: there is no
  // window in which the program is running at a size the terminal is not.
  const { cols, rows } = sizes[0];

  // btop has to run in the foreground of the pty: backgrounded it finds no
  // controlling terminal and refuses to start. So it is captured while still
  // running and stopped afterwards, which is also the only way to catch the
  // alternate screen at all.
  const btop = startOnPty(page, 0, `btop --force-utf --config ${join(ROOT, 'scripts/capture/btop.conf')}`, {
    cols,
    rows,
    timeout: 30_000,
  });
  // Long enough for btop to have drawn its second update, so the CPU graphs
  // hold real samples rather than the empty grid of the first frame.
  await page.waitForTimeout(6000);

  // A late refit would leave btop drawing at a stale size, which is the exact
  // defect this shot used to ship. Cheap to check, and better to fail than to
  // write out a window with a dead strip down one side.
  const settled = await page.evaluate(() => window.size(0));
  if (settled.cols !== cols || settled.rows !== rows) {
    throw new Error(
      `the grid moved under btop: started at ${cols}x${rows}, ended at ${settled.cols}x${settled.rows}`,
    );
  }

  await settle(page, 200);
  await shot(page, 'chrome-tabs', 1120);
  btop.stop();
  await btop.done;
}

/**
 * `kitten icat` sending a real image, live.
 *
 * The interesting part is not the picture: it is that kitten is talking to
 * webterm. kitten probes with `a=q`, webterm answers OK for direct
 * transmission and ENOTSUPPORTED for the file media, kitten settles on stream
 * mode and sends the base64. If the probe went unanswered kitten would time
 * out and refuse to send anything, so a placement on screen is proof the
 * round trip worked. The shot fails if the overlay ends up empty.
 */
async function kitty(page) {
  const cols = 92;
  const rows = 19;

  await build(page, {
    grid: { columns: 1, cellWidth: 1040, cellHeight: 480 },
    cells: [
      {
        chrome: {
          background: 'noir',
          appearance: 'dark',
          title: 'kitten icat',
          padding: 40,
          radius: 10,
          shadow: 'large',
          contentBackground: BG,
          contentPadding: 10,
        },
        term: {
          cols,
          rows,
          fontFamily: FONT,
          fontSize: 13,
          theme: 'catppuccin-mocha',
          renderer: { prefer: 'dom' },
          graphics: { kitty: { anchor: 'scrollback' } },
        },
      },
    ],
  });

  // kitten reads the pixel geometry from TIOCGWINSZ and never sends CSI 14 t,
  // so what it needs is pixel fields in the pty's winsize. The pty here comes
  // from util-linux `script` and stty cannot set those, so the size is handed
  // to icat with --use-window-size, which is kitten's own flag for exactly
  // this. Everything after that point is real: the a=q capability probe,
  // webterm's OK, stream transfer, the PNG decode and the placement. See
  // docs/limits.md.
  const px = await page.evaluate(() => window.pixelSize(0));
  const image = 'docs/images/banner.png';
  const size = `${cols},${rows},${px.width},${px.height}`;
  const icat = `kitten icat --align left --use-window-size ${size} ${image}`;

  await runOnPty(
    page,
    0,
    [
      `printf '\\033[38;5;114m~/dev/webterm\\033[0m \\033[38;5;111mmain\\033[0m\\r\\n'`,
      `printf '\\033[38;5;245m$\\033[0m ${icat}\\r\\n\\r\\n'`,
      icat,
      `printf '\\r\\n\\033[38;5;114m~/dev/webterm\\033[0m \\033[38;5;111mmain\\033[0m\\r\\n\\033[38;5;245m$\\033[0m \\033[38;5;111m\\342\\226\\210\\033[0m'`,
    ].join('; '),
    { cols, rows, timeout: 30_000 },
  );

  await settle(page, 500);
  const count = await page.evaluate(() => window.placements(0));
  if (count < 1) {
    throw new Error(
      'kitten icat sent no image: the capability probe went unanswered or the ' +
        'placement was dropped. Not shipping a shot of an empty terminal.',
    );
  }
  console.log(`  (kitty overlay holds ${count} placement)`);
  await shot(page, 'kitty-graphics', 1040);
}

/**
 * The frame with the title bar off and a light appearance, running a real
 * program. The counterweight to the dark shots: the chrome is not a dark-mode
 * device.
 */
async function light(page) {
  const cols = 96;
  const rows = 22;
  // bat rather than anything reading the working tree, so the shot does not
  // change with the state of the checkout.
  // BAT_CONFIG_PATH for the same reason eza gets EZA_CONFIG_DIR: a bat config
  // in the operator's home would otherwise fold its own --style and --theme
  // into this, and the shot would differ from machine to machine. The theme
  // here is a light one and it is named on the command line, so the truecolour
  // bat emits is tuned for the background it lands on.
  const out = record(
    'bat --style=numbers,header --color=always --paging=never --theme="Catppuccin Latte" --line-range=1:20 src/writer.ts',
    cols,
    rows,
    { BAT_CONFIG_PATH: '/dev/null' },
  );

  await build(page, {
    grid: { columns: 1, cellWidth: 1040, cellHeight: 500 },
    cells: [
      {
        chrome: {
          background: 'slate',
          appearance: 'light',
          title: 'bat src/writer.ts',
          titleAlign: 'left',
          padding: 36,
          radius: 10,
          shadow: 'medium',
          contentBackground: BG_LIGHT,
          contentPadding: 12,
        },
        term: {
          cols,
          rows,
          fontFamily: FONT,
          fontSize: 13,
          theme: 'catppuccin-latte',
          renderer: { prefer: 'dom' },
        },
      },
    ],
  });

  await feed(page, 0, out);
  await settle(page);
  await shot(page, 'chrome-light', 1040);
}

// ---------------------------------------------------------------------------

const SHOTS = { presets, tabs, kitty, light };

async function main() {
  const wanted = process.argv.slice(2);
  const names = wanted.length ? wanted : Object.keys(SHOTS);
  for (const name of names) {
    if (!SHOTS[name]) throw new Error(`unknown shot: ${name} (have ${Object.keys(SHOTS).join(', ')})`);
  }

  mkdirSync(OUT, { recursive: true });
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  const server = await serve();
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: CHROMIUM,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--force-device-scale-factor=2',
        '--font-render-hinting=none',
      ],
    });
    const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (error) => {
      throw new Error(`the fixture threw: ${error}`);
    });

    for (const name of names) {
      console.log(`${name}:`);
      await SHOTS[name](page);
    }
  } finally {
    // Every process this script starts is closed here, on the success path and
    // on the failure path both.
    await browser?.close();
    await new Promise((ok) => server.close(ok));
    rmSync(TMP, { recursive: true, force: true });
  }
}

await main();
