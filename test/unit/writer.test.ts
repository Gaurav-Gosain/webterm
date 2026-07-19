import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Terminal } from '@xterm/xterm';

import { BatchedWriter } from '../../src/writer.ts';

// The writer schedules its flush on a frame. These tests drive flushSync
// directly, so the scheduled callback only has to be cancellable, never to run.
const frames = new Map<number, () => void>();
let nextFrame = 0;
const globals = globalThis as unknown as {
  requestAnimationFrame: (fn: () => void) => number;
  cancelAnimationFrame: (handle: number) => void;
};
globals.requestAnimationFrame = (fn) => {
  frames.set(++nextFrame, fn);
  return nextFrame;
};
globals.cancelAnimationFrame = (handle) => {
  frames.delete(handle);
};

/**
 * A terminal that behaves like xterm's write buffer: it keeps the array it was
 * handed and parses it later, on its own schedule.
 *
 * That is the whole point of these tests. `Terminal.write` does not copy and
 * does not parse before it returns; it pushes the reference onto a queue that
 * is drained across later tasks under a time budget. Anything the caller does
 * to those bytes in the meantime lands in the terminal.
 */
class DeferredTerminal {
  readonly queued: Uint8Array[] = [];
  private readonly callbacks: Array<(() => void) | undefined> = [];

  write(data: Uint8Array | string, callback?: () => void): void {
    this.queued.push(typeof data === 'string' ? new TextEncoder().encode(data) : data);
    this.callbacks.push(callback);
  }

  /** Parse everything queued, returning what was actually read off the wire. */
  drain(): string[] {
    const decoder = new TextDecoder();
    const parsed = this.queued.map((chunk) => decoder.decode(chunk));
    for (const callback of this.callbacks) callback?.();
    this.queued.length = 0;
    this.callbacks.length = 0;
    return parsed;
  }
}

function writerOver(term: DeferredTerminal): BatchedWriter {
  return new BatchedWriter(term as unknown as Terminal);
}

/** Two or more chunks, so the writer takes its combining path. */
function feed(writer: BatchedWriter, text: string): void {
  const bytes = new TextEncoder().encode(text);
  const half = Math.floor(bytes.length / 2);
  writer.write(bytes.subarray(0, half));
  writer.write(bytes.subarray(half));
}

test('a batch that is still unparsed is not overwritten by the next one', () => {
  // The defect: the writer combined into one reused scratch buffer and handed
  // xterm a view into it. When a frame's data had not been parsed yet, the next
  // frame wrote over the bytes still sitting in the queue, and the terminal
  // rendered the second batch twice and the first not at all.
  const term = new DeferredTerminal();
  const writer = writerOver(term);

  feed(writer, 'first batch of output\r\n');
  writer.flushSync();
  feed(writer, 'second batch, quite different\r\n');
  writer.flushSync();

  assert.deepEqual(term.drain(), ['first batch of output\r\n', 'second batch, quite different\r\n']);
});

test('the scratch is borrowed again once the terminal has parsed it', () => {
  // The fix must not cost the allocation-free path in the ordinary case, where
  // each frame is parsed before the next arrives.
  const term = new DeferredTerminal();
  const writer = writerOver(term);

  feed(writer, 'alpha');
  writer.flushSync();
  const first = term.queued[0];
  assert.deepEqual(term.drain(), ['alpha']);

  feed(writer, 'omega');
  writer.flushSync();
  assert.equal(
    term.queued[0].buffer,
    first.buffer,
    'a parsed batch releases the scratch, so the next one reuses it',
  );
  assert.deepEqual(term.drain(), ['omega']);
});

test('many unparsed batches all survive', () => {
  const term = new DeferredTerminal();
  const writer = writerOver(term);

  const expected: string[] = [];
  for (let i = 0; i < 12; i++) {
    const text = `batch ${i} ${'x'.repeat(i * 7)}\r\n`;
    expected.push(text);
    feed(writer, text);
    writer.flushSync();
  }

  assert.deepEqual(term.drain(), expected);
});

test('a single chunk is passed straight through', () => {
  const term = new DeferredTerminal();
  const writer = writerOver(term);

  writer.write(new TextEncoder().encode('lone'));
  writer.flushSync();
  assert.deepEqual(term.drain(), ['lone']);
});

test('a string is handed over without going through the batch', () => {
  const term = new DeferredTerminal();
  const writer = writerOver(term);

  writer.write('typed');
  assert.deepEqual(term.drain(), ['typed']);
});
