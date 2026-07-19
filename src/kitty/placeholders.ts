/*
 * Unicode placeholder placements, the mode `yazi` and `ratatui-image` use.
 *
 * Instead of asking the terminal to draw an image at the cursor, the client
 * transmits it with `U=1`, which places it virtually and moves nothing, and
 * then writes a grid of U+10EEEE characters wherever it wants the image to
 * appear. Each of those cells carries its row and column in combining
 * diacritics and the image id in its foreground colour, so the grid is a
 * complete description of the placement: which image, which part of it, and
 * exactly which cells it occupies.
 *
 * That last part is the reason this module exists. A virtual placement has no
 * geometry of its own to recompute. The cells the client reserved are readable
 * from the buffer, so the overlay covers those cells and no others, and the
 * question of whether the terminal's idea of the image's size in cells agrees
 * with the client's never arises. It routinely does not: a client sizes its
 * transmission against the cell box it was told over `CSI 16 t`, and a browser
 * terminal's cell box is whatever the font and the device pixel ratio make it.
 *
 * No font has a glyph for U+10EEEE, so an uncovered placeholder cell shows as a
 * tofu box in the image id's colour. Covering every reserved cell is therefore
 * not a nicety; it is the whole visible contract.
 */
import type { Terminal } from '@xterm/xterm';

/** The placeholder character itself. */
export const PLACEHOLDER_CODE = 0x10eeee;

/**
 * The row/column diacritics, from kitty's `gen/rowcolumn-diacritics.txt`.
 *
 * A code point's index in this list is the row or column number it encodes, so
 * the list is an ordered table rather than a set and its order is load-bearing.
 * It is derived from Unicode 6.0.0's combining marks, which is what fixes the
 * numbering; a newer Unicode would renumber every cell.
 */
const DIACRITICS = [
  0x305, 0x30d, 0x30e, 0x310, 0x312, 0x33d, 0x33e, 0x33f, 0x346, 0x34a, 0x34b, 0x34c, 0x350,
  0x351, 0x352, 0x357, 0x35b, 0x363, 0x364, 0x365, 0x366, 0x367, 0x368, 0x369, 0x36a, 0x36b,
  0x36c, 0x36d, 0x36e, 0x36f, 0x483, 0x484, 0x485, 0x486, 0x487, 0x592, 0x593, 0x594, 0x595,
  0x597, 0x598, 0x599, 0x59c, 0x59d, 0x59e, 0x59f, 0x5a0, 0x5a1, 0x5a8, 0x5a9, 0x5ab, 0x5ac,
  0x5af, 0x5c4, 0x610, 0x611, 0x612, 0x613, 0x614, 0x615, 0x616, 0x617, 0x657, 0x658, 0x659,
  0x65a, 0x65b, 0x65d, 0x65e, 0x6d6, 0x6d7, 0x6d8, 0x6d9, 0x6da, 0x6db, 0x6dc, 0x6df, 0x6e0,
  0x6e1, 0x6e2, 0x6e4, 0x6e7, 0x6e8, 0x6eb, 0x6ec, 0x730, 0x732, 0x733, 0x735, 0x736, 0x73a,
  0x73d, 0x73f, 0x740, 0x741, 0x743, 0x745, 0x747, 0x749, 0x74a, 0x7eb, 0x7ec, 0x7ed, 0x7ee,
  0x7ef, 0x7f0, 0x7f1, 0x7f3, 0x816, 0x817, 0x818, 0x819, 0x81b, 0x81c, 0x81d, 0x81e, 0x81f,
  0x820, 0x821, 0x822, 0x823, 0x825, 0x826, 0x827, 0x829, 0x82a, 0x82b, 0x82c, 0x82d, 0x951,
  0x953, 0x954, 0xf82, 0xf83, 0xf86, 0xf87, 0x135d, 0x135e, 0x135f, 0x17dd, 0x193a, 0x1a17,
  0x1a75, 0x1a76, 0x1a77, 0x1a78, 0x1a79, 0x1a7a, 0x1a7b, 0x1a7c, 0x1b6b, 0x1b6d, 0x1b6e,
  0x1b6f, 0x1b70, 0x1b71, 0x1b72, 0x1b73, 0x1cd0, 0x1cd1, 0x1cd2, 0x1cda, 0x1cdb, 0x1ce0,
  0x1dc0, 0x1dc1, 0x1dc3, 0x1dc4, 0x1dc5, 0x1dc6, 0x1dc7, 0x1dc8, 0x1dc9, 0x1dcb, 0x1dcc,
  0x1dd1, 0x1dd2, 0x1dd3, 0x1dd4, 0x1dd5, 0x1dd6, 0x1dd7, 0x1dd8, 0x1dd9, 0x1dda, 0x1ddb,
  0x1ddc, 0x1ddd, 0x1dde, 0x1ddf, 0x1de0, 0x1de1, 0x1de2, 0x1de3, 0x1de4, 0x1de5, 0x1de6,
  0x1dfe, 0x20d0, 0x20d1, 0x20d4, 0x20d5, 0x20d6, 0x20d7, 0x20db, 0x20dc, 0x20e1, 0x20e7,
  0x20e9, 0x20f0, 0x2cef, 0x2cf0, 0x2cf1, 0x2de0, 0x2de1, 0x2de2, 0x2de3, 0x2de4, 0x2de5,
  0x2de6, 0x2de7, 0x2de8, 0x2de9, 0x2dea, 0x2deb, 0x2dec, 0x2ded, 0x2dee, 0x2def, 0x2df0,
  0x2df1, 0x2df2, 0x2df3, 0x2df4, 0x2df5, 0x2df6, 0x2df7, 0x2df8, 0x2df9, 0x2dfa, 0x2dfb,
  0x2dfc, 0x2dfd, 0x2dfe, 0x2dff, 0xa66f, 0xa67c, 0xa67d, 0xa6f0, 0xa6f1, 0xa8e0, 0xa8e1,
  0xa8e2, 0xa8e3, 0xa8e4, 0xa8e5, 0xa8e6, 0xa8e7, 0xa8e8, 0xa8e9, 0xa8ea, 0xa8eb, 0xa8ec,
  0xa8ed, 0xa8ee, 0xa8ef, 0xa8f0, 0xa8f1, 0xaab0, 0xaab2, 0xaab3, 0xaab7, 0xaab8, 0xaabe,
  0xaabf, 0xaac1, 0xfe20, 0xfe21, 0xfe22, 0xfe23, 0xfe24, 0xfe25, 0xfe26, 0x10a0f, 0x10a38,
  0x1d185, 0x1d186, 0x1d187, 0x1d188, 0x1d189, 0x1d1aa, 0x1d1ab, 0x1d1ac, 0x1d1ad, 0x1d242,
  0x1d243, 0x1d244,
];

