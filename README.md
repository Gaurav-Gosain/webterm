# webterm

An embeddable browser terminal built on [xterm.js](https://xtermjs.org).

xterm.js is the emulator. What this package adds is the layer around it that
every project ends up writing again, and mostly writing wrong the first few
times:

- **Kitty graphics**, rendered as repositionable DOM canvases above the grid.
  `@xterm/addon-image` covers sixel and iTerm inline images, but its kitty
  support bakes placements into the cell buffer, so they cannot be moved. This
  one tracks scroll, resize and font changes, updates a placement in place when
  it is re-emitted, and deletes a placement without discarding the image bytes.
- **A clipboard layer that works outside a secure context.** OSC 52 decoded as
  UTF-8 rather than Latin-1, an `execCommand` fallback for a LAN IP or an http
  reverse proxy where `navigator.clipboard` does not exist at all, a retry bound
  to the next user gesture when a write is refused for want of one, and
  copy-on-select covering both xterm's selection and the native one.
- **Unicode widths checked against a reference VT.** The UAX 29 grapheme
  provider, plus an override for the codepoints where it disagrees with
  ghostty-vt in ordinary text. The corpus in `test/browser/grapheme_corpus.spec.mjs`
  was measured from the real thing.
- **The details that are cheap once you know them and expensive to rediscover.**
  Fonts awaited before the terminal is constructed, `lineHeight: 1` so block
  glyphs tile without seams, renderer probing with a context-loss fallback,
  write batching to one animation frame, SGR motion dedup, a context menu policy
  with a shift escape hatch, Keyboard Lock for reserved chords in fullscreen,
  and a cursor that does not blink by default.

Transports are not baked in. The core consumes and produces raw bytes, so an
existing protocol needs a three-method adapter and this package never learns
anything about its framing.

## Install

```sh
npm install webterm @xterm/xterm @xterm/addon-fit
```

`@xterm/xterm` and `@xterm/addon-fit` are peer dependencies, so a project that
already depends on xterm does not get a second copy. Everything else
(graphemes, webgl, canvas, image, web-links) is loaded on demand and only when
the options ask for it.

## Use

```ts
import { WebTerm } from 'webterm';
import { webSocketTransport } from 'webterm/transport';
import '@xterm/xterm/css/xterm.css';
import 'webterm/css';

const term = await new WebTerm({ fontSize: 14 }).open(document.body);
term.attach(webSocketTransport('wss://example.com/pty'));
```

With your own protocol, implement `Transport`:

```ts
term.attach({
  start(sink) {
    socket.onmessage = (event) => {
      const frame = new Uint8Array(event.data);
      // Strip whatever header your server puts on the front.
      if (frame[0] === MSG_OUTPUT) sink.data(frame.subarray(1));
    };
    socket.onclose = () => sink.closed();
  },
  send(bytes) {
    const frame = new Uint8Array(bytes.length + 1);
    frame[0] = MSG_INPUT;
    frame.set(bytes, 1);
    socket.send(frame);
  },
  close() {
    socket.close();
  },
});
```

Resize, title, bell and clipboard arrive as events rather than as side effects,
so the page decides what they mean:

```ts
term.on('resize', ({ cols, rows, pixel }) => sendWinsize(cols, rows, pixel));
term.on('title', (title) => (document.title = title));
term.on('bell', () => flash());
```

### Transport fallback

```ts
import { fallback, reconnecting, webSocketTransport, webTransportTransport } from 'webterm/transport';

term.attach(
  reconnecting(() =>
    fallback(
      webTransportTransport('https://example.com:4433/wt'),
      webSocketTransport('wss://example.com/ws'),
    ),
  ),
);
```

`fallback` falls through even when the first transport was explicitly chosen.
`typeof WebTransport !== 'undefined'` is not a capability check: Chromium
refuses a QUIC connection to a loopback origin with a self-signed certificate
hash where Firefox accepts it, so wiring `webTransportTransport` alone ships
something that works on your machine and not on your users'.

### Kitty graphics anchoring

```ts
new WebTerm({ graphics: { kitty: { anchor: 'scrollback' } } });
```

`scrollback` is the default and anchors a placement to the buffer row that
introduced it, so the image scrolls away with its text. That is what a shell
running an image viewer expects. `viewport` pins a placement to the visible grid
instead, which is what a compositor that re-emits every placement each frame
needs: under `scrollback` any newline it emitted would advance the buffer base
and park the image in scrollback history.

## Options

Every option is documented in the types. The groups are `renderer`,
`clipboard`, `unicode`, `graphics`, `keyboard`, `mouse` and `input`, plus two
escape hatches: `xterm`, merged into the xterm options last so it wins, and
`onTerminalCreated`, called with the Terminal before it is opened.

`term.xterm` is public on purpose. No wrapper anticipates everything, and a
consumer who needs `term.parser`, `term.registerMarker` or a third-party addon
should not have to fork the package to get it.

## Known limits

**Kitty graphics depend on one upstream API and it has disappeared once.**
`term.parser.registerApcHandler` is the overlay's only entry point.
`@xterm/xterm` 6.0.0 removed the APC parser entirely and 6.1.0 restored it, so
the peer range excludes 6.0.x. `open()` feature-detects the parser and warns
rather than throwing, so a consumer on such a build still gets a working
terminal without graphics.

**The kitty keyboard protocol is not available, at all.** xterm.js does not
implement it and nothing in this package can add it, because the encoding
happens inside xterm's own key handler. An application that asks for
progressive enhancement (`CSI > 1 u`) gets legacy encodings.

**Reserved key capture only works in fullscreen.** `navigator.keyboard.lock` is
granted only to a fullscreen document, by design, so a page cannot trap the
user. Outside fullscreen, Ctrl+W closes the tab and there is nothing to be done
about it.

**A clipboard write can still fail.** The gesture-deferred retry covers the
common refusal, but a browser can deny the write outright, and Safari is
stricter than Chromium here. The `clipboard` event reports `written: false` so
the page can surface it.

**WebGL under software rasterisation is slower than canvas.** The auto probe
cannot detect it, since the context creates successfully. Pin `canvas` when you
are targeting such an environment.

**The overlay reaches into one private field.** `term._core._renderService` is
the accurate source for the cell box and is not public API. There are two
fallbacks behind it: the rendered screen element measured against the grid,
which is public, and finally a ratio derived from the font size.

## Development

```sh
npm install
npm run typecheck
npm run build
npm run test:unit      # node's test runner, no browser
npm run test:browser   # playwright against the system chromium
```

The browser tests start one process, a static file server for the fixtures,
which Playwright owns and tears down. There is no application server, so a
failed run leaves nothing behind. `WEBTERM_CHROMIUM` overrides the browser path.

## License

MIT. Every dependency and peer dependency is MIT: `@xterm/xterm` and the
`addon-fit`, `addon-webgl`, `addon-canvas`, `addon-web-links`,
`addon-unicode-graphemes` and `addon-image` addons. No fonts ship with this
package; the `fonts` option loads whichever ones you have.
