// Wiring a real server.
//
// The core is byte-transparent: it consumes and produces raw bytes and knows
// nothing about framing, keepalives or message headers. A Transport is three
// methods, and there are two ways to get one.

import { WebTerm } from 'webterm';
import type { Transport, TransportSink } from 'webterm';
import { fallback, reconnecting, webSocketTransport, webTransportTransport } from 'webterm/transport';

import '@xterm/xterm/css/xterm.css';
import 'webterm/css';

const host = document.getElementById('app');
if (!host) throw new Error('no #app element');

const term = await new WebTerm({ fontSize: 14, theme: 'catppuccin-mocha' }).open(host);

// --- 1. The shipped transport ------------------------------------------------
//
// When the server speaks raw bytes over a socket with no framing of its own,
// this is the whole integration.

const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/pty`;
term.attach(webSocketTransport(url));

// The resize is yours to send, because only you know what your server expects.
// pixel is what a PTY winsize needs: applications that ask for the cell size in
// pixels (kitty graphics sizing, sixel scaling) get zeros without it.
term.on('resize', ({ cols, rows, pixel }) => {
  void fetch('/resize', {
    method: 'POST',
    body: JSON.stringify({ cols, rows, ...pixel }),
  });
});

// --- 2. Fallback and reconnection --------------------------------------------
//
// Two combinators, each taking and returning a Transport.

term.attach(
  reconnecting(
    () =>
      fallback(
        webTransportTransport('https://example.com:4433/wt'),
        webSocketTransport(url),
      ),
    { maxAttempts: 5, delayMs: 1000, factor: 1.5 },
  ),
);

// `fallback` falls through even when the first transport was chosen
// deliberately. `typeof WebTransport !== 'undefined'` is not a capability
// check: Chromium refuses a QUIC connection to a loopback origin with a
// self-signed certificate hash where Firefox accepts it, so shipping
// webTransportTransport alone produces something that works on your machine and
// not on your users'.

// --- 3. Your own protocol ----------------------------------------------------
//
// Most servers put something on the front of each message. Implement the three
// methods and the package never learns what it is.

const MSG_INPUT = 0x30;
const MSG_OUTPUT = 0x31;

function framedTransport(endpoint: string): Transport {
  let socket: WebSocket | undefined;

  return {
    name: 'framed',

    // Resolving means connected. Rejecting means the attach failed, which is
    // what lets `fallback` know to try the next one.
    start(sink: TransportSink) {
      return new Promise<void>((resolve, reject) => {
        socket = new WebSocket(endpoint);
        socket.binaryType = 'arraybuffer';

        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error(`${endpoint} failed`));

        socket.onmessage = (event) => {
          if (!(event.data instanceof ArrayBuffer)) return;
          const frame = new Uint8Array(event.data);
          // Strip your header and hand over the payload. Anything that is not
          // terminal output is yours to dispatch and never reaches the sink.
          if (frame[0] === MSG_OUTPUT) sink.data(frame.subarray(1));
        };

        // closed() drives the reconnecting wrapper. Pass an Error for an
        // unclean close if you want to distinguish them.
        socket.onclose = () => sink.closed();
      });
    },

    // Already chunked to input.chunkBytes, so a large paste arrives as several
    // calls rather than one frame your server may refuse.
    send(bytes: Uint8Array) {
      if (socket?.readyState !== WebSocket.OPEN) return;
      const frame = new Uint8Array(bytes.length + 1);
      frame[0] = MSG_INPUT;
      frame.set(bytes, 1);
      socket.send(frame);
    },

    close() {
      socket?.close();
      socket = undefined;
    },
  };
}

term.attach(framedTransport(url));

// A transport object may carry anything else you need. Control messages that
// are not terminal traffic (a resize, a ping) have no place in `send`, so keep
// your own handle and call your own method:
//
//   const conn = framedTransport(url);
//   term.attach(conn);
//   term.on('resize', (size) => conn.sendResize(size));
