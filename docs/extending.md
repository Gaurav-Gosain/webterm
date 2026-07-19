# Extending

One section per seam. Each names the interface, shows its source, states the contract, and gives a usage block.

## Transports

How bytes reach the terminal and leave it.

```ts
export interface Transport {
  /**
   * Called on attach. Resolving means connected; rejecting means the attach
   * failed and any fallback should be tried.
   */
  start(sink: TransportSink): void | Promise<void>;
  /** Bytes headed outward. Already chunked per `input.chunkBytes`. */
  send(bytes: Uint8Array): void | Promise<void>;
  close(): void;
  readonly name?: string;
}

export interface TransportSink {
  data(bytes: Uint8Array): void;
  /** Reports a clean or unclean close. Drives the reconnecting wrapper. */
  closed(error?: Error): void;
}
```

There is no framing in this interface and there never will be. A consumer with an existing protocol strips their headers in `start` and adds them in `send`; the package learns nothing about message shapes, length prefixes or keepalives.

The contract is four points. Resolving from `start` means connected, and rejecting means the attach failed, which is what `fallback()` acts on and what `reconnecting()` retries. `send` receives chunks already split at `input.chunkBytes`, so it never has to split them again; a returned promise is not awaited, so ordering is the transport's own responsibility. `sink.data` may be called with a buffer you reuse, because `BatchedWriter` copies it. `sink.closed()` may be called once; calling it after `close()` is harmless but ignored.

```ts
term.attach({
  name: 'my-protocol',
  start(sink) {
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    return new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = () => reject(new Error('connect failed'));
      this.socket.onmessage = (e) => {
        const frame = new Uint8Array(e.data);
        if (frame[0] === MSG_OUTPUT) sink.data(frame.subarray(1));
      };
      this.socket.onclose = (e) => sink.closed(e.wasClean ? undefined : new Error('dropped'));
    });
  },
  send(bytes) { this.socket.send(prefix(MSG_INPUT, bytes)); },
  close() { this.socket.close(); },
});
```

Two combinators compose transports without touching this interface. `fallback(...transports)` takes the first that connects and reports which one through `name`. `reconnecting(factory, options)` retries with exponential backoff (`delayMs` 1000, `factor` 1.5, `maxDelayMs` 30000, `maxAttempts` 5) and calls the factory afresh each time, so a stateful transport is never reused after a close. Both are in [`src/transport/combinators.ts`](../src/transport/combinators.ts).

## Frame codecs

A QUIC stream is a byte stream with no message boundaries, so `webTransportTransport` imposes one.

```ts
export interface FrameCodec {
  encode(bytes: Uint8Array): Uint8Array;
  /**
   * Pull whole messages out of `buffer`, which holds `length` valid bytes.
   * Returns the messages found and how many bytes were consumed. The caller
   * compacts the buffer.
   */
  decode(buffer: Uint8Array, length: number): { messages: Uint8Array[]; consumed: number };
}
```

The default is `lengthPrefixCodec`, a 4-byte big-endian length prefix with a 16 MB ceiling (`MAX_FRAME_BYTES`) past which `decode` throws rather than allocating. `decode` must copy the messages it returns out of the buffer, because the caller compacts that buffer underneath, and it must return `consumed: 0` rather than throwing when it has only a partial frame.

```ts
webTransportTransport('https://example.com:4433/wt', {
  framing: myCodec,
  // Resolved before connecting: a self-signed certificate hash, say.
  options: async () => ({ serverCertificateHashes: [await fetchHash()] }),
});
```

## The clipboard write path

`clipboard.write` replaces the whole strategy stack, not one layer of it.

```ts
export interface ClipboardOptions {
  osc52?: boolean;
  osc52Read?: boolean;
  copyOnSelect?: boolean;
  /** Replace the whole write path (Electron, a native host, a test double). */
  write?(text: string): void | Promise<void>;
}
```

A custom writer outranks everything: `selectStrategy` returns `'custom'` and neither `navigator.clipboard` nor `execCommand` is consulted. Resolving reports `written: true` on the `clipboard` event and rejecting reports `written: false`; there is no gesture-deferred retry on this path, because a native host has no gesture requirement to fail on.

```ts
new WebTerm({
  clipboard: {
    write: (text) => window.electron.clipboard.writeText(text),
    copyOnSelect: true,
  },
});
```

`selectStrategy` is exported separately and takes a plain environment description (`hasAsyncClipboard`, `hasExecCommand`, `hasCustomWriter`), so the decision can be tested without a document. So are `decodeOsc52`, `encodeOsc52` and `parseOsc52`, if you want to handle OSC 52 yourself with `clipboard.osc52: false`.

## The unicode width table

```ts
export interface UnicodeOptions {
  provider?: 'graphemes' | 'v6' | 'none';
  /** Codepoint to width. Default `{ 0x200b: 0 }`. Pass `{}` to disable. */
  overrides?: Record<number, 0 | 1 | 2>;
}
```

