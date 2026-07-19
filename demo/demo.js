// The webterm demo.
//
// Loaded as a classic script after the two standalone bundles, which publish
// the WebTerm and WebTermChrome globals. There is no server behind any of this:
// a small fake shell answers input locally, so what is real here is the
// rendering, the graphics, the widths and the frame.
(function () {
  'use strict';

  const { WebTerm } = window.WebTerm;
  const { createWindowChrome, backgroundNames } = window.WebTermChrome;

  const BACKGROUNDS = backgroundNames;

  const THEME_BACKGROUNDS = {
    'catppuccin-mocha': '#1e1e2e',
    'catppuccin-latte': '#eff1f5',
    'gruvbox-dark': '#282828',
  };

  const $ = (id) => document.getElementById(id);

  // --- A fake shell ---------------------------------------------------------
  //
  // Enough of a line editor to make the terminal feel like a terminal:
  // printable characters, backspace, Ctrl+C and Enter. Everything it knows how
  // to run is in COMMANDS.

  const PROMPT = '\x1b[38;5;114m~\x1b[0m \x1b[38;5;110m❯\x1b[0m ';

  const COMMANDS = {
    help() {
      return [
        'This is a fake shell. It knows:',
        '',
        '  \x1b[1mhelp\x1b[0m       this',
        '  \x1b[1mcolours\x1b[0m    the 16 ANSI colours and a 256-colour ramp',
        '  \x1b[1municode\x1b[0m    grapheme clusters, emoji and CJK, one cell per column',
        '  \x1b[1mblocks\x1b[0m     block glyphs, which tile without seams at lineHeight 1',
        '  \x1b[1mimage\x1b[0m      a kitty graphics placement',
        '  \x1b[1mclear\x1b[0m      clear the screen',
        '',
      ];
    },

    colours() {
      const out = [''];
      let row = '  ';
      for (let i = 0; i < 8; i++) row += `\x1b[4${i}m   \x1b[0m`;
      out.push(row);
      row = '  ';
      for (let i = 0; i < 8; i++) row += `\x1b[10${i}m   \x1b[0m`;
      out.push(row, '');
      row = '  ';
      for (let i = 16; i < 232; i += 6) row += `\x1b[48;5;${i}m  \x1b[0m`;
      out.push(row, '');
      return out;
    },

    unicode() {
      return [
        '',
        '  family        \x1b[1m👨‍👩‍👧‍👦\x1b[0m   one cluster, two cells',
        '  skin tone     \x1b[1m👋🏽\x1b[0m   modifier joins the base',
        '  keycap        \x1b[1m1️⃣\x1b[0m   sequence, not three glyphs',
        '  hangul        \x1b[1m한글\x1b[0m   wide',
        '  CJK           \x1b[1m你好世界\x1b[0m',
        '  combining     \x1b[1méà\x1b[0m   marks do not take a cell',
        '  VS15 / VS16   \x1b[1m✈︎ ✈️\x1b[0m   text and emoji presentation',
        '',
      ];
    },

    blocks() {
      const out = [''];
      for (let i = 0; i < 3; i++) out.push('  ' + '█'.repeat(28));
      out.push('  ' + '▀'.repeat(28));
      out.push('  ' + '▄'.repeat(28));
      out.push('  ' + '─'.repeat(28));
      out.push('  ' + '│ '.repeat(14));
      out.push('');
      return out;
    },

    image() {
      placeImage(framed);
      return ['', '  placed above the grid, anchored to this row', ''];
    },
  };

  // The terminal answers some sequences on the data channel: a kitty transmit
  // is acknowledged with `ESC _ Gi=2;OK ESC \`, and a device query with a CSI
  // reply. A real shell hands those to the program that asked for them. This
  // one has nothing to hand them to, so it has to recognise the framing and
  // drop the whole sequence; dropping only the bytes below 0x20 leaves the
  // printable body to be echoed at the prompt.
  //
  // ECMA-48 framing, in the 7-bit forms a terminal actually sends:
  //
  //   CSI      ESC [ , parameters and intermediates 0x20-0x3f, final 0x40-0x7e
  //   strings  ESC P (DCS), ESC X (SOS), ESC ] (OSC), ESC ^ (PM), ESC _ (APC),
  //            each running to ST, which is the two characters ESC \. OSC also
  //            ends at BEL, by the convention every terminal follows.
  //   other    ESC, optional intermediates 0x20-0x2f, one final 0x30-0x7e
  //
  // The state is a field rather than a local because a reply can arrive split
  // across two data events, and half a sequence must not fall out as text.
  const STRING_OPENERS = 'P]X^_';

  class EscapeFilter {
    constructor() {
      this.state = 'ground';
      this.bel = false;
    }

    /** Yield the characters that survive: everything outside a sequence. */
    *feed(data) {
      for (const ch of data) {
        switch (this.state) {
          case 'ground':
            if (ch === '\x1b') this.state = 'escape';
            else yield ch;
            break;

          case 'escape':
            if (ch === '[') {
              this.state = 'csi';
            } else if (STRING_OPENERS.includes(ch)) {
              this.state = 'string';
              this.bel = ch === ']';
            } else if (ch === '\x1b') {
              // A second ESC restarts the sequence rather than ending one.
            } else if (ch >= ' ' && ch <= '/') {
              this.state = 'intermediate';
            } else {
              // The final byte. A lone Escape keystroke lands here too and
              // eats the next character, which is the same ambiguity a real
              // terminal parser lives with.
              this.state = 'ground';
            }
            break;

          case 'intermediate':
            if (!(ch >= ' ' && ch <= '/')) this.state = 'ground';
            break;

          case 'csi':
            if (ch >= '@' && ch <= '~') this.state = 'ground';
            break;

          case 'string':
            // ST is two characters, so an ESC only arms the terminator: any
            // other character after it is still part of the string.
            if (ch === '\x1b') this.state = 'stringEscape';
            else if (this.bel && ch === '\x07') this.state = 'ground';
            break;

          case 'stringEscape':
            this.state = ch === '\\' ? 'ground' : 'string';
            break;
        }
      }
    }
  }

  class FakeShell {
    constructor(term, banner) {
      this.term = term;
      this.line = '';
      this.banner = banner;
      this.escapes = new EscapeFilter();
      term.on('data', (bytes) => this.onInput(new TextDecoder().decode(bytes)));
    }

    start() {
      for (const line of this.banner) this.term.write(line + '\r\n');
      this.prompt();
    }

    prompt() {
      this.line = '';
      this.term.write('\r\n' + PROMPT);
    }

    onInput(data) {
      for (const ch of this.escapes.feed(data)) {
        if (ch === '\r') {
          this.term.write('\r\n');
          this.run(this.line.trim());
          continue;
        }
        if (ch === '\x7f') {
          // Backspace has to erase the cell, not just move over it.
          if (this.line.length === 0) continue;
          this.line = this.line.slice(0, -1);
          this.term.write('\b \b');
          continue;
        }
        if (ch === '\x03') {
          this.term.write('^C');
          this.prompt();
          continue;
        }
        // Escape sequences are already gone by here. What is left below 0x20
        // is a bare control this shell has no meaning for, dropped rather
        // than printed.
        if (ch < ' ') continue;
        this.line += ch;
        this.term.write(ch);
      }
    }

    run(command) {
      if (command === '') return this.prompt();
      if (command === 'clear') {
        this.term.write('\x1b[2J\x1b[H');
        this.line = '';
        this.term.write(PROMPT);
        return;
      }
      const fn = COMMANDS[command];
      if (!fn) {
        this.term.write(`\x1b[38;5;210m${command}: not found\x1b[0m\r\n`);
        this.term.write('type \x1b[1mhelp\x1b[0m\r\n');
        return this.prompt();
      }
      for (const line of fn()) this.term.write(line + '\r\n');
      this.prompt();
    }
  }

  // --- Kitty graphics -------------------------------------------------------

  let nextImageId = 1;
  let lastPlacement = null;

  /** A base64 RGBA gradient tile, `size` square. */
  function gradientTile(size, hue) {
    const bytes = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const t = x / size;
        const u = y / size;
        bytes[i] = Math.round(120 + 135 * t * Math.cos(hue));
        bytes[i + 1] = Math.round(120 + 135 * u * Math.sin(hue));
        bytes[i + 2] = Math.round(200 - 120 * t * u);
        bytes[i + 3] = 255;
      }
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function apc(control, payload) {
    return `\x1b_G${control}${payload ? ';' + payload : ''}\x1b\\`;
  }

  /** Transmit a tile and place it at the cursor. */
  function placeImage(term, columns) {
    const id = nextImageId++;
    const size = 64;
    const payload = gradientTile(size, id * 0.9);
    const extra = columns ? `,c=${columns}` : '';
    term.write(apc(`a=t,f=32,i=${id},s=${size},v=${size},t=d`, payload));
    term.write(apc(`a=p,i=${id},p=${id}${extra}`));
    lastPlacement = id;
    return id;
  }

  // --- The framed terminal --------------------------------------------------

  const chromeOptions = () => {
    const themeName = $('theme').value;
    const shadow = $('shadow').value;
    return {
      title: 'webterm: zsh',
      appearance: $('appearance').value,
      background: $('background').value,
      shadow: shadow === 'false' ? false : shadow,
      titleBar: $('titlebar').checked,
      contentBackground: THEME_BACKGROUNDS[themeName],
      contentPadding: 10,
      tabs: $('tabs').checked
        ? {
            items: [
              { id: 'shell', title: 'zsh' },
              { id: 'logs', title: 'logs' },
              { id: 'build', title: 'build' },
            ],
            activeId: 'shell',
            interactive: true,
          }
        : undefined,
    };
  };

  // The background select is filled before the first chromeOptions() call, not
  // in bindControls() below: chromeOptions() reads its value, and an empty
  // select reads as an empty string, so the frame would render without its
  // stated default until the first change event.
  function fillBackgrounds() {
    const select = $('background');
    for (const name of BACKGROUNDS) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      if (name === 'aurora') option.selected = true;
      select.append(option);
    }
  }

  fillBackgrounds();

  const chrome = createWindowChrome(chromeOptions());
  chrome.mount($('framed'));

  const framed = new WebTerm({
    fontSize: 14,
    theme: $('theme').value,
    // The frame supplies the surrounding colour, so the terminal only has to
    // agree with it. contentBackground above is the other half of that.
    graphics: { kitty: { anchor: 'scrollback' } },
    clipboard: { copyOnSelect: true },
  });

  // --- The bare terminal ----------------------------------------------------

  const bare = new WebTerm({
    fontSize: 13,
    theme: 'gruvbox-dark',
    graphics: { kitty: false },
    scrollback: 500,
  });

  // --- Wiring ---------------------------------------------------------------

  function bindControls() {
    // update() rebuilds the frame without touching the slot's children, so the
    // open terminal survives every one of these.
    const rebuild = () => chrome.update(chromeOptions());
    for (const id of ['background', 'appearance', 'shadow', 'tabs', 'titlebar']) {
      $(id).addEventListener('change', rebuild);
    }

    $('theme').addEventListener('change', () => {
      framed.setTheme($('theme').value);
      rebuild();
    });

    chrome.on('tabchange', (id, tab) => chrome.setTitle(`webterm: ${tab.title}`));

    $('gfx-place').addEventListener('click', () => {
      framed.write('\r\n');
      placeImage(framed);
      framed.write('\r\n\r\n');
      framed.focus();
    });

    $('gfx-many').addEventListener('click', () => {
      framed.write('\r\n');
      for (let i = 0; i < 4; i++) {
        placeImage(framed, 6);
        framed.write('  ');
      }
      framed.write('\r\n\r\n');
      framed.focus();
    });

    $('gfx-move').addEventListener('click', () => {
      if (lastPlacement === null) return;
      // Re-placing the same image and placement id moves the canvas rather
      // than stacking a second one on top of it.
      framed.write(apc(`a=p,i=${lastPlacement},p=${lastPlacement},X=40,Y=10`));
      framed.focus();
    });

    $('gfx-clear').addEventListener('click', () => {
      framed.write(apc('a=d,d=A'));
      lastPlacement = null;
      framed.focus();
    });

    $('gfx-probe').addEventListener('click', () => {
      // The reply leaves through the data event, the same route a keystroke
      // takes, which is what makes a client believe graphics are supported.
      const seen = [];
      const off = framed.on('data', (bytes) => seen.push(new TextDecoder().decode(bytes)));
      framed.write(apc('a=q,f=24,s=1,v=1,i=99', 'MTIz'));
      setTimeout(() => {
        off();
        const answer = seen.join('') || '(nothing)';
        framed.write(`\r\n  probe answered: ${JSON.stringify(answer)}\r\n`);
        shell.prompt();
      }, 120);
    });

    $('bare-unicode').addEventListener('click', () => {
      for (const line of COMMANDS.unicode()) bare.write(line + '\r\n');
    });
    $('bare-colours').addEventListener('click', () => {
      for (const line of COMMANDS.colours()) bare.write(line + '\r\n');
    });
    $('bare-clear').addEventListener('click', () => bare.write('\x1b[2J\x1b[H'));
  }

  let shell;

  (async () => {
    bindControls();

    await framed.open(chrome.content);
    shell = new FakeShell(framed, [
      '\x1b[38;5;110mwebterm\x1b[0m demo, a fake shell, no server behind it',
      'type \x1b[1mhelp\x1b[0m for what it knows',
    ]);
    shell.start();
    framed.focus();

    await bare.open($('bare'));
    bare.write('  the same package, no chrome and no graphics\r\n');
    for (const line of COMMANDS.blocks()) bare.write(line + '\r\n');

    // Handles for poking at it from the console.
    window.demo = { framed, bare, chrome, shell };
  })().catch((error) => {
    document.body.prepend(
      Object.assign(document.createElement('pre'), {
        textContent:
          `the demo failed to start: ${error}\n\n` +
          'dist/ is build output. Run `npm install && npm run build` first.',
        style: 'margin:24px;color:#c0392b;white-space:pre-wrap',
      }),
    );
  });
})();
