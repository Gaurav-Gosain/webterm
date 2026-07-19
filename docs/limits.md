# Limits

What does not work, what will not, and what a reference emulator disagrees with. Every entry here was checked against the code or measured on the tree at hand.

## Kitty graphics need a prerelease core, and the API has disappeared once already

`term.parser.registerApcHandler` is the overlay's only entry point. `@xterm/xterm` 6.0.0 shipped without an APC parser and is still the latest stable release: unpacking both tarballs, `registerApcHandler` occurs zero times in `lib/xterm.js` and zero times in `typings/xterm.d.ts` for 6.0.0, and zero times in either for 5.5.0. Only the `6.1.0-beta.*` line has it, which is what the devDependencies pin (`6.1.0-beta.290` at the time of writing).

The peer range is `^5.5.0 || >=6.1.0-beta.0`, and the `^5.5.0` half is optimistic. What actually carries that case is feature detection: `KittyGraphics.supported(term)` checks for the method and `open()` warns rather than throwing, so a consumer on such a build gets a working terminal without graphics. `test/browser/kitty.spec.mjs` opens with a test that asserts the parser exists, so a version bump that removes it again fails loudly rather than mysteriously.

Two shapes of the API are handled. Older builds take the identifier as a number and hand the callback the payload including the ident byte; current builds take an `IFunctionIdentifier` (`{ final: 'G' }`) and strip the ident first. `splitApc` tolerates both.

## The kitty keyboard protocol is not available at all

xterm.js does not implement it, and nothing in this package can add it, because the encoding happens inside xterm's own key handler rather than anywhere a wrapper can intercept. An application that asks for progressive enhancement (`CSI > 1 u`) gets legacy encodings, so a disambiguated Ctrl+I and Tab, or a key release event, are not obtainable here.

## Cell widths are floored by both atlas renderers, upstream

`@xterm/addon-canvas` computes `dimensions.device.char.width = Math.floor(charSizeService.width * dpr)`, `@xterm/addon-webgl` does the same with `Math.floor(this._charSizeService.width * this._devicePixelRatio)`, and both derive the cell width from it (`char.width + Math.round(letterSpacing)`).

At a device pixel ratio of 1 this is invisible. Above 1 it is not: a monospace advance of 8.4 CSS pixels (JetBrains Mono at `fontSize: 14`) is 16.8 device pixels at a ratio of 2, and every cell is drawn 16 wide instead. Any glyph that fills its full advance loses most of a device pixel off its right edge: powerline separators, box-drawing and block glyphs, Nerd Font icons.

This package cannot fix it, because it takes the renderer addons as peer dependencies rather than vendoring them. Pin `renderer: { prefer: 'dom' }` if it matters, or patch the addon in your own install.

## Reserved key capture only works in fullscreen

`navigator.keyboard.lock` is granted only to a fullscreen document, by design, so that a page cannot trap the user. `installReservedKeyCapture` takes the lock on `fullscreenchange` and drops it on leaving. Outside fullscreen, Ctrl+W closes the tab and Ctrl+T opens one, and `preventDefault` cannot stop either. There is nothing to be done about it from a web page.

## A clipboard write can still fail

The gesture-deferred retry covers the common refusal (a write with no user gesture behind it), but a browser can deny the write outright, and Safari is stricter than Chromium here. The `clipboard` event reports `written: false` so the page can surface it. Where `navigator.clipboard` is absent entirely, the `execCommand` path is deprecated: it is still implemented in every current browser and does not require a secure context, but it is not a permanent answer.

## WebGL under software rasterisation is slower than canvas

`webglAvailable()` creates a real context rather than checking for the constructor, which catches a blocklisted driver. It cannot detect SwiftShader, because there the context creates successfully and works; it is slower than the canvas renderer. Pin `renderer: { prefer: 'canvas' }` when you know you are targeting such an environment. The browser test suite runs under exactly this configuration (ANGLE over SwiftShader), which is why it asserts pixels and geometry and never a frame rate.

## The unicode widths are a policy, and ghostty-vt disagrees in six places

