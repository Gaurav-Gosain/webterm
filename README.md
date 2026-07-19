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

There is also an optional [macOS-style window frame](#window-chrome), in a
separate export that the terminal does not depend on.

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

### A plain HTML page

No bundler, no build step, no npm at runtime. The standalone build inlines
xterm.js and every addon the default path can reach, so this is one script tag.
Save it as a file and open it.

```html
<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="https://unpkg.com/@xterm/xterm/css/xterm.css" />
    <link rel="stylesheet" href="https://unpkg.com/webterm/dist/webterm.css" />
    <style>
      html, body { margin: 0; height: 100%; background: #1e1e2e; }
      #terminal { width: 100vw; height: 100vh; }
    </style>
  </head>
  <body>
    <div id="terminal" class="webterm"></div>
    <script src="https://unpkg.com/webterm/dist/webterm.standalone.global.js"></script>
    <script>
      // Renamed on the way out: a top-level `const WebTerm` in a classic
      // script would collide with the global of the same name.
      const { WebTerm: WebTermClass } = window.WebTerm;
      const term = new WebTermClass({ fontSize: 14, theme: 'catppuccin-mocha' });

      term.open(document.getElementById('terminal')).then(() => {
        term.write('hello\r\n$ ');
        // Nothing is attached, so input arrives here and goes nowhere else.
        term.on('data', (bytes) => {
          const text = new TextDecoder().decode(bytes);
          term.write(text === '\r' ? '\r\n$ ' : text);
        });
        term.focus();
      });
    </script>
  </body>
</html>
```

`.webterm` on the container is the only class the package needs, and the
container needs a size: the grid is fitted to whatever it is.

### With the window chrome

The frame is a slot. It hands back an empty element and the terminal opens into
it, so the two are independent.

```html
<link rel="stylesheet" href="https://unpkg.com/webterm/dist/chrome.css" />
<div id="demo" style="height: 460px"></div>

<script src="https://unpkg.com/webterm/dist/webterm.standalone.global.js"></script>
<script src="https://unpkg.com/webterm/dist/webterm-chrome.standalone.global.js"></script>
<script>
  const { WebTerm: WebTermClass } = window.WebTerm;
  const { createWindowChrome } = window.WebTermChrome;

  const chrome = createWindowChrome({
    title: 'zsh',
    background: 'ocean',
    contentBackground: '#1e1e2e',
    contentPadding: 10,
  });
  chrome.mount(document.getElementById('demo'));

  new WebTermClass({ theme: 'catppuccin-mocha' }).open(chrome.content).then((term) => {
    term.write('framed.\r\n');
  });
</script>
```

The chrome is a separate bundle from the terminal, so a page that only wants a
frame around a code block does not download xterm to get one.

### From a bundler

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

## API

### `new WebTerm(options?)`

Nothing happens until `open`. The constructor only records the options.

### `open(container: HTMLElement): Promise<this>`

Loads the fonts, constructs the `Terminal`, installs the providers and addons
and attaches to `container`. Asynchronous because the font load has to complete
before construction, and idempotent: a second call resolves to the same
instance rather than opening a second terminal.

### Methods

| Signature | Notes |
| --- | --- |
| `dispose(): void` | Tears down every listener, observer and addon, and removes the overlay |
| `fit(): void` | Refits the grid to the container now, ignoring the debounce |
| `resize(cols, rows): void` | Sets the grid explicitly |
| `focus(): void` / `blur(): void` | |
| `clear(): void` / `reset(): void` | |
| `write(data: Uint8Array \| string): void` | Bytes from the far end. Batched to one write per animation frame |
| `flush(): Promise<void>` | Resolves once the emulator has consumed everything written |
| `input(data: string): void` | Injects input as if typed, so it leaves through `data` and the transport |
| `paste(text: string): void` | Goes through the paste path, bracketed when the application asked |
| `attach(transport: Transport): () => void` | Replaces any current transport. Returns a detach function |
| `detach(): void` | |
| `setOptions(options: Partial<WebTermOptions>): void` | Applies live. Groups are replaced, not merged |
| `setTheme(theme: ITheme \| ThemeName): void` | |
| `on(event, listener): () => void` | Returns an unsubscribe rather than needing a matching `off` |

### Getters

| Getter | Type | Notes |
| --- | --- | --- |
| `cols` / `rows` | `number` | |
| `pixelSize` | `{ width, height }` | Rendered grid in CSS pixels, for a winsize report |
| `renderer` | `'webgl' \| 'canvas' \| 'dom'` | The one actually running, after probing and any fallback |
| `element` | `HTMLElement \| undefined` | xterm's element |
| `xterm` | `Terminal` | The underlying xterm instance. Throws before `open` |
| `kitty` | `KittyGraphics \| undefined` | The overlay, when enabled and supported |
| `image` | `ImageAddon \| undefined` | The image addon, when `graphics.sixel` loaded it |

### Events

```ts
term.on('data', (bytes: Uint8Array) => void);       // input, UTF-8, already chunked
term.on('binary', (bytes: Uint8Array) => void);     // mouse reports, after motion dedup
term.on('resize', ({ cols, rows, pixel }) => void);
term.on('title', (title: string) => void);
term.on('bell', () => void);
term.on('selection', (text: string) => void);
term.on('clipboard', ({ text, written }) => void);  // written is false if every strategy was refused
term.on('renderer', (kind: RendererKind) => void);  // including a context-loss fallback
```

`data` carries everything the terminal sends to the application, not only
keystrokes: a paste and a kitty protocol reply arrive there too, and all of it
goes to an attached transport as well.

### Options

Top level: `fontFamily`, `fontSize`, `fonts`, `lineHeight`, `theme`,
`cursorBlink`, `cursorStyle`, `scrollback`, `cols`, `rows`, `fit`, `links`.

| Group | Keys |
| --- | --- |
| `renderer` | `prefer` (`'auto'`), `fallbackOnContextLoss` (`true`) |
| `clipboard` | `osc52` (`true`), `osc52Read` (`false`), `copyOnSelect` (`false`), `write` |
| `unicode` | `provider` (`'graphemes'`), `overrides` (`{ 0x200b: 0 }`) |
| `graphics` | `kitty` (`true`), `sixel` (`false`) |
| `keyboard` | `captureReservedKeys` (`true`), `reservedKeys` |
| `mouse` | `suppressContextMenu` (`true`), `dedupeMotion` (`true`) |
| `input` | `chunkBytes` (`65536`), `readOnly` (`false`) |

Plus two escape hatches: `xterm`, a raw `ITerminalOptions` merged last so it
wins over everything the wrapper decided, and `onTerminalCreated(term)`, called
with the `Terminal` after construction and before `open`.

Every option is documented on the type, so an editor shows the reasoning
without opening this file. A few defaults are deliberate rather than
conventional and are worth knowing:

- `lineHeight` is `1`. The font's own line box already includes its line gap,
  so anything else renders glyph ink taller than the cell and leaves a
  background-coloured seam between stacked block glyphs.
- `cursorBlink` is `false`. A blinking cursor repaints an otherwise idle
  terminal forever.
- `osc52Read` is `false` and should stay false. Answering a read request echoes
  the user's system clipboard back to whatever is running on the far end.
- `fonts` exists because a CSS `@font-face` races the measurement: xterm
  measures the cell box once and caches whichever face has resolved by then.

`term.xterm` is public on purpose. No wrapper anticipates everything, and a
consumer who needs `term.parser`, `term.registerMarker` or a third-party addon
should not have to fork the package to get it.

## Kitty graphics

This is the part nothing else ships. `@xterm/addon-image` covers sixel and iTerm
inline images, and it has kitty support, but it bakes placements into the cell
buffer, so a placement cannot be moved after the fact. This one renders each
placement as an absolutely positioned canvas in a DOM layer above the grid, so
it can be repositioned, refreshed in place and deleted individually.

Supported: actions `t`, `T`, `p`, `d` and `q`; direct base64 transmission;
formats 24 (RGB), 32 (RGBA) and 100 (PNG, decoded natively with
`createImageBitmap`); zlib payloads via `DecompressionStream`; chunked
transmission; deletion by image id or placement id; and repositioning on scroll,
resize and font change.

Out of scope by design: animation, file and shared-memory transmission (a
browser cannot read a path in the server's filesystem), and Unicode placeholder
placement.

### Capability probes are answered

Kitty graphics is request/response for detection. A client emits `a=q` probes
and refuses to transmit the image at all if nothing answers, so an overlay that
renders placements but never replies makes `kitten icat` report that the
terminal has no graphics support.

Direct transmission is answered `OK`. The temp-file and shared-memory media are
answered `ENOTSUPPORTED`, which is what lets a client settle on stream mode
rather than waiting out its timeout. Replies take the same outbound path a
keystroke does, so they reach an attached transport, and a terminal with
`input.readOnly` stays silent rather than writing into someone else's session.

### Anchoring

```ts
new WebTerm({ graphics: { kitty: { anchor: 'scrollback' } } });
```

`scrollback` is the default and anchors a placement to the buffer row that
introduced it, so the image scrolls away with its text. That is what a shell
running an image viewer expects. `viewport` pins a placement to the visible grid
instead, which is what a compositor that re-emits every placement each frame
needs: under `scrollback` any newline it emitted would advance the buffer base
and park the image in scrollback history.

`storageLimit` (default 128) caps the decoded bitmaps retained before the least
recently used is evicted.

## Clipboard

Three things a browser will do to a clipboard write, and what the package does
about each.

**There is no `navigator.clipboard` outside a secure context.** Not a refused
promise, the API is simply absent. A LAN IP, an http reverse proxy or any
non-localhost deployment without TLS lands here. The fallback is a hidden
textarea and `document.execCommand('copy')`, which is deprecated but still
implemented everywhere and does not require a secure context.

**A write can be refused for want of a user gesture.** The retry is bound to the
next `pointerdown` or `keydown` and fires once, so a copy triggered by an
application rather than by the user still lands as soon as the user does
anything at all.

**A write can be refused outright.** Safari is stricter than Chromium here. The
`clipboard` event reports `written: false` so the page can say so rather than
failing silently.

OSC 52 is decoded as UTF-8, not Latin-1. `atob` yields one character per byte
and those bytes are UTF-8, so treating the result as the text mojibakes
everything outside Latin-1; this decodes them properly.

`copyOnSelect` is off by default. When on, it covers both selections: the one
xterm owns from a plain left-drag, and the native browser selection produced by
Shift+drag while an application holds mouse tracking.

Reading is a separate matter. `osc52Read` defaults to false and answering a read
request is a bad idea in almost every deployment: it hands the user's system
clipboard to whatever is running on the far end.

## Window chrome

`webterm/chrome` is an optional macOS-style frame: rounded corners, a title bar
with traffic lights, an optional title and tabs, a layered shadow, and a
decorative background with padding behind it. It is what turns an embedded
terminal in a landing page or a docs site from a black rectangle into something
that looks placed on purpose.

```ts
import { createWindowChrome } from 'webterm/chrome';
import 'webterm/chrome.css';

const chrome = createWindowChrome({ title: 'zsh', background: 'aurora' });
chrome.mount(document.getElementById('demo'));

const term = await new WebTerm().open(chrome.content);
```

It imports nothing from the terminal, so the frame works around any content and
a consumer who does not want it never loads it:

```ts
chrome.content.innerHTML = '<pre>anything at all</pre>';
```

Backgrounds ship as presets: `aurora` (the default), `candy`, `dawn`, `mint`,
`noir`, `ocean`, `slate`, `sunset`, and `none`. `background` also takes a plain
CSS value or one of `{ color }`, `{ gradient }`, `{ image }`, `{ css }`.

`appearance` defaults to `auto` and follows `prefers-color-scheme`; `light` or
`dark` pins it. Every transition is gated behind `prefers-reduced-motion: no-preference`.

The traffic lights are decorative by default and are hidden from the
accessibility tree, because a control that is announced and then does nothing is
worse than no control. `lights: { interactive: true }` makes them real buttons
with labels, reveals the platform glyphs on hover, and emits `close`,
`minimize` and `maximize`. The chrome acts on none of them: what closing means
belongs to the consumer. Tabs behave the same way, and interactive tabs get
`role="tablist"`, a roving tabindex and arrow, `Home` and `End` navigation.

Set `contentBackground` to the terminal's background colour. `fit()` rounds the
grid down to whole cells, so a few pixels of the slot are left over on the right
and bottom, and matching the colour is what keeps them from reading as a border.

`contentPadding` insets the slot. The slot is nested one level inside the padded
box on purpose: `FitAddon` subtracts only the terminal element's own padding
when it measures, never its parent's, so padding applied directly to the
terminal's container produces a grid wider than the box it sits in.

The frame is CSS custom properties throughout, under `--webterm-chrome-*`, and
nothing is injected into the document on import.

## Known limits

**Kitty graphics currently require a prerelease core, and the API has
disappeared once already.** `term.parser.registerApcHandler` is the overlay's
only entry point. `@xterm/xterm` 6.0.0 removed the APC parser outright and is
still the latest stable: it has zero occurrences of `registerApcHandler`, and
5.5.0 does not have it either. Only the `6.1.0-beta.*` line restores it, which
is what the devDependencies pin. The peer range is
`^5.5.0 || >=6.1.0-beta.0`, and the `^5.5.0` half is optimistic; what actually
carries that case is the feature detection. `open()` probes for the parser and
warns rather than throwing, so a consumer on such a build still gets a working
terminal, without graphics. The first kitty test fails with a plain message if
the parser is gone, so a version bump that removes it again is loud rather than
mysterious.

**Cell widths are rounded down by the atlas renderers, upstream.** Both
`@xterm/addon-webgl` and `@xterm/addon-canvas` compute the device cell width as
`Math.floor(advance * devicePixelRatio)`. At a device pixel ratio of 2, where a
14px advance is 16.8 device pixels, every cell is 16, and any glyph drawn to the
full advance loses most of a device pixel off its right edge: powerline
separators, box and block glyphs, Nerd Font icons. This package cannot fix it,
because it takes the addons as peer dependencies rather than vendoring them.
Pin the DOM renderer if it matters, or patch the addon in your own install.

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

**The unicode widths are a policy, and a reference VT disagrees in six places.**
The provider is the UAX 29 grapheme addon with per-codepoint overrides layered
on top, and the corpus in `test/browser/grapheme_corpus.spec.mjs` was measured
against ghostty-vt: 45 cases, 39 agreeing, 6 diverging. The divergences are all
zero-width and ambiguous-width codepoints where there is no single right answer
and terminals genuinely differ, so they are asserted as expected rather than
treated as bugs. Only U+200B is overridden by default, because a zero-width
space that occupies a cell visibly breaks alignment; the rest are left where the
addon puts them. `unicode.overrides` takes any map you prefer, and `{}` turns
the layer off. ghostty-vt is not a dependency, only the oracle the table was
checked against.

**The overlay reaches into one private field.** `term._core._renderService` is
the accurate source for the cell box and is not public API. There are two
fallbacks behind it: the rendered screen element measured against the grid,
which is public, and finally a ratio derived from the font size.

## Demo and examples

`demo/` exercises everything on one page: the terminal, a fake shell, kitty
graphics, every chrome background preset, theme switching and appearance. It is
classic script tags and relative paths, so it opens off the filesystem with no
server.

```sh
npm install && npm run build
xdg-open demo/index.html
```

`examples/` has three, smallest first: [`script-tag/`](examples/script-tag) (no
build step at all), [`bundler/`](examples/bundler) (ESM with types) and
[`websocket-transport/`](examples/websocket-transport) (a real server, with the
shipped transport, the fallback and reconnect combinators, and a hand-written
transport for a protocol with its own framing).

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

The chrome suite runs twice, at device pixel ratios 1 and 2, and writes the
preset screenshots to `test/screenshots/<project>/`. The frame is the one part
of the package whose correctness is partly a question of where an edge lands on
the device pixel grid, which is also why one of its tests samples the seams
against a deliberately fractional container size.

## License

MIT. Every dependency and peer dependency is MIT: `@xterm/xterm` and the
`addon-fit`, `addon-webgl`, `addon-canvas`, `addon-web-links`,
`addon-unicode-graphemes` and `addon-image` addons. No fonts ship with this
package; the `fonts` option loads whichever ones you have.
