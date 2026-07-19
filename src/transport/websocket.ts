import type { Transport, TransportSink } from '../types.js';

export interface WebSocketTransportOptions {
  protocols?: string | string[];
}

/**
 * A WebSocket carrying raw bytes. Message boundaries are the socket's own, so
 * no framing is imposed here.
 */
export function webSocketTransport(
  url: string | (() => string),
  options: WebSocketTransportOptions = {},
): Transport {
  let socket: WebSocket | undefined;
  let closed = false;

  return {
    name: 'websocket',

    start(sink: TransportSink) {
      return new Promise<void>((resolve, reject) => {
        const target = typeof url === 'function' ? url() : url;
        const ws = new WebSocket(target, options.protocols);
        socket = ws;
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => resolve();
        ws.onmessage = (event: MessageEvent) => {
          if (event.data instanceof ArrayBuffer) sink.data(new Uint8Array(event.data));
          else if (typeof event.data === 'string') sink.data(new TextEncoder().encode(event.data));
        };
        ws.onerror = () => {
          // The error event carries no detail by design, so a rejection before
          // open is the only signal a fallback can act on.
          if (ws.readyState !== WebSocket.OPEN) reject(new Error(`websocket failed to open: ${target}`));
        };
        ws.onclose = (event: CloseEvent) => {
          if (closed) return;
          sink.closed(event.wasClean ? undefined : new Error(`websocket closed: ${event.code}`));
        };
      });
    },

    send(bytes: Uint8Array) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(bytes as BufferSource);
    },

    close() {
      closed = true;
      try {
        socket?.close();
      } catch {
        // Already closing.
      }
      socket = undefined;
    },
  };
}