The corpus in `test/browser/grapheme_corpus.spec.mjs` is 45 cases measured from the real ghostty-vt wasm with mode 2027 clustering enabled. 39 agree with what xterm plus the grapheme addon plus the override table produces. Six diverge, and are asserted as expected values rather than treated as bugs:

| Case | Input | ghostty-vt | xterm here |
| --- | --- | --- | --- |
| `emoji-ri-odd` | U+1F1EF alone | 2 | 1 |
| `combining-mark-alone` | U+0301 alone | 0 | 1 |
| `devanagari-matra` | U+0928 U+093F | 2 | 1 |
| `zero-width-space-alone` | U+200B alone | 0 | 1 |
| `zero-width-joiner-alone` | U+200D alone | 0 | 1 |
| `soft-hyphen` | a U+00AD b | 3 | 2 |

Five of the six are a character written with nothing before it on the line, and they are not fixable from a width table: xterm's `InputHandler` suppresses the cursor advance only on its joining branch, and that branch needs a preceding cell to join onto. At column 0 there is none, so the codepoint gets a cell of its own. Where these same characters appear in real text (ZWNJ inside an Arabic word, ZWJ inside an emoji sequence, U+FEFF or ZWSP between letters, a combining mark after its base) the two agree exactly, and those are the cases in the corpus that matter.

The sixth, soft hyphen, is a policy difference rather than a degenerate case: xterm gives U+00AD zero width and ghostty gives it one. It cannot be changed from here either, because `InputHandler.print()` drops codepoint 173 before it ever asks a provider for a width.

A seventh case, ZWSP between two letters, was fixed rather than documented, because it was the only one that occurred in ordinary text. That fix is the whole reason `src/unicode.ts` exists.

ghostty-vt is not a dependency of this package and must not become one. It was the oracle the table was validated against; the numbers are what ship.

## The overlay reads one private field

`term._core._renderService.dimensions.css.cell` is the accurate cell box and is not public API. Two public fallbacks sit behind it: `.xterm-screen`'s client size divided by the grid, and finally a ratio derived from the font size (0.6 by 1.2), which will misplace images on a font whose metrics differ. A rename upstream degrades the overlay's positioning accuracy; it does not break it.

## What lives in memory

Three things are retained across a session, two of them by this package and one by xterm on options it sets:

| Thing | Bound | Arithmetic |
| --- | --- | --- |
| Decoded kitty bitmaps | `graphics.kitty.storageLimit`, default 128 | width times height times 4 bytes each, RGBA |
| Batched writes | One animation frame of arrivals | A reused 64 KB scratch buffer, plus the copy of each pending chunk |
| xterm scrollback | `scrollback`, default 5000 rows | 12 bytes per cell (three `Uint32` values), plus combined-character strings |

The figures in the third column are arithmetic from the code, not measurements. A rule of thumb from them: 128 stored bitmaps at 800 by 600 is about 245 MB of pixel data, so a page that shows large images should lower `storageLimit` rather than trust the default. An image with a live placement is never an eviction candidate, so the limit is a floor on retained memory only when placements are deleted as well.

There is no ceiling on placements. Each is one absolutely positioned canvas in the overlay, so a sender that emits thousands without deleting them will build a DOM of thousands of canvases.

## What it is not

This is a terminal frontend, not a terminal. It has no PTY, no session persistence, no multiplexing and no reconnect-and-replay: `reconnecting()` re-establishes a transport, and what the far end does about the missed output is the far end's problem. A deployment that needs a session to survive a closed tab wants a multiplexer (tmux, or a server-side session manager) behind the transport, and this package will render whatever that replays.

It is also not a general image-protocol implementation. Sixel and iTerm inline images come from `@xterm/addon-image` if you turn `graphics.sixel` on, and its own kitty support is forced off because the overlay owns that. Kitty animation, file-based transmission and Unicode placeholders are unimplemented and are not planned: a browser cannot read a path in the sender's filesystem, so a server that wants those to work re-encodes them into direct transmissions before they reach the page.
