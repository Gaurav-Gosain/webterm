// A vtgl VtSource backed by xterm's public buffer API.
//
// This half is ordinary code against a supported surface:
// `terminal.buffer.active.getLine(y)`, `line.getCell(x, reusableCell)` and the
// IBufferCell accessors. Nothing here reaches into xterm's internals except the
// ANSI palette, which xterm does not expose publicly and which the caller
// supplies (see adapter.ts for where it comes from).
//
// Coordinates line up without translation, which is the one piece of luck
// here. vtgl addresses rows absolutely across scrollback plus screen, and
// so does xterm's `buffer.active`: index 0 is the oldest scrollback row and
// `baseY` is the first row of the active screen. So vtgl's `scrollbackRows` is
// xterm's `baseY`, and vtgl's `viewportY` is xterm's `viewportY`.

import type { IBufferCell, IBufferLine, Terminal } from '@xterm/xterm';
import { CellFlags, type Cell, type CursorState, type LineView, type VtSource } from 'vtgl';

/** 0xRRGGBB for each of the 256 ANSI slots, plus the two defaults. */
export interface Palette {
  ansi: readonly number[];
  foreground: number;
  background: number;
}

/**
 * A LineView over one xterm buffer line.
 *
 * vtgl's inner loop reads columns through numeric accessors specifically to
 * avoid allocating per cell, so this holds one IBufferCell and refills it. That
 * makes the accessors order-dependent in a way the interface does not advertise:
 * reading fg then bg for the same column costs two `getCell` fills. It is still
 * far cheaper than materialising a Cell per column, and it is what xterm's own
 * renderers do with the same API.
 */
class XtermLineView implements LineView {
  private line: IBufferLine | undefined;
  private readonly cell: IBufferCell;
  private readonly palette: Palette;
  /** The column currently loaded into `cell`, or -1. */
  private loaded = -1;

  constructor(cell: IBufferCell, palette: Palette) {
    this.cell = cell;
    this.palette = palette;
  }

  bind(line: IBufferLine | undefined): this {
    this.line = line;
    this.loaded = -1;
    return this;
  }

  get length(): number {
    return this.line?.length ?? 0;
  }

  private load(col: number): IBufferCell | undefined {
    if (!this.line) return undefined;
    if (this.loaded !== col) {
      this.line.getCell(col, this.cell);
      this.loaded = col;
    }
    return this.cell;
  }

  codepoint(col: number): number {
    return this.load(col)?.getCode() ?? 0;
  }

  grapheme(col: number): string {
    return this.load(col)?.getChars() ?? '';
  }

  width(col: number): number {
    return this.load(col)?.getWidth() ?? 1;
  }

  fg(col: number): number {
    const cell = this.load(col);
    if (!cell) return this.palette.foreground;
    return resolveFg(cell, this.palette);
  }

  bg(col: number): number {
    const cell = this.load(col);
    if (!cell) return this.palette.background;
    return resolveBg(cell, this.palette);
  }

  flags(col: number): number {
    const cell = this.load(col);
    if (!cell) return CellFlags.NONE;
    return resolveFlags(cell);
  }
}

/**
 * Resolve a cell's foreground to a packed 0xRRGGBB.
 *
 * vtgl takes colours already resolved: it does no palette lookup of its own,
 * and the three modes xterm reports map straight onto that.
 *
 * Two things xterm's own renderers do at draw time are NOT done here, and both
 * are visible differences rather than theoretical ones. `drawBoldTextInBright
 * Colors` promotes a bold cell's palette index into the bright half, so bold
 * ANSI text comes out a shade darker through this path than through any
 * renderer xterm ships. `minimumContrastRatio` lightens or darkens a
 * foreground that is too close to its background, and xterm keeps a contrast
 * cache for it that is not reachable from the public API at all. Both are
 * recorded as gaps rather than guessed at.
 */
export function resolveFg(cell: IBufferCell, palette: Palette): number {
  if (cell.isFgRGB()) return cell.getFgColor() & 0xffffff;
  if (cell.isFgPalette()) {
    const index = cell.getFgColor();
    return palette.ansi[index] ?? palette.foreground;
  }
  return palette.foreground;
}

/** Resolve a cell's background to a packed 0xRRGGBB. */
export function resolveBg(cell: IBufferCell, palette: Palette): number {
  if (cell.isBgRGB()) return cell.getBgColor() & 0xffffff;
  if (cell.isBgPalette()) {
    const index = cell.getBgColor();
    return palette.ansi[index] ?? palette.background;
  }
  return palette.background;
}

/**
 * Map xterm's per-cell attributes onto vtgl's CellFlags bitfield.
 *
 * The two sets are close but not equal. xterm carries overline and a dim bit
 * that vtgl does not name; dim maps onto FAINT, and overline is dropped, which
 * is the first of several small losses this adapter records rather than hides.
 * Underline style (curly, dotted, dashed, double) is likewise flattened to a
 * single UNDERLINE bit because that is all vtgl has.
 */
