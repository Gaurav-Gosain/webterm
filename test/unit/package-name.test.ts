/**
 * The examples and the docs name the package by its scoped name.
 *
 * `webterm` on npm is an unrelated package. An example that depends on
 * `"webterm": "file:../.."` and imports from `'webterm'` works inside this
 * repository, and a user who copies it and swaps in a version range installs
 * someone else's code.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Files a user copies from: examples, the README and the docs. */
function sources(): string[] {
  const out: string[] = [join(ROOT, 'README.md')];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|mjs|js|json|md|html)$/.test(name)) out.push(path);
    }
  };
  walk(join(ROOT, 'examples'));
  walk(join(ROOT, 'docs'));
  return out;
}

// An import or a dependency on the bare name or one of its subpaths.
const UNSCOPED = [
  /\bfrom\s+['"]webterm(\/[^'"]*)?['"]/,
  /\bimport\s+['"]webterm(\/[^'"]*)?['"]/,
  /\bimport\(\s*['"]webterm(\/[^'"]*)?['"]\s*\)/,
  /"webterm"\s*:/,
];

test('no example or doc refers to the package by the unscoped name', () => {
  const hits: string[] = [];
  for (const file of sources()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (UNSCOPED.some((pattern) => pattern.test(line))) {
        hits.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(hits, [], `use @gaurav-gosain/webterm:\n${hits.join('\n')}`);
});
