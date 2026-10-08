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
import { webSocketTransport } from '../../src/transport/websocket.ts';
import { lengthPrefixCodec, webTransportTransport } from '../../src/transport/webtransport.ts';
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

test('reconnecting reports each open, each retry and the give-up', async () => {
  const { made, factory } = fakeFactory({ failStart: (i) => i >= 1 });
  const events: string[] = [];
  const transport = reconnecting(factory, {
    delayMs: 10,
    factor: 2,
    maxAttempts: 2,
    onOpen: (t) => events.push(`open ${t.name}`),
    onRetry: (attempt, wait) => events.push(`retry ${attempt} ${wait}`),
    onGiveUp: () => events.push('give up'),
  });
  const { sink } = recordingSink();
  await transport.start(sink);
  made[0]!.sink!.closed();
  mock.timers.tick(10);
  await settle();
  mock.timers.tick(20);
  await settle();
  mock.timers.tick(1000);
  await settle();
  assert.deepEqual(events, ['open fake0', 'retry 1 10', 'retry 2 20', 'give up']);
  assert.equal(made.length, 3);
});

test('reconnecting exposes the transport that is live', async () => {
  const { made, factory } = fakeFactory();
  const transport = reconnecting(factory, { delayMs: 10 });
  assert.equal(transport.active, undefined);
  await transport.start(recordingSink().sink);
  assert.equal(transport.active, made[0]);
  transport.close();
  assert.equal(transport.active, undefined);
});

test('a WebTransport handshake that fails is a rejected start, never a close', async () => {
  // A refused handshake rejects `ready` and `closed` together. The close
  // handler is registered first, so it used to run first and report a close
  // for a session that never opened. Under fallback() inside reconnecting()
  // that scheduled a retry while the fallback went on to WebSocket.
  class RefusedWebTransport {
    closed: Promise<void>;
    ready: Promise<void>;
    constructor() {
      const failure = new Error('handshake refused');
      this.closed = Promise.reject(failure);
      this.ready = Promise.reject(failure);
    }
    async createBidirectionalStream(): Promise<never> {
      throw new Error('unreachable');
    }
    close() {}
  }
  const globals = globalThis as unknown as { WebTransport?: unknown };
  const saved = globals.WebTransport;
  globals.WebTransport = RefusedWebTransport;
  mock.timers.reset();
  try {
    const { record, sink } = recordingSink();
    const transport = webTransportTransport('https://example.invalid/');
    await assert.rejects(Promise.resolve(transport.start(sink)), /handshake refused/);
    // Past CLOSE_GRACE_MS (1 s), so a close reported from the settled
    // `closed` promise would have arrived by now.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(record.closed, 0);
  } finally {
    globals.WebTransport = saved;
  }
});

test('WebTransport resolves its options before its url', async () => {
  const seen: string[] = [];
  class OpenWebTransport {
    ready = Promise.resolve();
    closed = new Promise<void>(() => {});
    constructor(url: string) {
      seen.push(url);
    }
    async createBidirectionalStream() {
      return { readable: new ReadableStream<Uint8Array>(), writable: new WritableStream<Uint8Array>() };
    }
    close() {}
  }
  const globals = globalThis as unknown as { WebTransport?: unknown };
  const saved = globals.WebTransport;
  globals.WebTransport = OpenWebTransport;
  try {
    let advertised = 'https://guess.invalid/';
    const transport = webTransportTransport(() => advertised, {
      options: async () => {
        advertised = 'https://advertised.invalid/wt';
        return {};
      },
    });
    await transport.start(recordingSink().sink);
    transport.close();
    assert.deepEqual(seen, ['https://advertised.invalid/wt']);
  } finally {
    globals.WebTransport = saved;
  }
});

