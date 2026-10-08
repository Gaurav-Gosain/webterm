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
      'chrome/index': 'src/chrome/index.ts',
      // The vtgl renderer. Its own entry, so a consumer who never asks for it
      // never bundles it; vtgl itself stays an external, optional peer.
      'vtgl/index': 'src/vtgl/index.ts',
      // The colour scheme corpus is its own entry point because it is two
      // orders of magnitude larger than the code that uses it. A consumer who
      // never imports it never downloads it, and the main entry's size is
      // unchanged by its presence.
      'themes/index': 'src/themes/index.ts',
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
      copyFileSync('src/chrome/css/chrome.css', 'dist/chrome.css');
    },
  },
  {
    // The standalone build for script-tag users: xterm, every addon the
    // default path can reach and the transports are inlined, so a plain HTML
    // page needs one file. vtgl is not reachable from this entry, so it is not
    // inlined; see the vtgl standalone below.
    entry: { 'webterm.standalone': 'src/standalone.ts' },
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
  {
    // The vtgl renderer for script-tag users, loaded after the core standalone
    // by a page that wants it. It publishes `WebTermVtgl`, and the page passes
    // `WebTermVtgl.vtgl()` as `renderer.vtgl`. The adapter imports only xterm's
    // types, so no second xterm is inlined here.
    entry: { 'webterm-vtgl.standalone': 'src/vtgl/index.ts' },
    format: ['iife'],
    globalName: 'WebTermVtgl',
    target: 'es2022',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    minify: true,
    noExternal: [/^@gaurav-gosain\/vtgl/],
  },
  {
    // The chrome standalone, separate from the terminal's so a script-tag user
    // who only wants the frame does not download xterm to get it.
    entry: { 'webterm-chrome.standalone': 'src/chrome/index.ts' },
    format: ['iife'],
    globalName: 'WebTermChrome',
    target: 'es2022',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    minify: true,
  },
]);
