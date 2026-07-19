import type { Transport, TransportSink } from '../types.js';

/**
 * A QUIC stream is a byte stream with no message boundaries, so one has to be
 * imposed. The default is a 4-byte big-endian length prefix; a consumer whose
 * server speaks a different scheme supplies their own.
 */
export interface FrameCodec {
  encode(bytes: Uint8Array): Uint8Array;
  /**
   * Pull whole messages out of `buffer`, which holds `length` valid bytes.
   * Returns the messages found and how many bytes were consumed. The caller
   * compacts the buffer.
   */
  decode(buffer: Uint8Array, length: number): { messages: Uint8Array[]; consumed: number };
}

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export const lengthPrefixCodec: FrameCodec = {
  encode(bytes) {
    const frame = new Uint8Array(4 + bytes.length);
    new DataView(frame.buffer).setUint32(0, bytes.length, false);
    frame.set(bytes, 4);
    return frame;
  },

  decode(buffer, length) {
    const messages: Uint8Array[] = [];
    let offset = 0;
    while (length - offset >= 4) {
      const size = new DataView(buffer.buffer, buffer.byteOffset + offset, 4).getUint32(0, false);
      if (size > MAX_FRAME_BYTES) throw new Error(`frame too large: ${size}`);
      if (length - offset < 4 + size) break;
      // Copied out: the caller compacts the buffer under us.
      messages.push(buffer.slice(offset + 4, offset + 4 + size));
      offset += 4 + size;
    }
    return { messages, consumed: offset };
  },
};

export interface WebTransportOptions {
  /**
   * Resolved before connecting, for a self-signed certificate hash or any
   * other option the WebTransport constructor takes.
   */
  options?: () => Promise<Record<string, unknown>>;
  framing?: FrameCodec;
}

/**
 * WebTransport over a single bidirectional stream.
 *
 * Availability is not a capability check: `typeof WebTransport !== 'undefined'`
 * is true in Chromium even where a connection to a loopback origin with a
 * self-signed certificate hash will be refused, and Firefox accepts the same
 * connection. Wire this behind `fallback()` rather than on its own.
 */
export function webTransportTransport(
  url: string | (() => string),
  config: WebTransportOptions = {},
): Transport {
  const codec = config.framing ?? lengthPrefixCodec;
  let transport: { close(): void; closed: Promise<unknown>; ready: Promise<unknown>; createBidirectionalStream(): Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }> } | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let shutdown = false;

  async function readLoop(sink: TransportSink): Promise<void> {
    let buffer = new Uint8Array(64 * 1024);
    let length = 0;

    try {
      for (;;) {
        const { value, done } = await reader!.read();
        if (done) break;
        if (!value) continue;

        if (length + value.length > buffer.length) {
          const grown = new Uint8Array(Math.max(buffer.length * 2, length + value.length));
          grown.set(buffer.subarray(0, length));
          buffer = grown;
        }
        buffer.set(value, length);
        length += value.length;

        const { messages, consumed } = codec.decode(buffer, length);
        for (const message of messages) sink.data(message);
        if (consumed > 0) {
          if (length > consumed) buffer.copyWithin(0, consumed, length);
          length -= consumed;
        }
      }
      if (!shutdown) sink.closed();
    } catch (error) {
      if (!shutdown) sink.closed(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return {
    name: 'webtransport',

    async start(sink: TransportSink) {
      if (typeof WebTransport === 'undefined') throw new Error('WebTransport is not supported here');
      const target = typeof url === 'function' ? url() : url;
      const options = config.options ? await config.options() : {};

      const wt = new WebTransport(target, options as never) as unknown as NonNullable<typeof transport>;
      transport = wt;
      wt.closed.then(
        () => {
          if (!shutdown) sink.closed();
        },
        (error: unknown) => {
          if (!shutdown) sink.closed(error instanceof Error ? error : new Error(String(error)));
        },
      );
      await wt.ready;

      const stream = await wt.createBidirectionalStream();
      writer = stream.writable.getWriter();
      reader = stream.readable.getReader();
      void readLoop(sink);
    },

    async send(bytes: Uint8Array) {
      if (!writer) return;
      await writer.write(codec.encode(bytes));
    },

    close() {
      shutdown = true;
      try {
        writer?.releaseLock();
      } catch {
        // The stream may already be errored.
      }
      try {
        reader?.releaseLock();
      } catch {
        // Same.
      }
      try {
        transport?.close();
      } catch {
        // Already closed.
      }
      writer = undefined;
      reader = undefined;
      transport = undefined;
    },
  };
}
