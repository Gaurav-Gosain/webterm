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
export function fallback(...transports: Transport[]): Transport & { readonly active: Transport | undefined } {
  let active: Transport | undefined;

  return {
    get name() {
      return active?.name ?? 'fallback';
    },

    /** The transport that connected, or undefined before one has. */
    get active() {
      return active;
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
  /** Called each time a connection opens, the first one included. */
  onOpen?: (transport: Transport) => void;
  /** Called when a retry is scheduled, with its number (from 1) and its wait. */
  onRetry?: (attempt: number, delayMs: number) => void;
  /** Called once the last attempt has failed and no retry is left. */
  onGiveUp?: () => void;
}

/**
 * Reconnect with exponential backoff, rebuilding the transport each time
 * through the factory so a stateful one is not reused after a close.
 */
export function reconnecting(
  factory: () => Transport,
  options: ReconnectOptions = {},
): Transport & { readonly active: Transport | undefined } {
  const delayMs = options.delayMs ?? 1000;
  const factor = options.factor ?? 1.5;
  const maxAttempts = options.maxAttempts ?? 5;
  const maxDelayMs = options.maxDelayMs ?? 30_000;

  let active: Transport | undefined;
  let attempts = 0;
  let stopped = false;
  let gaveUp = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function connect(sink: TransportSink): Promise<void> {
    const transport = factory();
    active = transport;
    // One close per connection. A transport can report the same close from
    // two places (WebTransport sees it on the read loop and on `closed`), and
    // each report used to schedule its own reconnect, so one server shutdown
    // opened two connections and doubled every byte after it.
    let ended = false;
    const wrapped: TransportSink = {
      data: (bytes) => {
        // A connection that was replaced must not keep feeding the terminal.
        if (ended || active !== transport) return;
        sink.data(bytes);
      },
      closed: (error) => {
        if (ended || active !== transport) return;
        ended = true;
        if (stopped) return;
        // Report the close upward first, then retry: a consumer that wants to
        // show a disconnected state should see it during the backoff, not
        // after it.
        sink.closed(error);
        schedule(sink);
      },
    };
    try {
      await transport.start(wrapped);
    } catch (error) {
      // The rejection is this connection's close. A WebSocket that fails to
      // open also fires onclose after it, and acting on that as well would
      // schedule a second attempt next to the one the caller schedules.
      ended = true;
      throw error;
    }
    attempts = 0;
    if (!stopped && active === transport) options.onOpen?.(transport);
  }

  function schedule(sink: TransportSink): void {
    // One retry in flight at a time. A second timer would open a second
    // connection, and overwriting the handle would leave close() unable to
    // cancel the first.
    if (stopped || timer !== undefined) return;
    if (attempts >= maxAttempts) {
      // Once, even when a failed start and its late close both land here.
      if (!gaveUp) {
        gaveUp = true;
        options.onGiveUp?.();
      }
      return;
    }
    const wait = Math.min(delayMs * Math.pow(factor, attempts), maxDelayMs);
    attempts++;
    options.onRetry?.(attempts, wait);
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      connect(sink).catch(() => schedule(sink));
    }, wait);
  }

  return {
    get name() {
      return active?.name ?? 'reconnecting';
    },

    /** The transport of the current connection, or undefined after close. */
    get active() {
      return active;
    },

    start(sink: TransportSink) {
      stopped = false;
      gaveUp = false;
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
