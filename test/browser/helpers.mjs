import { ROOT } from '../port.mjs';

/** Checked once per worker rather than once per boot. */
let servedRoot;

/**
 * Fail loudly when the server answering is not this checkout's.
 *
 * Every suite loads the built bundle over http, so a server started from a
 * different worktree serves that worktree's dist/ and the run asserts against
 * a build the tree does not contain. That failure is unreadable from inside a
 * test: it surfaces as a missing property on an object that plainly has it in
 * the source. This turns it into one sentence naming both directories.
 */
async function checkServedRoot(page) {
  if (servedRoot === ROOT) return;
  const response = await page.request.get('/__root');
  if (!response.ok()) {
    throw new Error(
      `the fixture server did not answer /__root, so it is not this package's ` +
        `server. Something else is listening on the test port.`,
    );
  }
  const { root } = await response.json();
  if (root !== ROOT) {
    throw new Error(
      `the fixture server is serving a different checkout, so this run would ` +
        `test that build rather than this one.\n  serving: ${root}\n  expected: ${ROOT}\n` +
        `Stop the stray server, or set WEBTERM_TEST_PORT to a free port.`,
    );
  }
  servedRoot = root;
}

/** Load the fixture and wait until the terminal has finished opening. */
export async function boot(page, query = '') {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await checkServedRoot(page);
  await page.goto(`/test/fixtures/terminal.html${query}`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30_000 });
  if (errors.length) throw new Error(`the fixture threw during boot:\n${errors.join('\n')}`);
  return page;
}

/** Base64 for an APC payload, from bytes. */
export function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/** A solid RGBA image, `width` by `height`, as raw bytes. */
export function solidRgba(width, height, [r, g, b, a = 255]) {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = a;
  }
  return out;
}

/** A kitty APC sequence, ready to write into the terminal. */
export function apc(control, payload = '') {
  return `\x1b_G${control}${payload ? `;${payload}` : ''}\x1b\\`;
}
