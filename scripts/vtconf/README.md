# vtconf

A differential conformance harness: the same bytes go into ghostty-vt and into
xterm.js, and the resulting terminal state is compared.

It exists to answer one question with numbers rather than impressions: how much
VT protocol and mode conformance does xterm.js actually lack next to ghostty-vt?
The unicode width and grapheme axis is deliberately not measured here, because
it is already measured, against the same ghostty-vt build, by
`test/browser/grapheme_corpus.spec.mjs`.

## Running it

```
node scripts/vtconf/run.mjs                  # summary
node scripts/vtconf/run.mjs --verbose        # full text diffs
node scripts/vtconf/run.mjs --only cursor    # one category
node scripts/vtconf/run.mjs --only query     # the reply/report axis only
node scripts/vtconf/run.mjs --case decstr    # one case
node scripts/vtconf/run.mjs --json out.json  # machine-readable results
```

Nothing needs a browser. `@xterm/headless` must be installed at the same
version as the `@xterm/xterm` this package vendors:

```
npm install --no-save @xterm/headless@6.1.0-beta.290
```

## How it works

`ghostty.mjs` drives `vendor/ghostty-vt.wasm` over its raw C ABI. The module
has exactly one import (`env.log`), so it runs in plain node. Struct layouts
came from the module's own `ghostty_type_json()`; the key enums and the
callback signature were recovered from the `ghostty-web` bundle that shipped
beside this wasm.

`xterm.mjs` drives `@xterm/headless` and reports the same shapes.

`corpus.mjs` holds two sets. `CORPUS` is state cases: bytes in, then grid text,
cursor, screen, pending-wrap, per-cell attributes and mode flags out. `QUERIES`
is reply cases: bytes in, then whatever the emulator writes back up the pty.

`run.mjs` runs every case on a fresh terminal on both sides and diffs.

## Where the wasm came from

`vendor/ghostty-vt.wasm` and `vendor/trampoline.wasm` are recovered from sip,
which deleted them in commit `ec3b444`:

```
git show ec3b444^:static/ghostty-web/ghostty-vt.wasm > vendor/ghostty-vt.wasm
```

The trampoline is the 185-byte forwarding module the ghostty-web bundle used to
create wasm function-table entries, extracted from that bundle. It is needed
because node cannot synthesise a wasm function without
`--experimental-wasm-type-reflection`, and `ghostty_terminal_set` needs a table
index to deliver pty writes to.

ghostty-vt is not a dependency of this package and must not become one. It is
the oracle for a measurement, and it is vendored only so the measurement can be
re-run without going back through another repository's git history.

## Things the harness deliberately does not claim

Read these before quoting any number out of it.

- **Deferred wrap is normalised, not compared raw.** ghostty keeps the cursor
  on the last column and raises a pending-wrap flag; xterm.js parks the cursor
  one column past the end and carries no flag. Both then wrap the next
  character identically. Comparing the raw columns invents a divergence on
  every line that fills exactly, so `XtermTerm#cursorX` clamps and the pending
  state is compared on its own axis.
- **Cluster composition is not readable.** `ghostty_grid_ref_graphemes` returns
  -3 for combining cells in this build, so the driver reads back only each
  cell's base codepoint. The two cases affected are flagged `harnessLimited`
  and excluded from the divergence count.
- **Five query cases are not scored against ghostty.** ghostty-vt answers OSC
  colour queries and window-size reports through host callbacks the embedder
  registers, not through the pty write callback. This harness wires only
  `WRITE_PTY`, so ghostty's silence on those is the harness's doing.
- **`ghostty_terminal_get(CURSOR_STYLE)` is not usable.** It returns a constant
  regardless of DECSCUSR in this build, so DECSCUSR state is not compared.
- **A case with no `expect` is differential only.** The harness reports that
  the two differ without asserting which is right, because the spec does not
  settle it. Only cases with an `expect` count toward the spec pass/fail
  figures, and those expectations are written from the spec rather than from
  either implementation's output.
