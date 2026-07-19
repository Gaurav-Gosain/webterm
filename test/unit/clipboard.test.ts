import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeOsc52, encodeOsc52, parseOsc52, selectStrategy } from '../../src/clipboard.ts';

test('a custom writer outranks everything', () => {
  assert.equal(
    selectStrategy({ hasAsyncClipboard: true, hasExecCommand: true, hasCustomWriter: true }),
    'custom',
  );
});

test('the async Clipboard API is preferred when the context is secure', () => {
  assert.equal(selectStrategy({ hasAsyncClipboard: true, hasExecCommand: true }), 'async-api');
});

test('an insecure origin falls back to execCommand', () => {
  // navigator.clipboard does not exist at all on a LAN IP or behind an http
  // reverse proxy, which is the case this fallback exists for.
  assert.equal(selectStrategy({ hasAsyncClipboard: false, hasExecCommand: true }), 'exec-command');
});

test('with neither path available the strategy is none rather than a throw', () => {
  assert.equal(selectStrategy({ hasAsyncClipboard: false, hasExecCommand: false }), 'none');
});

test('an OSC 52 body splits into targets and payload', () => {
  assert.deepEqual(parseOsc52('c;aGk='), { targets: 'c', payload: 'aGk=' });
  assert.deepEqual(parseOsc52('pc;aGk='), { targets: 'pc', payload: 'aGk=' });
  // The clear form: an empty payload.
  assert.deepEqual(parseOsc52('c;'), { targets: 'c', payload: '' });
  // The read form.
  assert.deepEqual(parseOsc52('c;?'), { targets: 'c', payload: '?' });
  // A semicolon inside base64 is impossible, so the first one is the split.
  assert.equal(parseOsc52('no-separator'), undefined);
});

test('an OSC 52 payload is decoded as UTF-8, not as Latin-1', () => {
  // This is the whole point of the decoder. atob yields one JavaScript char per
  // byte and those bytes are UTF-8, so using the result directly mojibakes
  // everything outside Latin-1.
  const cases = ['hello', 'héllo wörld', '日本語のテキスト', 'emoji 👨‍👩‍👧‍👦 family', 'зд+равей'];
  for (const text of cases) {
    const bytes = new TextEncoder().encode(text);
    const b64 = Buffer.from(bytes).toString('base64');
    assert.equal(decodeOsc52(b64), text, `round trip failed for ${text}`);
  }
});

test('the naive Latin-1 read is demonstrably wrong, which is why it is not used', () => {
  const text = '日本語';
  const b64 = Buffer.from(new TextEncoder().encode(text)).toString('base64');
  const latin1 = Buffer.from(b64, 'base64').toString('latin1');
  assert.notEqual(latin1, text);
  assert.equal(decodeOsc52(b64), text);
});

test('a read response is UTF-8 encoded before base64 and terminated with ST', () => {
  const sequence = encodeOsc52('c', 'héllo');
  assert.ok(sequence.startsWith('\x1b]52;c;'));
  assert.ok(sequence.endsWith('\x1b\\'));
  const payload = sequence.slice('\x1b]52;c;'.length, -2);
  assert.equal(decodeOsc52(payload), 'héllo');
});
