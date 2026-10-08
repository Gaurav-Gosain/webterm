/**
 * Close handling in the transport combinators and in the WebTransport
 * transport.
 *
 * A close that is reported twice must still end one connection and open one
 * replacement. Before the fix, each report scheduled its own reconnect, so one
 * server shutdown opened two connections, both fed the terminal, and output
 * doubled.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';

import { reconnecting } from '../../src/transport/combinators.ts';
import { webTransportTransport } from '../../src/transport/webtransport.ts';
import type { Transport, TransportSink } from '../../src/types.ts';

/** A transport the test drives by hand. */
interface Fake extends Transport {
  sink?: TransportSink;
  closedByUs: boolean;
}

function fakeFactory(options: { failStart?: (index: number) => boolean } = {}) {
  const made: Fake[] = [];
  const factory = (): Transport => {
    const index = made.length;
    const fake: Fake = {
      name: `fake${index}`,
      closedByUs: false,
      async start(sink) {
        fake.sink = sink;
        if (options.failStart?.(index)) {
          // What a WebSocket that fails to open does: the start rejects, and
          // onclose reports the same failure again on a later task.
          setTimeout(() => sink.closed(new Error('late onclose')), 0);
          throw new Error('failed to open');
        }
      },
      send() {},
      close() {
        fake.closedByUs = true;
      },
    };
    made.push(fake);
    return fake;
  };
  return { made, factory };
}

/** Let pending promise continuations run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function recordingSink() {
  const record = { data: [] as string[], closed: 0 };
  const sink: TransportSink = {
    data: (bytes) => record.data.push(new TextDecoder().decode(bytes)),
    closed: () => record.closed++,
  };
  return { record, sink };
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] });
});

afterEach(() => {
  mock.timers.reset();
});

test('a connection that reports closed twice opens one replacement, not two', async () => {
  const { made, factory } = fakeFactory();
  const { record, sink } = recordingSink();
  const transport = reconnecting(factory, { delayMs: 10 });

  await transport.start(sink);
  assert.equal(made.length, 1);

  made[0].sink!.closed();
  made[0].sink!.closed();
  mock.timers.tick(1000);
  await settle();

  assert.equal(made.length, 2, 'one close, one replacement');
  assert.equal(record.closed, 1, 'the consumer hears about the close once');
  transport.close();
});

test('a replaced connection no longer feeds the terminal', async () => {
  const { made, factory } = fakeFactory();
  const { record, sink } = recordingSink();
  const transport = reconnecting(factory, { delayMs: 10 });

  await transport.start(sink);
  made[0].sink!.closed();
  mock.timers.tick(10);
  await settle();
  assert.equal(made.length, 2);

  made[0].sink!.data(new TextEncoder().encode('stale'));
  made[1].sink!.data(new TextEncoder().encode('live'));
  assert.deepEqual(record.data, ['live']);
  transport.close();
});

test('a retry that fails and then reports onclose schedules one more retry', async () => {
  // Attempt 0 connects, attempt 1 fails to open, attempt 2 connects.
  const { made, factory } = fakeFactory({ failStart: (index) => index === 1 });
  const { sink } = recordingSink();
  const transport = reconnecting(factory, { delayMs: 10, factor: 1 });

  await transport.start(sink);
  made[0].sink!.closed();
  mock.timers.tick(10);
  await settle();
  assert.equal(made.length, 2, 'the first retry ran and failed');

  // Runs the late onclose and every timer that could be pending.
  for (let i = 0; i < 10; i++) {
    mock.timers.tick(10);
    await settle();
  }
  assert.equal(made.length, 3, 'the failure and its late onclose lead to one retry');
  transport.close();
});

test('close cancels the pending retry', async () => {
  const { made, factory } = fakeFactory();
  const { sink } = recordingSink();
  const transport = reconnecting(factory, { delayMs: 10 });

  await transport.start(sink);
  made[0].sink!.closed();
  made[0].sink!.closed();
  transport.close();
  mock.timers.tick(1000);
  await settle();
  assert.equal(made.length, 1);
});

test('WebTransport reports a server close once', async () => {
  // A server-initiated close ends the read loop and settles `wt.closed`, and
  // both used to report it.
  let endStream!: () => void;
  let endSession!: () => void;
  class FakeWebTransport {
    ready = Promise.resolve();
    closed = new Promise<void>((resolve) => {
      endSession = resolve;
    });
    async createBidirectionalStream() {
      return {
        readable: new ReadableStream<Uint8Array>({
          start(controller) {
            endStream = () => controller.close();
          },
        }),
        writable: new WritableStream<Uint8Array>(),
      };
    }
    close() {}
  }
  const globals = globalThis as unknown as { WebTransport?: unknown };
  const saved = globals.WebTransport;
  globals.WebTransport = FakeWebTransport;
  mock.timers.reset();
  try {
    const { record, sink } = recordingSink();
    const transport = webTransportTransport('https://example.invalid/');
    await transport.start(sink);

    endStream();
    endSession();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(record.closed, 1);
  } finally {
    globals.WebTransport = saved;
  }
});