const DIACRITIC_INDEX = new Map<number, number>(DIACRITICS.map((cp, index) => [cp, index]));

/**
 * A run of placeholder cells the overlay can cover with one canvas.
 *
 * `cellX` and `screenRow` locate it on the visible grid; `srcCol` and `srcRow`
 * say which part of the image's own cell grid it shows, which is what makes a
 * partly scrolled or partly overwritten grid still draw the right slice.
 */
export interface PlaceholderRun {
  imageId: number;
  cellX: number;
  screenRow: number;
  cols: number;
  rows: number;
  srcCol: number;
  srcRow: number;
}

/** The cell's foreground colour as a 24-bit number, or null when it has none. */
function foregroundId(cell: {
  isFgRGB(): boolean;
  isFgPalette(): boolean;
  getFgColor(): number;
}): number | null {
  if (cell.isFgRGB()) return cell.getFgColor() & 0xffffff;
  // A 256-colour foreground addresses an image id below 256, which is how a
  // client that cannot emit truecolor names its image.
  if (cell.isFgPalette()) return cell.getFgColor();
  return null;
}

/**
 * Read the placeholder grid off the visible screen.
 *
 * Cells are gathered left to right into horizontal runs of the same image with
 * consecutive columns, then runs on adjacent screen rows that cover the same
 * columns of the same image are merged downwards, so a full grid comes back as
 * one rectangle rather than one run per row. Fewer, larger rectangles matter
 * beyond tidiness: each becomes a canvas scaled from the source, and slicing an
 * image per row reintroduces exactly the sub-pixel seams this is meant to avoid.
 *
 * Diacritics may be omitted, which the protocol allows: a cell with no row
 * diacritic continues the row of the cell before it, and a cell with no column
 * diacritic continues the column sequence.
 */
export function scanPlaceholders(term: Terminal): PlaceholderRun[] {
  const buffer = term.buffer.active;
  const runs: PlaceholderRun[] = [];
  // Runs closed on the row above, keyed by the image and the columns they
  // cover, so a matching run on this row extends one of them downwards rather
  // than becoming a rectangle of its own.
  let above = new Map<string, PlaceholderRun>();

  const shape = (run: PlaceholderRun) =>
    `${run.imageId}:${run.cellX}:${run.cols}:${run.srcCol}`;

  for (let screenRow = 0; screenRow < term.rows; screenRow++) {
    const line = buffer.getLine(buffer.viewportY + screenRow);
    const closed = new Map<string, PlaceholderRun>();

    const close = (run: PlaceholderRun | null): null => {
      if (!run) return null;
      const previous = above.get(shape(run));
      if (
        previous &&
        previous.screenRow + previous.rows === run.screenRow &&
        previous.srcRow + previous.rows === run.srcRow
      ) {
        previous.rows++;
        closed.set(shape(previous), previous);
      } else {
        runs.push(run);
        closed.set(shape(run), run);
      }
      return null;
    };

    if (line) {
      let open: PlaceholderRun | null = null;
      let lastRow = 0;
      let lastCol = -1;

      for (let x = 0; x < term.cols; x++) {
        const cell = line.getCell(x);
        const chars = cell?.getChars() ?? '';
        // A cell whose foreground carries no colour names no image, so it is
        // not a placeholder this can act on however it is spelled.
        const low = cell && chars.codePointAt(0) === PLACEHOLDER_CODE ? foregroundId(cell) : null;
        if (low === null) {
          open = close(open);
          lastCol = -1;
          continue;
        }

        const points = [...chars].slice(1).map((ch) => ch.codePointAt(0) as number);
        const rowIndex = points.length > 0 ? DIACRITIC_INDEX.get(points[0]) : undefined;
        const colIndex = points.length > 1 ? DIACRITIC_INDEX.get(points[1]) : undefined;
        const highByte = points.length > 2 ? DIACRITIC_INDEX.get(points[2]) : undefined;

        const imageId = ((highByte ?? 0) * 0x100_0000 + low) >>> 0;
        const srcRow = rowIndex ?? (lastCol >= 0 ? lastRow : 0);
        const srcCol = colIndex ?? (lastCol >= 0 ? lastCol + 1 : 0);

        if (
          open &&
          open.imageId === imageId &&
          open.srcRow === srcRow &&
          open.cellX + open.cols === x &&
          open.srcCol + open.cols === srcCol
        ) {
          open.cols++;
        } else {
          open = close(open);
          open = { imageId, cellX: x, screenRow, cols: 1, rows: 1, srcCol, srcRow };
        }
        lastRow = srcRow;
        lastCol = srcCol;
      }
      close(open);
    }

    above = closed;
  }

  return runs;
}
