import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clampSourceRect, fitRgba, parseControl, rgbToRgba, splitApc } from '../../src/kitty/protocol.ts';

test('numeric keys parse as numbers and everything else stays a string', () => {
  const cmd = parseControl('a=T,f=100,i=42,s=10,v=20,o=z,t=d');
  assert.equal(cmd.a, 'T');
  assert.equal(cmd.f, 100);
  assert.equal(cmd.i, 42);
  assert.equal(cmd.s, 10);
  assert.equal(cmd.v, 20);
  assert.equal(cmd.o, 'z');
  assert.equal(cmd.t, 'd');
});

test('an empty or malformed control string yields no keys rather than throwing', () => {
  assert.deepEqual(parseControl(''), {});
  assert.deepEqual(parseControl('nonsense'), {});
  assert.deepEqual(parseControl('a='), { a: '' });
});

test('an APC payload splits after the ident byte', () => {
  // xterm hands over the payload including the leading G.
  const { control, payload } = splitApc('Ga=T,f=100,i=1;YmFzZTY0');
  assert.equal(control.a, 'T');
  assert.equal(control.i, 1);
  assert.equal(payload, 'YmFzZTY0');
});

test('an APC with no payload separator yields an empty payload', () => {
  const { control, payload } = splitApc('Ga=d,d=i,i=7');
  assert.equal(control.a, 'd');
  assert.equal(control.d, 'i');
  assert.equal(control.i, 7);
  assert.equal(payload, '');
});

test('a delete selector keeps its case, which is what distinguishes freeing the data', () => {
  assert.equal(parseControl('a=d,d=I,i=3').d, 'I');
  assert.equal(parseControl('a=d,d=i,i=3').d, 'i');
});

test('RGB expands to RGBA with an opaque alpha', () => {
  const rgb = new Uint8Array([1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...rgbToRgba(rgb, 2, 1)], [1, 2, 3, 255, 4, 5, 6, 255]);
});

test('a short RGBA buffer renders the complete rows it has rather than padding', () => {
  // Padding would shift every subsequent row and tear the image; a short image
  // is the honest result of a dropped chunk.
  const width = 4;
  const rows = 2;
  const short = new Uint8Array(width * 4 * rows + 3);
  const fitted = fitRgba(short, width, 5);
  assert.equal(fitted.height, rows);
  assert.equal(fitted.data.byteLength, width * 4 * rows);
});

test('an over-long RGBA buffer is truncated to the declared size', () => {
  const width = 2;
  const height = 2;
  const long = new Uint8Array(width * height * 4 + 64);
  const fitted = fitRgba(long, width, height);
  assert.equal(fitted.height, height);
  assert.equal(fitted.data.byteLength, width * height * 4);
});

test('an exactly sized buffer is handed back untouched', () => {
  const data = new Uint8Array(2 * 2 * 4);
  const fitted = fitRgba(data, 2, 2);
  assert.equal(fitted.data, data);
  assert.equal(fitted.height, 2);
});

test('a source rectangle is clamped to the image bounds', () => {
  // drawImage throws InvalidStateError on a region that overflows the image,
  // and senders pass one defensively.
  const image = { width: 100, height: 50 };
  assert.deepEqual(clampSourceRect({ x: 0, y: 0, w: 200, h: 200 }, image), {
    x: 0,
    y: 0,
    w: 100,
    h: 50,
  });
  assert.deepEqual(clampSourceRect({ x: -10, y: -5, w: 40, h: 20 }, image), {
    x: 0,
    y: 0,
    w: 30,
    h: 15,
  });
  assert.deepEqual(clampSourceRect({ x: 10, y: 10, w: 20, h: 20 }, image), {
    x: 10,
    y: 10,
    w: 20,
    h: 20,
  });
});
