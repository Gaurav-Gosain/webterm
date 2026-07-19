import { copyFileSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'tsup';

const XTERM_EXTERNAL = [/^@xterm\//];

export default defineConfig([
  {
    // The library build. xterm and its addons stay external, so a consumer who
    // already depends on xterm does not get a second copy of it.
    entry: {
      index: 'src/index.ts',
      'transport/index': 'src/transport/index.ts',
    },
    format: ['esm'],
    target: 'es2022',
    platform: 'browser',
    dts: true,
    sourcemap: true,
    // The output directory is emptied by the prebuild script, so neither config
    // cleans: the two builds run concurrently and a clean here would race the
    // other build's output.
    clean: false,
    treeshake: true,
    splitting: true,
    external: XTERM_EXTERNAL,
    onSuccess: async () => {
      mkdirSync('dist', { recursive: true });
      copyFileSync('src/css/webterm.css', 'dist/webterm.css');
    },
  },
  {
    // The standalone build for script-tag users: xterm and every addon the
    // default path can reach are inlined, so a plain HTML page needs one file.
    entry: { 'webterm.standalone': 'src/index.ts' },
    format: ['iife'],
    globalName: 'WebTerm',
    target: 'es2022',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    minify: true,
    noExternal: [/^@xterm\//],
  },
]);
