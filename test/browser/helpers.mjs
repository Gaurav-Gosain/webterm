/** Load the fixture and wait until the terminal has finished opening. */
export async function boot(page, query = '') {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
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