`'graphemes'` loads `@xterm/addon-unicode-graphemes` and layers the map on top. `'v6'` leaves xterm's built-in wcwidth provider alone, which has no notion of a cluster and bills every scalar of an emoji ZWJ sequence separately. `'none'` installs nothing.

What a width of 0 means in the override is worth knowing before you add entries. `OverrideProvider.charProperties` sets the join bit alongside the width, because the join is what actually suppresses the cursor advance: xterm's `InputHandler` only skips the increment on its joining branch, so a width of 0 without a join still eats a column. The provider therefore sets `shouldJoin` when the override is 0 and something precedes the codepoint, and never for a non-zero override. It also preserves the delegate's `charKind`, so the addon's segmentation state machine keeps working across the override.

```ts
// Two more zero-width codepoints, and a private-use glyph you render wide.
new WebTerm({
  unicode: { overrides: { 0x200b: 0, 0x2060: 0, 0xe0b0: 2 } },
});
```

Read the block comment at the top of [`src/unicode.ts`](../src/unicode.ts) before adding an entry. It records five codepoints and one whole general category that are deliberately left alone, with the reason for each, and at least two of them (U+00AD, U+200D) will not do what you expect if you override them.

## The renderer

```ts
export interface RendererOptions {
  /** 'auto' probes webgl2/webgl, then canvas, then dom. Default 'auto'. */
  prefer?: 'auto' | RendererKind;
  /** Fall through to the next renderer on WebGL context loss. Default true. */
  fallbackOnContextLoss?: boolean;
}
```

`prefer` is a preference rather than a demand: `'webgl'` still falls through to canvas and then dom if the context or the addon import fails, and `'dom'` is the one value that installs no addon at all, since the DOM renderer is xterm's own default. The `renderer` event fires whenever the active one changes, including a fallback that happens minutes after startup because a context was lost.

`webglAvailable()` is exported. It creates a throwaway canvas, asks for `webgl2` then `webgl`, and immediately loses the context again. It cannot detect software rasterisation, which is the case where WebGL is slower than canvas; see [limits.md](limits.md).

## The emulator itself

Two escape hatches, for the cases no wrapper anticipates:

```ts
const term = new WebTerm({
  // Merged into ITerminalOptions last, so it wins over everything above.
  xterm: { macOptionIsMeta: false, screenReaderMode: true },
  // Called after construction, before open. The only window in which a parser
  // handler can be registered before the first byte arrives.
  onTerminalCreated: (t) => {
    t.parser.registerOscHandler(9, (data) => notify(data));
    t.loadAddon(new SomeThirdPartyAddon());
  },
});
await term.open(container);
term.xterm.registerMarker(0); // Public, after open.
```

`term.xterm` throws before `open` rather than returning undefined, because the alternative is a consumer silently doing nothing on a terminal that has not been constructed yet.

## The window chrome, around anything

`createWindowChrome()` returns a frame whose `content` is an empty element. Nothing in [`src/chrome/`](../src/chrome/) imports the terminal, so the frame has no idea what goes in the slot:

```ts
import { createWindowChrome } from 'webterm/chrome';
import 'webterm/chrome.css';

const chrome = createWindowChrome({ title: 'example.ts', background: 'noir', titleBar: true });
chrome.mount(document.querySelector('#figure'));
chrome.content.innerHTML = '<pre><code>const answer = 42;</code></pre>';
```

`update(options)` merges and rebuilds everything above the slot; the slot element itself is never recreated, so an open terminal inside it survives. `setTitle`, `setTabs`, `selectTab` and `setFocused` are targeted versions of the same thing. The traffic lights and tabs emit (`close`, `minimize`, `maximize`, `tabchange`) and act on nothing, because what closing means belongs to you.

Styling is CSS custom properties under `--webterm-chrome-*`, settable through the `vars` option or a stylesheet of your own; `resolveBackground`, `backgrounds` and `shadows` are exported if you would rather compute a value than name one.

## Replacing a whole layer

[`src/webterm.ts`](../src/webterm.ts) is 558 lines and does no work of its own. It loads fonts, constructs a `Terminal`, installs seven collaborators and wires eight xterm events to an emitter. Everything it installs (`BatchedWriter`, `RendererManager`, `Clipboard`, `KittyGraphics`, `OverrideProvider`, `MotionFilter`, `chunkBytes`) is exported from the package root and takes a `Terminal` or plain data rather than a `WebTerm`.

So if the option surface is wrong for you, the orchestration file is the part to fork. Construct the `Terminal` yourself and install the two or three pieces you actually wanted:

```ts
import { Terminal } from '@xterm/xterm';
import { KittyGraphics, Clipboard } from 'webterm';

const term = new Terminal({ allowProposedApi: true, lineHeight: 1 });
term.open(container);
const overlay = new KittyGraphics(term, container, {
  anchor: 'viewport',
  respond: (data) => socket.send(new TextEncoder().encode(data)),
});
```

`allowProposedApi: true` is required for `registerApcHandler`, and `KittyGraphics.supported(term)` will tell you whether the running build has it at all.
