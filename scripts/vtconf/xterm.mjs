// A headless driver for xterm.js, shaped to report the same state as the
// ghostty driver so the two can be diffed cell for cell.
//
// @xterm/headless is pinned to the same version as the @xterm/xterm this
// package vendors, so what is measured here is what webterm actually ships.

import pkg from '@xterm/headless';

const { Terminal } = pkg;

export class XtermTerm {
  /**
   * `layer` is the webterm module under test, or null to measure bare xterm.js.
   *
   * Passing it makes the driver report what the package ships rather than what
   * its dependency ships: the same `windowOptions` webterm opens and the same
   * report handlers it registers. It is passed in rather than imported here
   * because it is TypeScript source, which only runs under the loader in
   * test/register-ts.mjs; see the README.
   */
  constructor(cols, rows, { scrollback = 1000, unicode = true, layer = null } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.responses = [];
    this.term = new Terminal({
      cols,
      rows,
      scrollback,
      allowProposedApi: true,
      ...(layer ? { windowOptions: { ...layer.GEOMETRY_WINDOW_OPTIONS } } : {}),
    });
    if (layer) {
      layer.installTerminalReports(this.term, {
        respond: (data) => this.responses.push(data),
      });
    }
    // Everything the emulator would send back up the pty.
    this.term.onData((d) => this.responses.push(d));
    this.term.onBinary((d) => this.responses.push(d));
    this._unicode = unicode;
  }

  /**
   * Install the grapheme addon. Kept separate from the constructor because it
   * is an async import and because a run may want to measure without it.
   */
  async initUnicode() {
    if (!this._unicode) return;
    const { UnicodeGraphemesAddon } = await import('@xterm/addon-unicode-graphemes');
    this.term.loadAddon(new UnicodeGraphemesAddon());
    this.term.unicode.activeVersion = '15-graphemes';
  }

  /** Feed bytes. Resolves once xterm has finished parsing them. */
  write(input) {
    const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
    return new Promise((resolve) => this.term.write(bytes, resolve));
  }

  /**
   * Cursor column, normalised to ghostty's representation.
   *
   * The two emulators encode a deferred wrap differently and this is a
   * representation difference, not a conformance one. ghostty keeps the
   * cursor on the last column and raises a pending-wrap flag; xterm.js parks
   * cursorX one past the last column and carries no flag. Both then wrap the
   * next printable character identically. Comparing the raw numbers would
   * manufacture a divergence on every case that fills a line exactly, so the
   * out-of-range column is clamped here and the pending state is compared
   * separately through `pendingWrap`.
   */
  get cursorX() {
    return Math.min(this.term.buffer.active.cursorX, this.cols - 1);
  }

  /** True when xterm is parked past the last column, i.e. a wrap is pending. */
  get pendingWrap() {
    return this.term.buffer.active.cursorX >= this.cols;
  }

  /** Cursor row relative to the top of the visible screen, as ghostty reports it. */
  get cursorY() {
    return this.term.buffer.active.cursorY;
  }

  get activeScreen() {
    return this.term.buffer.active.type === 'alternate' ? 1 : 0;
  }

  get modes() {
    return this.term.modes;
  }

  get title() {
    return this._title ?? '';
  }

  /** The visible screen as row strings, trailing blanks trimmed. */
  gridText() {
    const b = this.term.buffer.active;
    const out = [];
    for (let y = 0; y < this.rows; y++) {
      const line = b.getLine(b.baseY + y);
      out.push(line ? line.translateToString(false).replace(/\s+$/, '') : '');
    }
    return out;
  }

  /** One row, in the same cell shape the ghostty driver returns. */
  readRow(y, { withStyle = false } = {}) {
    const b = this.term.buffer.active;
    const line = b.getLine(b.baseY + y);
    if (!line) return null;
    const cells = [];
    for (let x = 0; x < this.cols; x++) {
      const c = line.getCell(x);
      if (!c) {
        cells.push({ cp: 0, width: 1 });
        continue;
      }
      const chars = c.getChars();
      const out = {
        cp: chars.length ? chars.codePointAt(0) : 0,
        width: c.getWidth(),
      };
      if (withStyle) {
        out.bold = !!c.isBold();
        out.italic = !!c.isItalic();
        out.faint = !!c.isDim();
        out.blink = !!c.isBlink();
        out.inverse = !!c.isInverse();
        out.invisible = !!c.isInvisible();
        out.strikethrough = !!c.isStrikethrough();
        out.overline = !!c.isOverline();
        out.underline = c.isUnderline() ? c.getUnderlineStyle() : 0;
        out.fg = xtermColor(c, 'fg');
        out.bg = xtermColor(c, 'bg');
      }
      cells.push(out);
    }
    return cells;
  }

  dispose() {
    this.term.dispose();
  }
}

/** Normalise an xterm cell colour into the ghostty driver's shape. */
function xtermColor(cell, which) {
  const isFg = which === 'fg';
  if (isFg ? cell.isFgDefault() : cell.isBgDefault()) return null;
  if (isFg ? cell.isFgPalette() : cell.isBgPalette()) {
    return { kind: 'palette', index: isFg ? cell.getFgColor() : cell.getBgColor() };
  }
  if (isFg ? cell.isFgRGB() : cell.isBgRGB()) {
    const v = isFg ? cell.getFgColor() : cell.getBgColor();
    return { kind: 'rgb', r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
  }
  return null;
}
