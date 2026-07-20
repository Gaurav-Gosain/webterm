# vtbench

A throughput harness: the same real byte streams go into ghostty-vt and into
xterm.js, and the time is compared on two axes.

It exists to answer the other half of the question `scripts/vtconf/` answered
for correctness. vtconf found the two emulators agree on 209 of 224 state
cases; this measures whether ghostty-vt is meaningfully faster.

## Running it

```
npm install --no-save @xterm/headless@6.1.0-beta.290

node scripts/vtbench/verify.mjs     # every driver produces the same grid
node scripts/vtbench/sanity.mjs     # every driver fills identical cells
node scripts/vtbench/run.mjs        # the benchmark
```

Run `verify.mjs` and `sanity.mjs` before quoting any number out of `run.mjs`.
They are what stops this being a benchmark of one side skipping work.

```
node scripts/vtbench/run.mjs --sizes 200x55 --streams btop,sgr-bat
node scripts/vtbench/run.mjs --reps 11 --warmup 5 --json out.json
node scripts/vtbench/run.mjs --scrollback 5000
```

Nothing needs a browser. ghostty-vt is not, and must not become, a runtime
dependency of webterm; it is vendored here only so the measurement is
re-runnable.

## What it measures

**write** Bytes per second feeding a captured stream through the parser, fed
in 64 KiB chunks, the size of a pty read. xterm.js parses asynchronously, so
each write is awaited on its completion callback rather than on its return.

**read** Milliseconds to get one full viewport of cells out into a
render-ready pool, with memoization and damage state forced cold, so it is what
a genuine full repaint costs.

**typing read** Milliseconds to produce the next frame's cells after a
one-cell write. Deliberately reported separately and labelled not
like-for-like, because ghostty-vt exposes a per-row dirty flag and
`@xterm/headless` does not.

## The drivers

| name | what it is |
| --- | --- |
| `ghostty-raw` | ghostty-vt over the raw C ABI, ~8 wasm crossings per cell on the read path, reusable write staging buffer |
| `ghostty-raw-alloc` | the same, but allocating and freeing a wasm buffer per write, which is what a naive embedding does |
| `ghostty-web` | sip's shipped bundle at the tip of `perf/viewport-read-and-coalescing`, which is the optimized read path: render-state row iterator, hoisted typed arrays, preallocated pool, per-frame memo, damage-driven row skipping |
| `xterm` | `@xterm/headless`, the version webterm ships |

Both ghostty drivers run the identical `../vtconf/vendor/ghostty-vt.wasm`.

`vendor/ghostty-web-perf.mjs` and `vendor/ghostty-web-base.mjs` are sip's
`static/ghostty-web/ghostty-web.js` at the tip of
`perf/viewport-read-and-coalescing` and at `ec3b444^` respectively. The bundle
is an ES module with no DOM dependency at import time, so it loads in plain
node once `fetch` is taught to see a file.

## Things this harness is careful about

Read these before quoting a number.

- **Scrollback is calibrated, not assumed.** xterm's `scrollback` is a line
  count; ghostty's `max_scrollback` is a byte budget, so the same number means
  nothing across the two. Set naively, ghostty retained 26,586 rows against
  xterm's 147,693 on the same stream at 200x55, which would have handed ghostty
  a large unearned win on every scrolling workload. `run.mjs` now bisects
  ghostty's byte budget per grid size until retention matches, and prints what
  it landed on.
- **Every driver fills the same fields.** All three write into a preallocated
  pool of the same shape: codepoint, fg rgb, bg rgb, style flags, width,
  hyperlink presence, grapheme length. That set is dictated by the narrowest of
  the three, which is `ghostty-web`'s cell pool. A palette colour is left
  unresolved on all three.
- **Each driver is timed in its own process.** Running all four in one process
  gave whole-stream times swinging 159 ms to 225 ms for identical work, and
  reported `ghostty-raw` as slower than its own strictly-more-work variant.
  That was one shared heap and one shared set of inline caches, not the
  parsers.
- **Streams under about 1 MiB cannot be separated.** `vim-200x55` and
  `btop-80x24` run in well under a second and their ratios move by 40 percent
  between passes. Draw write conclusions from the 4 to 8 MiB streams.
- **A stream captured at one size and replayed at another** is not what that
  program would have emitted at that size. Both emulators get identical bytes
  so the comparison holds, but the row describes a byte mix at a geometry, not
  that program at that size. See `streams/README.md`.
- **The typing-read column is not a like-for-like comparison** and is labelled
  as such in the output. ghostty's win there is its damage-tracking API, not
  its parser speed.
