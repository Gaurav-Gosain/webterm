import type { Transport, TransportSink } from '../types.js';

/**
 * Try each transport in order and take the first that connects.
 *
 * This falls through even when the first transport was explicitly chosen,
 * because an honoured preference that leaves a dead page helps nobody: Chromium
 * refuses a QUIC connection to a loopback origin with a self-signed certificate
 * hash where Firefox accepts it, so a preference that works on one machine is
 * an unreachable terminal on the next. `name` reports what actually carried the
 * session, so the fallback is visible rather than silent.
 */
export function fallback(...transports: Transport[]): Transport {
  let active: Transport | undefined;

  return {
    get name() {
      return active?.name ?? 'fallback';
    },

    async start(sink: TransportSink) {
      const errors: string[] = [];
      for (const candidate of transports) {
        try {
          await candidate.start(sink);
          active = candidate;
          return;
        } catch (error) {
          errors.push(`${candidate.name ?? 'transport'}: ${String(error)}`);
          try {
            candidate.close();
          } catch {
            // A half-open candidate must not keep a socket alive behind us.
          }
        }
      }
      throw new Error(`every transport failed\n${errors.join('\n')}`);
    },

    send(bytes: Uint8Array) {
      return active?.send(bytes);
    },

    close() {
      active?.close();
      active = undefined;
    },
  };
}

export interface ReconnectOptions {
  delayMs?: number;
  factor?: number;
  maxAttempts?: number;
  maxDelayMs?: number;
}

/**
 * Reconnect with exponential backoff, rebuilding the transport each time
 * through the factory so a stateful one is not reused after a close.
 */
export function reconnecting(factory: () => Transport, options: ReconnectOptions = {}): Transport {
  const delayMs = options.delayMs ?? 1000;
  const factor = options.factor ?? 1.5;
  const maxAttempts = options.maxAttempts ?? 5;
  const maxDelayMs = options.maxDelayMs ?? 30_000;

  let active: Transport | undefined;
  let attempts = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function connect(sink: TransportSink): Promise<void> {
    const transport = factory();
    active = transport;
    const wrapped: TransportSink = {
      data: (bytes) => sink.data(bytes),
      closed: (error) => {
        if (stopped) return;
        // Report the close upward first, then retry: a consumer that wants to
        // show a disconnected state should see it during the backoff, not
        // after it.
        sink.closed(error);
        schedule(sink);
      },
    };
    await transport.start(wrapped);
    attempts = 0;
  }

  function schedule(sink: TransportSink): void {
    if (stopped || attempts >= maxAttempts) return;
    const wait = Math.min(delayMs * Math.pow(factor, attempts), maxDelayMs);
    attempts++;
    timer = setTimeout(() => {
      if (stopped) return;
      connect(sink).catch(() => schedule(sink));
    }, wait);
  }

  return {
    get name() {
      return active?.name ?? 'reconnecting';
    },

    start(sink: TransportSink) {
      stopped = false;
      attempts = 0;
      return connect(sink);
    },

    send(bytes: Uint8Array) {
      return active?.send(bytes);
    },

    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      active?.close();
      active = undefined;
    },
  };
}
