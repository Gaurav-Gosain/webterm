// The script-tag build, the way sip, tuios-web and the tuios Learn tour use it.
// It must carry the transports, so a page does not write its own, and it must
// not carry vtgl, which has its own standalone.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { ROOT } from '../port.mjs';
import { boot } from './helpers.mjs';

test('the standalone exposes the core, the search and the transports', async ({ page }) => {
  await boot(page, '', 'standalone.html');

  const shape = await page.evaluate(() => {
    const W = window.WebTerm;
    return {
      WebTerm: typeof W.WebTerm,
      webSocketTransport: typeof W.webSocketTransport,
      webTransportTransport: typeof W.webTransportTransport,
      lengthPrefixCodec: typeof W.lengthPrefixCodec?.encode,
      MAX_FRAME_BYTES: W.MAX_FRAME_BYTES,
      fallback: typeof W.fallback,
      reconnecting: typeof W.reconnecting,
      BufferSearch: typeof W.BufferSearch,
      vtgl: 'vtgl' in W,
    };
  });
  expect(shape).toEqual({
    WebTerm: 'function',
    webSocketTransport: 'function',
    webTransportTransport: 'function',
    lengthPrefixCodec: 'function',
    MAX_FRAME_BYTES: 16 * 1024 * 1024,
    fallback: 'function',
    reconnecting: 'function',
    BufferSearch: 'function',
    vtgl: false,
  });
});

test('the standalone frames and unframes with the length-prefix codec', async ({ page }) => {
  await boot(page, '', 'standalone.html');
  const out = await page.evaluate(() => {
    const codec = window.WebTerm.lengthPrefixCodec;
    const a = codec.encode(new Uint8Array([0x31, 0x41]));
    const b = codec.encode(new Uint8Array([0x32]));
    const both = new Uint8Array(a.length + b.length);
    both.set(a);
    both.set(b, a.length);
    // A partial third frame stays unconsumed.
    const buf = new Uint8Array(both.length + 3);
    buf.set(both);
    buf.set([0, 0, 0], both.length);
    const { messages, consumed } = codec.decode(buf, buf.length);
    return { frame: Array.from(a), messages: messages.map((m) => Array.from(m)), consumed };
  });
  expect(out.frame).toEqual([0, 0, 0, 2, 0x31, 0x41]);
  expect(out.messages).toEqual([[0x31, 0x41], [0x32]]);
  expect(out.consumed).toBe(11);
});

test('the standalone opens a terminal, and the vtgl standalone adds vtgl', async ({ page }) => {
  await boot(page, '', 'standalone.html');
  expect(['webgl', 'canvas', 'dom']).toContain(await page.evaluate(() => window.term.renderer));

  await boot(page, '?renderer=vtgl&vtgl=1', 'standalone.html');
  expect(await page.evaluate(() => window.term.renderer)).toBe('vtgl');
});

test('the standalone bundle carries no vtgl and stays under its budget', () => {
  const bundle = readFileSync(join(ROOT, 'dist/webterm.standalone.global.js'), 'utf8');
  const vtglBundle = readFileSync(join(ROOT, 'dist/webterm-vtgl.standalone.global.js'), 'utf8');
  // vtgl's HarfBuzz glue names the wasm exports it calls. The marker is
  // checked in the vtgl bundle too, so it cannot pass by being renamed away.
  expect(vtglBundle).toContain('hb_buffer_create');
  expect(bundle).not.toContain('hb_buffer_create');
  expect(bundle.length).toBeLessThan(1_000_000);
});
