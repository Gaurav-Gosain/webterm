# Worker engine (prototype)

This directory holds a terminal engine that runs in a Web Worker. The worker
parses the terminal output with libghostty-vt and draws the grid with WebGL2.
The main thread only owns the canvas element and the input.

The VT and the frame builder are one WebAssembly module. The frame builder
reads cells from Ghostty's pages and writes a GPU instance buffer of 12 bytes
per cell. The worker uploads the dirty rows of that buffer and draws all cells
with one instanced call. No cell becomes a JavaScript object.

This is a prototype. It does not replace the xterm.js client, and no default
uses it.

## Files

| File | Purpose |
|---|---|
| `native/engine.c` | Frame builder, glyph cache and accuracy dumps, linked with libghostty-vt |
| `native/replay.c` | Native replay tool for the accuracy reference and for profiling |
| `src/worker.js` | Worker: wasm, glyph raster, WebGL2 draw, frame loop |
| `src/client.js` | Main thread: `WorkerTerm.mount()`, batched `write()`, `flush()`, `scroll()`, `dump()` |
| `ghostty.sh` | Fetches the pinned Ghostty, applies `patches/`, builds libghostty-vt |
| `build.sh` | Links `native/engine.c` and libghostty-vt into `dist/engine.wasm` |
| `patches/batch-sgr.patch` | Ghostty patch from Wraith (MIT, see `NOTICE`) |

## Build

You need Zig 0.16.x and, for a smaller file, `wasm-opt`.

```sh
ZIG=/path/to/zig-0.16/zig engine/ghostty.sh
ZIG=/path/to/zig-0.16/zig engine/build.sh
```

The result is `engine/dist/engine.wasm`, about 600 KB (180 KB with gzip).
It imports nothing.

To build the native reference for the accuracy check, run
`NATIVE=1 engine/ghostty.sh`. Then link `native/engine.c` and
`native/replay.c` with `.ghostty/native/lib/libghostty-vt.a`.

## Use

```js
import { WorkerTerm } from './engine/src/client.js';
const term = await WorkerTerm.mount(host, { cols: 120, rows: 40, fontFamily: 'JetBrains Mono', fonts: [{ url: '/fonts/jbm.woff2' }] });
await term.write(bytes);
await term.flush();
```
