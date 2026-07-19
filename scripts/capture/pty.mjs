// A real PTY, bridged to a terminal in the browser.
//
// node has no pty binding in core and this package has no native dependency, so
// the pty comes from util-linux `script`, which allocates one, runs the command
// on it and forwards its own stdin into it. That last part is what matters
// here: it makes the bridge bidirectional, so a program that queries the
// terminal gets webterm's real answer back rather than a timeout. `kitten icat`
// only sends an image in stream mode because the reply to its `a=q` probe
// arrives this way.
import { spawn } from 'node:child_process';

const DEBUG = process.env.WEBTERM_CAPTURE_DEBUG === '1';

/**
 * Start `command` on a pty of `cols` by `rows` and bridge it to the page.
 *
 * `page` is a Playwright page with the capture fixture loaded, `index` the
 * terminal to bridge. Returns `{ done, stop }`: `done` resolves with the exit
 * code, `stop` signals the command. A full-screen program has to be captured
 * while it is still running, because quitting restores the primary screen and
 * takes the frame with it, so those shots hold the handle rather than await it.
 */
export function startOnPty(page, index, command, { cols, rows, env = {}, timeout = 30_000 } = {}) {
  // stty inside the pty rather than -w/--columns, which util-linux only grew
  // recently and silently ignores when the build is older.
  const script = `stty rows ${rows} cols ${cols} 2>/dev/null; ${command}`;

  const child = spawn('script', ['-qfec', script, '/dev/null'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, TERM: 'xterm-kitty', COLUMNS: String(cols), LINES: String(rows), ...env },
  });

  let settled = false;
  let pump;

  const finish = (fn) => (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearInterval(pump);
    if (child.exitCode === null) child.kill('SIGKILL');
    fn(value);
  };

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, timeout);

  const done = new Promise((resolve, reject) => {
    const settle_ = finish(resolve);
    const fail = finish(reject);

    child.stdout.on('data', (chunk) => {
      if (DEBUG) console.error('pty ->', chunk.length, JSON.stringify(chunk.toString('latin1').slice(0, 220)));
      page
        .evaluate(([i, b64]) => window.feed(i, b64), [index, chunk.toString('base64')])
        .catch(fail);
    });

    // Drain whatever the terminal replies with back into the pty. Polling is
    // enough: the replies here are capability probes and cursor reports, not a
    // stream, and a poll keeps the bridge to one mechanism in both directions.
    pump = setInterval(async () => {
      try {
        const b64 = await page.evaluate((i) => window.drain(i), index);
        if (b64 && child.stdin.writable) {
          if (DEBUG) console.error('pty <-', JSON.stringify(Buffer.from(b64, 'base64').toString('latin1')));
          child.stdin.write(Buffer.from(b64, 'base64'));
        }
      } catch {
        // The page went away; the exit handler cleans up.
      }
    }, 40);

    child.on('error', fail);
    child.on('exit', async (code) => {
      // One last drain and a beat for the final chunk to reach the terminal.
      try {
        const b64 = await page.evaluate((i) => window.drain(i), index);
        void b64;
      } catch {
        /* ignore */
      }
      settle_(code ?? 0);
    });
  });

  return { done, stop: (signal = 'SIGTERM') => child.kill(signal) };
}

/** Start a command and wait for it to exit. For anything that finishes on its own. */
export function runOnPty(page, index, command, options) {
  return startOnPty(page, index, command, options).done;
}
