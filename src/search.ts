import type { IBuffer, IBufferLine, Terminal } from '@xterm/xterm';

// Buffer search: find text the program printed, on the screen or in the
// scrollback, select it and scroll to it.
//
// It searches the buffer and not the renderer, so it works the same under every
// renderer, and it searches logical lines: a terminal wraps constantly, and a
// search that stops at the row boundary misses most of what is on the screen.
// Rows are joined back into the logical line they came from, the match is found
// there, and the column is measured back out of the row it started in. A wide
// character is one character in two columns, which is why that last step is a
// measurement and not an index.
//
// This came from sip's client, where it backed the page API's search. It is
// plain text only, never a pattern: a regular expression from a page script is
// a way to hang the page's own runtime.

/** The longest query accepted. A longer one finds nothing. */
export const MAX_SEARCH_QUERY = 256;

export interface SearchOptions {
  /** Match case exactly. Default false. */
  caseSensitive?: boolean;
  /** Walk towards the top of the buffer. Default false. */
  backwards?: boolean;
}

/** Where a match is: its buffer row, its column in that row, and the query length in characters. */
export interface SearchMatch {
  row: number;
  col: number;
  length: number;
}

interface LogicalLine {
  /** The buffer row the line starts on. */
  row: number;
  text: string;
  segments: { row: number; length: number }[];
}

/** The buffer rows, joined into the logical lines they wrapped from. */
function logicalLines(buf: IBuffer): LogicalLine[] {
  const lines: LogicalLine[] = [];
  for (let i = 0; i < buf.length; i++) {
    const row = buf.getLine(i);
    if (!row) continue;
    const text = row.translateToString(false);
    const last = lines[lines.length - 1];
    if (row.isWrapped && last) {
      last.text += text;
      last.segments.push({ row: i, length: text.length });
      continue;
    }
    lines.push({ row: i, text, segments: [{ row: i, length: text.length }] });
  }
  return lines;
}

/**
 * The column the character at `charIndex` starts in, measured through the
 * row's cells: the first cell count whose text holds more than `charIndex`
 * characters, less the one cell that took it past. A wide character is one
 * character over two cells, and its second cell adds no text.
 */
function columnAt(row: IBufferLine | undefined, charIndex: number): number {
  if (!row || charIndex <= 0) return 0;
  let lo = 0;
  let hi = row.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (row.translateToString(false, 0, mid).length <= charIndex) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}

/** Where a character index inside a logical line lands in the buffer. */
function bufferPosition(buf: IBuffer, line: LogicalLine, index: number): { row: number; col: number } {
  let left = index;
  for (const seg of line.segments) {
    if (left < seg.length) return { row: seg.row, col: columnAt(buf.getLine(seg.row), left) };
    left -= seg.length;
  }
  return { row: line.row, col: 0 };
}

/**
 * Search over one terminal's buffer. `WebTerm.search` is one of these.
 *
 * `find` starts from the last match, or from the top of the viewport when there
 * is none, so calling it again walks to the next match. It wraps around the end
 * of the buffer.
 */
export class BufferSearch {
  private readonly terminal: () => Terminal | undefined;
  private lastQuery = '';
  private lastCaseSensitive = false;
  private match: { line: number; index: number; row: number } | null = null;

  constructor(terminal: () => Terminal | undefined) {
    this.terminal = terminal;
  }

  /** The last query, or '' when there is none. */
  get query(): string {
    return this.lastQuery;
  }

  /** Find `query`, select it and scroll it into view. Null when there is no match. */
  find(query: string, options: SearchOptions = {}): SearchMatch | null {
    const term = this.terminal();
    if (!term) return null;
    const q = String(query);
    if (!q || q.length > MAX_SEARCH_QUERY) return null;
    const caseSensitive = !!options.caseSensitive;
    const backwards = !!options.backwards;
    if (q !== this.lastQuery || caseSensitive !== this.lastCaseSensitive) this.match = null;
    this.lastQuery = q;
    this.lastCaseSensitive = caseSensitive;

    const buf = term.buffer.active;
    const lines = logicalLines(buf);
    if (!lines.length) return null;
    const needle = caseSensitive ? q : q.toLowerCase();

    // Start where the last match was, so next and previous walk.
    const from = this.match ? this.match.row : buf.viewportY;
    let startLine = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.row <= from) startLine = i;
      else break;
    }

    for (let n = 0; n <= lines.length; n++) {
      const i = backwards
        ? (startLine - n + lines.length * 2) % lines.length
        : (startLine + n) % lines.length;
      const line = lines[i]!;
      const hay = caseSensitive ? line.text : line.text.toLowerCase();
      // Skip the match the caller is already sitting on, so a second call
      // moves instead of answering the same row.
      let index: number;
      if (n === 0 && this.match && this.match.line === line.row) {
        index = backwards
          ? this.match.index > 0
            ? hay.lastIndexOf(needle, this.match.index - 1)
            : -1
          : hay.indexOf(needle, this.match.index + 1);
      } else {
        index = backwards ? hay.lastIndexOf(needle) : hay.indexOf(needle);
      }
      if (index < 0) continue;

      const at = bufferPosition(buf, line, index);
      const last = bufferPosition(buf, line, index + q.length - 1);
      this.match = { line: line.row, index, row: at.row };
      // The selection is measured in cells, which differ from characters for
      // a wide character, and a match can run onto the next row.
      const lastWidth = buf.getLine(last.row)?.getCell(last.col)?.getWidth() || 1;
      const cells = (last.row - at.row) * term.cols + last.col + lastWidth - at.col;
      term.select(at.col, at.row, Math.max(cells, 1));
      if (at.row < buf.viewportY || at.row >= buf.viewportY + term.rows) {
        term.scrollToLine(Math.max(0, at.row - Math.floor(term.rows / 2)));
      }
      return { row: at.row, col: at.col, length: q.length };
    }
    this.match = null;
    return null;
  }

  /** The next match for the last query. Null when there is no query. */
  findNext(): SearchMatch | null {
    return this.lastQuery ? this.find(this.lastQuery, { caseSensitive: this.lastCaseSensitive }) : null;
  }

  /** The previous match for the last query. Null when there is no query. */
  findPrevious(): SearchMatch | null {
    return this.lastQuery
      ? this.find(this.lastQuery, { caseSensitive: this.lastCaseSensitive, backwards: true })
      : null;
  }

  /** Forget the query and drop the selection. */
  clear(): void {
    this.lastQuery = '';
    this.match = null;
    this.terminal()?.clearSelection();
  }
}