export function resolveFlags(cell: IBufferCell): number {
  let flags = CellFlags.NONE;
  if (cell.isBold()) flags |= CellFlags.BOLD;
  if (cell.isItalic()) flags |= CellFlags.ITALIC;
  if (cell.isUnderline()) flags |= CellFlags.UNDERLINE;
  if (cell.isStrikethrough()) flags |= CellFlags.STRIKETHROUGH;
  if (cell.isInverse()) flags |= CellFlags.INVERSE;
  if (cell.isInvisible()) flags |= CellFlags.INVISIBLE;
  if (cell.isBlink()) flags |= CellFlags.BLINK;
  if (cell.isDim()) flags |= CellFlags.FAINT;
  return flags;
}

export interface SourceOptions {
  /** Whether the terminal currently has focus, for cursor visibility. */
  isFocused(): boolean;
  /** Whether the VT has hidden the cursor (DECTCEM). */
  isCursorHidden(): boolean;
  /** Cursor blink phase, owned by the host: vtgl runs no clock. */
  isCursorBlinkOn(): boolean;
}

/**
 * The adapter proper.
 *
 * Damage tracking is driven from outside: xterm's RenderService already knows
 * which viewport rows changed and passes the range to `renderRows`, so the
 * renderer shim calls `markDirty` with it and clears after the frame. Returning
 * true from `isRowDirty` unconditionally would be correct and would throw away
 * the thing vtgl is fast at.
 */
export class XtermVtSource implements VtSource {
  private readonly term: Terminal;
  private readonly view: XtermLineView;
  private readonly scratch: IBufferCell;
  private readonly options: SourceOptions;
  private palette: Palette;
  /** Absolute rows changed since the last frame. */
  private readonly dirty = new Set<number>();
  private allDirty = false;

  constructor(term: Terminal, palette: Palette, options: SourceOptions) {
    this.term = term;
    this.palette = palette;
    this.options = options;
    this.scratch = term.buffer.active.getNullCell();
    this.view = new XtermLineView(term.buffer.active.getNullCell(), palette);
  }

  setPalette(palette: Palette): void {
    this.palette = palette;
    // The view captured the old object; rebuilding is cheaper than threading a
    // setter through, and a palette change forces a full redraw anyway.
    (this.view as unknown as { palette: Palette }).palette = palette;
    this.allDirty = true;
  }

  get rows(): number {
    return this.term.rows;
  }

  get cols(): number {
    return this.term.cols;
  }

  get scrollbackRows(): number {
    return this.term.buffer.active.baseY;
  }

  /** The absolute row drawn at the top of the viewport. */
  get viewportY(): number {
    return this.term.buffer.active.viewportY;
  }

  getLine(row: number): LineView {
    return this.view.bind(this.term.buffer.active.getLine(row));
  }

  getCell(row: number, col: number): Cell {
    const line = this.term.buffer.active.getLine(row);
    const cell = line?.getCell(col, this.scratch);
    if (!cell) {
      return {
        codepoint: 0,
        grapheme: '',
        width: 1,
        fg: this.palette.foreground,
        bg: this.palette.background,
        flags: CellFlags.NONE,
      };
    }
    return {
      codepoint: cell.getCode(),
      grapheme: cell.getChars(),
      width: cell.getWidth(),
      fg: resolveFg(cell, this.palette),
      bg: resolveBg(cell, this.palette),
      flags: resolveFlags(cell),
    };
  }

  getGraphemeString(row: number, col: number): string {
    const line = this.term.buffer.active.getLine(row);
    return line?.getCell(col, this.scratch)?.getChars() ?? '';
  }

  getCursor(): CursorState {
    const buffer = this.term.buffer.active;
    const style = this.term.options.cursorStyle ?? 'block';
    return {
      x: buffer.cursorX,
      // cursorY is relative to the active screen; vtgl wants absolute.
      y: buffer.baseY + buffer.cursorY,
      visible:
        !this.options.isCursorHidden() && this.options.isFocused() && this.options.isCursorBlinkOn(),
      shape: style === 'bar' ? 'bar' : style === 'underline' ? 'underline' : 'block',
    };
  }

  isRowDirty(row: number): boolean {
    return this.allDirty || this.dirty.has(row);
  }

  /** Mark an inclusive range of absolute rows changed. */
  markDirty(startAbsolute: number, endAbsolute: number): void {
    for (let row = startAbsolute; row <= endAbsolute; row++) this.dirty.add(row);
  }

  markAllDirty(): void {
    this.allDirty = true;
  }

  clearDirty(): void {
    this.dirty.clear();
    this.allDirty = false;
  }
}
