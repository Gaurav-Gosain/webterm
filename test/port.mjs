// The port the fixture server listens on, derived from this checkout's path.
//
// A fixed default is a trap once more than one checkout of this package exists,
// which is the normal state of affairs during review: several worktrees, each
// with its own dist/, all defaulting to the same port. The first one to start a
// server wins it, and every later run silently loads that checkout's build
// instead of its own. The symptom is a suite that fails on code the tree does
// not contain, which is unfalsifiable from inside the run.
//
// Deriving the default from the package directory gives each checkout a port of
// its own, so concurrent runs do not see each other at all. WEBTERM_TEST_PORT
// still overrides it.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

/** The package directory, the root the fixture server serves. */
export const ROOT = resolve(import.meta.dirname, '..');

/** 7800-8299, stable for a given checkout and unlikely to collide with one. */
function derivePort(root) {
  const digest = createHash('sha256').update(root).digest();
  return 7800 + (digest.readUInt16BE(0) % 500);
}

export const PORT = Number(process.env.WEBTERM_TEST_PORT ?? derivePort(ROOT));
export const BASE_URL = `http://127.0.0.1:${PORT}`;
