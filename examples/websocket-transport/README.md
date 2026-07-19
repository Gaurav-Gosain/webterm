# webterm over a WebSocket

Three ways to reach a server, in one file: the shipped transport, the fallback
and reconnect combinators, and a hand-written transport for a protocol with its
own framing.

```sh
npm install
npm run server   # a shell behind ws://localhost:8080/pty
npm run dev      # the page, on vite's port
```

`server.mjs` spawns a shell on a pipe rather than a PTY, because node has no pty
binding in core. That is enough to prove the transport and not enough to run a
full-screen TUI: there is no job control and no window size. Use `node-pty` for
a real one.

The three `term.attach` calls in `src/main.ts` are alternatives, not a sequence.
Each replaces the last, so only the final one is live when the page runs; delete
the two you do not want.

## What the package does and does not do

It consumes and produces raw bytes. It has no opinion about framing, message
types, keepalives or how a resize reaches your PTY, because those are yours.
What it does own is the chunking: `send` never receives more than
`input.chunkBytes` at once, so a large paste cannot arrive as one frame your
server refuses.