test('WebTransport delivers the last bytes before it reports a close', async () => {
  // The session can report closed before the read loop has the stream's last
  // chunk. Reporting the close then dropped that chunk, which for sip was the
  // message that says the session ended.
  let pushLast!: () => void;
  let endSession!: () => void;
  class EarlyCloseWebTransport {
    ready = Promise.resolve();
    closed = new Promise<void>((resolve) => {
      endSession = resolve;
    });
    async createBidirectionalStream() {
      return {
        readable: new ReadableStream<Uint8Array>({
          start(controller) {
            pushLast = () => {
              controller.enqueue(lengthPrefixCodec.encode(new TextEncoder().encode('bye')));
              controller.close();
            };
          },
        }),
        writable: new WritableStream<Uint8Array>(),
      };
    }
    close() {}
  }
  const globals = globalThis as unknown as { WebTransport?: unknown };
  const saved = globals.WebTransport;
  globals.WebTransport = EarlyCloseWebTransport;
  mock.timers.reset();
  try {
    const events: string[] = [];
    const transport = webTransportTransport('https://example.invalid/');
    await transport.start({
      data: (bytes) => events.push(`data ${new TextDecoder().decode(bytes)}`),
      closed: () => events.push('closed'),
    });
    endSession();
    await new Promise((resolve) => setTimeout(resolve, 10));
    pushLast();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.deepEqual(events, ['data bye', 'closed']);
  } finally {
    globals.WebTransport = saved;
  }
});

test('WebTransport drops a send after the server closes, without a rejection', async () => {
  // A page that calls send() without awaiting it, as WebTerm does on every
  // keystroke, got an unhandled rejection per key once the stream was dead.
  let endStream!: () => void;
  let writes = 0;
  class ClosingWebTransport {
    ready = Promise.resolve();
    closed = new Promise<void>(() => {});
    async createBidirectionalStream() {
      return {
        readable: new ReadableStream<Uint8Array>({
          start(controller) {
            endStream = () => controller.close();
          },
        }),
        writable: new WritableStream<Uint8Array>({
          write() {
            writes++;
            if (ended) throw new Error('stream is closed');
          },
        }),
      };
    }
    close() {}
  }
  let ended = false;
  const globals = globalThis as unknown as { WebTransport?: unknown };
  const saved = globals.WebTransport;
  globals.WebTransport = ClosingWebTransport;
  mock.timers.reset();
  try {
    const { record, sink } = recordingSink();
    const transport = webTransportTransport('https://example.invalid/');
    await transport.start(sink);
    await transport.send(new Uint8Array([0x61]));
    assert.equal(writes, 1);

    ended = true;
    endStream();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(record.closed, 1);

    for (let i = 0; i < 3; i++) await transport.send(new Uint8Array([0x62]));
    assert.equal(writes, 1, 'a send after the close still reached the dead stream');
  } finally {
    globals.WebTransport = saved;
  }
});

test('a WebSocket that never opens is a rejected start, never a close', async () => {
  // A refused socket fires error and then close. The error rejects start();
  // reporting the close as well tells reconnecting() a live connection ended,
  // and it schedules a retry next to the one its caller schedules.
  class RefusedWebSocket {
    static OPEN = 1;
    readyState = 3;
    binaryType = 'blob';
    onopen?: () => void;
    onerror?: () => void;
    onclose?: (event: { wasClean: boolean; code: number }) => void;
    constructor() {
      setTimeout(() => {
        this.onerror?.();
        setTimeout(() => this.onclose?.({ wasClean: false, code: 1006 }), 0);
      }, 0);
    }
    send() {}
    close() {}
  }
  const globals = globalThis as unknown as { WebSocket?: unknown };
  const saved = globals.WebSocket;
  globals.WebSocket = RefusedWebSocket;
  mock.timers.reset();
  try {
    const { record, sink } = recordingSink();
    const transport = webSocketTransport('ws://example.invalid/');
    await assert.rejects(Promise.resolve(transport.start(sink)), /failed to open/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(record.closed, 0);
  } finally {
    globals.WebSocket = saved;
  }
});
