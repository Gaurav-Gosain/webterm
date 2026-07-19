/**
 * Resolve the package's own `.js` import specifiers to the `.ts` files they
 * refer to, so node's type stripping can run the sources directly.
 *
 * TypeScript requires a relative import to name the extension the file will
 * have once compiled, so `./keys.ts` is written `./keys.js` throughout src.
 * Node resolves that specifier literally and finds nothing, which meant a unit
 * test could only ever cover a module with no runtime imports of its own.
 *
 * The rewrite is deliberately narrow: relative specifiers only, and only when
 * the `.ts` file is actually there. Anything else, including every node_modules
 * package, falls through to the default resolver untouched.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
    const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(candidate))) {
      return { url: pathToFileURL(fileURLToPath(candidate)).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
