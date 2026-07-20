# gpubench

Five terminal architectures, drawn by real GPU hardware, measured on the axis
the earlier benchmarks could not see: how much of the main thread each one
occupies while a flood is running.

Everything measured before this ran under headless Chromium, which falls back
to SwiftShader software rasterization even on a machine with an RTX 3070, and
everything measured before this reported total single-thread CPU, on which a
worker architecture's advantage is invisible by construction.

## The contenders

| id | architecture |
| --- | --- |
| c1 | xterm.js + `@xterm/addon-webgl`, everything on the main thread. The incumbent. |
| c2 | ghostty-vt wasm + `render_state_pack_viewport` + vtgl, everything on the main thread. |
| c3 | ghostty-vt wasm in a worker, viewport handed over as a transferred `ArrayBuffer`, vtgl on the main thread. |
| c4 | as c3, but the viewport lands in a double-buffered `SharedArrayBuffer`. |
| c5 | worker owns an `OffscreenCanvas`: parse, pack and draw all off the main thread. |

c2 through c5 share one `PackedSource` adapter and one vtgl renderer, so the
only thing that differs between them is thread placement and transport. They
are verified byte-identical, in cells and in pixels, before anything is timed.

## Running it

The harness must not be run headless: that is the whole point. It launches a
headed Chromium with `--class=vtbench` and immediately moves every window it
created onto Hyprland workspace 99, which is bound to a virtual `HEADLESS-2`
output. The window is genuinely visible to the compositor, so it is not
occlusion-throttled, and it never appears on a physical monitor.

```
node scripts/gpubench/run.mjs --ms 5000 --rate 4 --reps 3 --json results.json
node scripts/gpubench/agg.mjs results.json
```

Two guards run before any scenario and abort the run rather than let it degrade
silently:

- the WebGL unmasked renderer must contain `NVIDIA` and must not match
  `/swiftshader|llvmpipe|software/i`
- `requestAnimationFrame` must reach 55 callbacks in one second, because a
  window the compositor believes is occluded is throttled to about 1 Hz and
  every frame number taken through it would be fiction

`vtcore.mjs` needs a ghostty-vt wasm carrying
`ghostty_render_state_pack_viewport`, which is not in the shipped build. It was
added to `src/terminal/c/render.zig` in a ghostty worktree and the module
rebuilt; see `scripts/vtbench/drivers-packed.mjs` for the same requirement.

## What the controls are for

Two earlier harnesses in this family caught themselves lying, and the
equivalents are wired in here:

- **A pixel comparison over blank canvases passes and proves nothing.** The
  correctness gate requires the compared frames to carry more than 50 distinct
  colours and more than 1% non-background coverage before agreement counts.
- **A negative control** feeds a different stream through the same contender
  and requires both the cell checksum and the pixel hash to change. Without it,
  "all hashes equal" is consistent with hashing nothing.
- **`WebglAddon` swaps xterm's renderer in asynchronously**, so a harness that
  starts before the swap is measuring the DOM renderer. c1 waits for the swap
  and asserts `textureAtlas in renderer`, which only the WebGL renderer has,
  and refuses to run otherwise.
- **Main-thread occupancy is taken from a Chrome trace**, not from anything the
  page believes about itself, and the in-page long-task observer is collected
  alongside it as an independent second reading.
