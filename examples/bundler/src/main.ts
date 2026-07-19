// webterm through a bundler, with types.
//
// The package is ESM with subpath exports, so a bundler tree-shakes what you do
// not reach and the optional addons (graphemes, webgl, canvas, image,
// web-links) stay behind dynamic imports that only load when an option asks for
// them. Only @xterm/addon-fit is unconditional.

import { WebTerm } from 'webterm';
import type { ResizeEvent, WebTermOptions } from 'webterm';
import { createWindowChrome } from 'webterm/chrome';

// xterm's own stylesheet is required and is yours to import, since you may
// already have it. The other two belong to this package.
import '@xterm/xterm/css/xterm.css';
import 'webterm/css';
import 'webterm/chrome.css';

const options: WebTermOptions = {
  fontSize: 14,
  theme: 'catppuccin-mocha',

  // Faces are loaded through the FontFace API and awaited before the Terminal
  // is constructed. Relying on a CSS @font-face instead races the measurement:
  // xterm measures the cell box once and caches whatever face is resolved then.
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fonts: [
    { source: 'url(/fonts/JetBrainsMono-Regular.woff2)', weight: '400' },
    { source: 'url(/fonts/JetBrainsMono-Bold.woff2)', weight: '700' },
  ],

  // Grouped options. Every group is optional and every default is the value
  // that is correct rather than the value that is conventional.
  renderer: { prefer: 'auto' },
  clipboard: { copyOnSelect: true },
  graphics: { kitty: { anchor: 'scrollback' } },
  mouse: { suppressContextMenu: true },

  // Two escape hatches, for the things no wrapper anticipates. `xterm` is
  // merged into the xterm options last, so it wins over everything above.
  xterm: { macOptionIsMeta: true },
  onTerminalCreated(terminal) {
    // The raw Terminal, before it is opened. Load a third-party addon here.
    void terminal;
  },
};

const host = document.getElementById('app');
if (!host) throw new Error('no #app element');

// The frame is a slot: it hands back an empty element and the terminal opens
// into it. Drop these two lines and the terminal opens into `host` directly.
const chrome = createWindowChrome({
  title: 'webterm',
  background: 'ocean',
  contentBackground: '#1e1e2e',
  contentPadding: 10,
});
chrome.mount(host);

const term = await new WebTerm(options).open(chrome.content);

// Resize, title, bell and clipboard are events rather than side effects, so
// the page decides what each one means.
term.on('resize', ({ cols, rows, pixel }: ResizeEvent) => {
  console.log(`grid ${cols}x${rows}, ${pixel.width}x${pixel.height} px`);
});
term.on('title', (title) => chrome.setTitle(title));
term.on('clipboard', ({ text, written }) => {
  if (!written) console.warn('the browser refused the clipboard write', text.length);
});

// `on` returns an unsubscribe rather than needing a matching `off`.
const stopWatchingBells = term.on('bell', () => console.log('bell'));
void stopWatchingBells;

term.write('Opened through a bundler.\r\n');
term.focus();

// term.xterm is public on purpose: no wrapper anticipates everything, and
// term.parser, term.registerMarker and third-party addons should not require
// forking the package to reach.
console.log('xterm cols', term.xterm.cols);
