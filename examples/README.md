# Examples

Three ways to consume the package, smallest first.

| Directory | What it shows |
| --- | --- |
| [`script-tag/`](script-tag) | A plain HTML page, no build step, no bundler, no npm at runtime |
| [`bundler/`](bundler) | ESM with subpath imports and types, the normal path for an app |
| [`websocket-transport/`](websocket-transport) | Wiring a real server, both with the shipped transport and with a hand-written one |

The first two open a terminal that is not connected to anything, because a
terminal and a PTY are separate problems. `websocket-transport/` is the one with
a server behind it, and it is the only one that needs a process running.

For a page that exercises everything at once, including kitty graphics and the
window chrome, see [`../demo/`](../demo).
