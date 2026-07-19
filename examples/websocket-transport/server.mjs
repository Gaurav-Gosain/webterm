// A real PTY behind a WebSocket, so the transport example has something to
// talk to.
//
// node:  node server.mjs
// then:  open http://localhost:8080
//
// The only non-stdlib piece is the PTY. node has no pty binding in core, so
// this spawns a shell on a pipe instead: enough to prove the transport, not
// enough to run a full-screen TUI. Swap in node-pty for that.

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const SHELL = process.env.SHELL ?? '/bin/sh';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // normalize before join, so a ../ in the request cannot escape ROOT.
  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel);

  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  const stream = createReadStream(file);
  stream.on('error', () => res.writeHead(404).end('not found'));
  stream.on('open', () => {
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    stream.pipe(res);
  });
});

const wss = new WebSocketServer({ server, path: '/pty' });

wss.on('connection', (socket) => {
  const child = spawn(SHELL, ['-i'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  // Server to browser: raw bytes, no framing. webSocketTransport hands whatever
  // arrives straight to the emulator, so the message boundaries are the
  // socket's own and nothing has to be reassembled.
  const forward = (chunk) => {
    if (socket.readyState === socket.OPEN) socket.send(chunk);
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);

  // Browser to server: already chunked to input.chunkBytes, so a large paste
  // arrives as several messages rather than one the socket has to buffer whole.
  socket.on('message', (data) => child.stdin.write(data));

  const stop = () => {
    child.kill();
    if (socket.readyState === socket.OPEN) socket.close();
  };
  socket.on('close', stop);
  child.on('exit', stop);
});

server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}  (shell: ${SHELL})`);
});

// Leave nothing behind on Ctrl+C: every child dies with the server.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const client of wss.clients) client.close();
    server.close(() => process.exit(0));
  });
}
