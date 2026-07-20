// The conformance corpus.
//
// Enumerated from the sequence tables in the DEC STD 070 / VT510 manuals and
// from ctlseqs.ms (the xterm control sequence reference), category by category,
// rather than from whatever came to mind. Each case names the sequence it
// exercises so a divergence can be looked up in the spec.
//
// Each case:
//   name     stable id
//   cat      category, for the summary table
//   seq      the exact bytes fed to both emulators
//   cols/rows optional grid override (default 20x6)
//   style    compare per-cell attributes as well as text
//   expect   what the spec requires, where the harness can state it as
//            { text } (row strings) and/or { cursor: [x, y] }. Absent means
//            the case is a differential probe only: the two are compared
//            against each other but the harness does not assert a winner.
//
// `expect` is written from the spec, not from either implementation's output.
// Where a spec genuinely leaves behaviour undefined, expect is omitted and the
// case is reported as differential-only.

const D = { cols: 20, rows: 6 };

/** Pad a row to the grid width the way the drivers trim it (trailing blanks off). */
function row(s) {
  return s.replace(/\s+$/, '');
}

/** Build the 6 default rows with `rows` overridden from index 0. */
function grid(...rows) {
  const out = rows.map(row);
  while (out.length < D.rows) out.push('');
  return out;
}

export const CORPUS = [
  // ---------------------------------------------------------------- cursor
  // CSI A/B/C/D and friends. ctlseqs: CUU, CUD, CUF, CUB, CNL, CPL, CHA, CUP,
  // HVP, VPA, VPR, HPA, HPR.
  { name: 'cup-basic', cat: 'cursor', seq: '\x1b[3;5H', expect: { cursor: [4, 2] } },
  { name: 'cup-defaults', cat: 'cursor', seq: '\x1b[5;5H\x1b[H', expect: { cursor: [0, 0] } },
  { name: 'cup-omitted-params', cat: 'cursor', seq: '\x1b[5;5H\x1b[;H', expect: { cursor: [0, 0] } },
  { name: 'cup-row-only', cat: 'cursor', seq: '\x1b[4H', expect: { cursor: [0, 3] } },
  { name: 'cup-clamp-past-end', cat: 'cursor', seq: '\x1b[99;99H', expect: { cursor: [19, 5] } },
  { name: 'cup-zero-params', cat: 'cursor', seq: '\x1b[0;0H', expect: { cursor: [0, 0] } },
  { name: 'cuu', cat: 'cursor', seq: '\x1b[5;5H\x1b[2A', expect: { cursor: [4, 2] } },
  { name: 'cuu-clamp-top', cat: 'cursor', seq: '\x1b[2;5H\x1b[9A', expect: { cursor: [4, 0] } },
  { name: 'cud', cat: 'cursor', seq: '\x1b[1;5H\x1b[2B', expect: { cursor: [4, 2] } },
  { name: 'cud-clamp-bottom', cat: 'cursor', seq: '\x1b[1;5H\x1b[99B', expect: { cursor: [4, 5] } },
  { name: 'cuf', cat: 'cursor', seq: '\x1b[3C', expect: { cursor: [3, 0] } },
  { name: 'cuf-clamp-right', cat: 'cursor', seq: '\x1b[99C', expect: { cursor: [19, 0] } },
  { name: 'cub', cat: 'cursor', seq: '\x1b[1;10H\x1b[3D', expect: { cursor: [6, 0] } },
  { name: 'cub-clamp-left', cat: 'cursor', seq: '\x1b[1;5H\x1b[99D', expect: { cursor: [0, 0] } },
  { name: 'cnl', cat: 'cursor', seq: '\x1b[1;10H\x1b[2E', expect: { cursor: [0, 2] } },
  { name: 'cpl', cat: 'cursor', seq: '\x1b[4;10H\x1b[2F', expect: { cursor: [0, 1] } },
  { name: 'cha', cat: 'cursor', seq: '\x1b[3;3H\x1b[8G', expect: { cursor: [7, 2] } },
  { name: 'vpa', cat: 'cursor', seq: '\x1b[1;7H\x1b[4d', expect: { cursor: [6, 3] } },
  { name: 'vpr', cat: 'cursor', seq: '\x1b[1;7H\x1b[2e', expect: { cursor: [6, 2] } },
  { name: 'hpa', cat: 'cursor', seq: '\x1b[3;3H\x1b[9`', expect: { cursor: [8, 2] } },
  { name: 'hpr', cat: 'cursor', seq: '\x1b[3;3H\x1b[4a', expect: { cursor: [6, 2] } },
  { name: 'hvp', cat: 'cursor', seq: '\x1b[3;5f', expect: { cursor: [4, 2] } },
  // CUF at the right margin must not set the pending-wrap flag: a following
  // printable character overwrites the last column rather than wrapping.
  { name: 'cuf-no-pending-wrap', cat: 'cursor', cols: 5, seq: '\x1b[5CX', expect: { cursor: [4, 0] } },

  // -------------------------------------------------------------- wrapping
  // DECAWM (mode 7) and the deferred-wrap rule: printing in the last column
  // leaves the cursor there with a pending flag; the wrap happens on the next
  // printable character.
  { name: 'autowrap-on', cat: 'wrap', cols: 5, seq: 'abcdef', expect: { text: grid('abcde', 'f'), cursor: [1, 1] } },
  { name: 'autowrap-exact-fill', cat: 'wrap', cols: 5, seq: 'abcde', expect: { text: grid('abcde'), cursor: [4, 0] } },
  { name: 'autowrap-off', cat: 'wrap', cols: 5, seq: '\x1b[?7labcdef', expect: { text: grid('abcdf'), cursor: [4, 0] } },
  // Whether re-enabling DECAWM at the last column leaves a wrap pending is not
  // pinned down by the spec. Both emulators wrap here; differential only.
  { name: 'autowrap-off-then-on', cat: 'wrap', cols: 5, seq: '\x1b[?7labcdef\x1b[?7hg' },
  // CR clears the pending-wrap flag.
  { name: 'pending-wrap-cleared-by-cr', cat: 'wrap', cols: 5, seq: 'abcde\rX', expect: { text: grid('Xbcde'), cursor: [1, 0] } },
  // A wide character that does not fit in the last column wraps whole.
  { name: 'wide-char-at-margin', cat: 'wrap', cols: 5, seq: 'abcd世', expect: { text: grid('abcd', '世'), cursor: [2, 1] } },
  { name: 'wide-char-exact-fit', cat: 'wrap', cols: 6, seq: 'abcd世', expect: { text: grid('abcd世'), cursor: [5, 0] } },
  // Reverse wraparound, mode 45.
  { name: 'reverse-wrap-off', cat: 'wrap', cols: 5, seq: '\x1b[2;1H\x1b[D', expect: { cursor: [0, 1] } },
  { name: 'reverse-wrap-on', cat: 'wrap', cols: 5, seq: '\x1b[?45h\x1b[2;1H\x1b[D' },

  // ---------------------------------------------------------------- erase
  // ED (J) 0/1/2/3 and EL (K) 0/1/2.
  { name: 'ed-0-below', cat: 'erase', seq: 'aaa\r\nbbb\r\nccc\x1b[2;2H\x1b[0J', expect: { text: grid('aaa', 'b'), cursor: [1, 1] } },
  { name: 'ed-1-above', cat: 'erase', seq: 'aaa\r\nbbb\r\nccc\x1b[2;2H\x1b[1J', expect: { text: grid('', '  b', 'ccc'), cursor: [1, 1] } },
  { name: 'ed-2-all', cat: 'erase', seq: 'aaa\r\nbbb\x1b[2;2H\x1b[2J', expect: { text: grid(), cursor: [1, 1] } },
  { name: 'ed-3-scrollback', cat: 'erase', seq: 'aaa\r\nbbb\x1b[3J' },
  { name: 'ed-default-is-0', cat: 'erase', seq: 'aaa\r\nbbb\x1b[1;2H\x1b[J', expect: { text: grid('a'), cursor: [1, 0] } },
  { name: 'el-0-right', cat: 'erase', seq: 'abcdef\x1b[1;3H\x1b[0K', expect: { text: grid('ab'), cursor: [2, 0] } },
  { name: 'el-1-left', cat: 'erase', seq: 'abcdef\x1b[1;3H\x1b[1K', expect: { text: grid('   def'), cursor: [2, 0] } },
  { name: 'el-2-line', cat: 'erase', seq: 'abcdef\x1b[1;3H\x1b[2K', expect: { text: grid(), cursor: [2, 0] } },
  { name: 'el-default-is-0', cat: 'erase', seq: 'abcdef\x1b[1;3H\x1b[K', expect: { text: grid('ab'), cursor: [2, 0] } },
  { name: 'ech', cat: 'erase', seq: 'abcdef\x1b[1;2H\x1b[3X', expect: { text: grid('a   ef'), cursor: [1, 0] } },
  { name: 'ech-clamp', cat: 'erase', seq: 'abcdef\x1b[1;2H\x1b[99X', expect: { text: grid('a'), cursor: [1, 0] } },
  { name: 'ech-zero-is-one', cat: 'erase', seq: 'abcdef\x1b[1;2H\x1b[0X', expect: { text: grid('a cdef'), cursor: [1, 0] } },

  // ----------------------------------------------------------------- edit
  // ICH, DCH, IL, DL.
  { name: 'ich', cat: 'edit', seq: 'abcdef\x1b[1;3H\x1b[2@', expect: { text: grid('ab  cdef'), cursor: [2, 0] } },
  { name: 'ich-pushes-off-end', cat: 'edit', cols: 6, seq: 'abcdef\x1b[1;3H\x1b[2@', expect: { text: grid('ab  cd'), cursor: [2, 0] } },
  { name: 'dch', cat: 'edit', seq: 'abcdef\x1b[1;3H\x1b[2P', expect: { text: grid('abef'), cursor: [2, 0] } },
  { name: 'dch-clamp', cat: 'edit', seq: 'abcdef\x1b[1;3H\x1b[99P', expect: { text: grid('ab'), cursor: [2, 0] } },
  { name: 'il', cat: 'edit', seq: 'aaa\r\nbbb\r\nccc\x1b[2;1H\x1b[1L', expect: { text: grid('aaa', '', 'bbb', 'ccc'), cursor: [0, 1] } },
  { name: 'il-scrolls-off', cat: 'edit', rows: 3, seq: 'aaa\r\nbbb\r\nccc\x1b[1;1H\x1b[1L', expect: { text: ['', 'aaa', 'bbb'], cursor: [0, 0] } },
  { name: 'dl', cat: 'edit', seq: 'aaa\r\nbbb\r\nccc\x1b[2;1H\x1b[1M', expect: { text: grid('aaa', 'ccc'), cursor: [0, 1] } },
  { name: 'dl-clamp', cat: 'edit', seq: 'aaa\r\nbbb\r\nccc\x1b[2;1H\x1b[99M', expect: { text: grid('aaa'), cursor: [0, 1] } },
  // IRM (mode 4), insert vs replace.
  { name: 'irm-insert', cat: 'edit', seq: 'abcdef\x1b[1;3H\x1b[4hXY', expect: { text: grid('abXYcdef'), cursor: [4, 0] } },
  { name: 'irm-replace-default', cat: 'edit', seq: 'abcdef\x1b[1;3HXY', expect: { text: grid('abXYef'), cursor: [4, 0] } },
  { name: 'irm-reset', cat: 'edit', seq: 'abcdef\x1b[1;3H\x1b[4h\x1b[4lXY', expect: { text: grid('abXYef'), cursor: [4, 0] } },

  // --------------------------------------------------------------- scroll
  // DECSTBM and SU/SD. Setting a region homes the cursor.
  { name: 'decstbm-homes-cursor', cat: 'scroll', seq: '\x1b[3;5H\x1b[2;4r', expect: { cursor: [0, 0] } },
  { name: 'decstbm-scrolls-within', cat: 'scroll', rows: 5, seq: 'a\r\nb\r\nc\r\nd\r\ne\x1b[2;4r\x1b[4;1H\n', expect: { text: ['a', 'c', 'd', '', 'e'], cursor: [0, 3] } },
  { name: 'decstbm-reset', cat: 'scroll', rows: 4, seq: '\x1b[2;3r\x1b[r\x1b[4;1H\n', expect: { cursor: [0, 3] } },
  { name: 'su', cat: 'scroll', rows: 4, seq: 'a\r\nb\r\nc\r\nd\x1b[2S', expect: { text: ['c', 'd', '', ''] } },
  { name: 'sd', cat: 'scroll', rows: 4, seq: 'a\r\nb\r\nc\r\nd\x1b[2T', expect: { text: ['', '', 'a', 'b'] } },
  { name: 'su-within-region', cat: 'scroll', rows: 5, seq: 'a\r\nb\r\nc\r\nd\r\ne\x1b[2;4r\x1b[1S', expect: { text: ['a', 'c', 'd', '', 'e'] } },
  // RI at the top of a region scrolls the region down.
  { name: 'ri-at-region-top', cat: 'scroll', rows: 5, seq: 'a\r\nb\r\nc\r\nd\r\ne\x1b[2;4r\x1b[2;1H\x1bM', expect: { text: ['a', '', 'b', 'c', 'e'] } },
  { name: 'ri-at-screen-top', cat: 'scroll', rows: 4, seq: 'a\r\nb\r\nc\x1b[1;1H\x1bM', expect: { text: ['', 'a', 'b', 'c'] } },
  { name: 'ind-at-region-bottom', cat: 'scroll', rows: 5, seq: 'a\r\nb\r\nc\r\nd\r\ne\x1b[2;4r\x1b[4;1H\x1bD', expect: { text: ['a', 'c', 'd', '', 'e'] } },
  { name: 'nel', cat: 'scroll', seq: 'abc\x1bE', expect: { text: grid('abc'), cursor: [0, 1] } },

  // ---------------------------------------------------------- origin mode
  // DECOM (mode 6): CUP becomes relative to the scroll region and the cursor
  // cannot leave it.
  { name: 'decom-cup-relative', cat: 'origin', rows: 6, seq: '\x1b[2;4r\x1b[?6h\x1b[1;1H', expect: { cursor: [0, 1] } },
  { name: 'decom-clamps-below', cat: 'origin', rows: 6, seq: '\x1b[2;4r\x1b[?6h\x1b[99;1H', expect: { cursor: [0, 3] } },
  { name: 'decom-off-is-absolute', cat: 'origin', rows: 6, seq: '\x1b[2;4r\x1b[?6l\x1b[1;1H', expect: { cursor: [0, 0] } },
  { name: 'decom-write-lands-in-region', cat: 'origin', rows: 6, seq: '\x1b[2;4r\x1b[?6h\x1b[1;1HX', expect: { text: grid('', 'X'), cursor: [1, 1] } },

  // ----------------------------------------------------------------- tabs
  { name: 'tab-default-stops', cat: 'tabs', seq: '\tX', expect: { text: grid('        X'), cursor: [9, 0] } },
  { name: 'tab-multiple', cat: 'tabs', seq: '\t\tX', expect: { text: grid('                X'), cursor: [17, 0] } },
  { name: 'tab-clamp-at-margin', cat: 'tabs', cols: 10, seq: '\t\t\t\tX', expect: { cursor: [9, 0] } },
  { name: 'hts-sets-stop', cat: 'tabs', seq: '\x1b[1;4H\x1bH\x1b[1;1H\tX', expect: { text: grid('   X'), cursor: [4, 0] } },
  { name: 'tbc-0-clears-one', cat: 'tabs', seq: '\x1b[1;9H\x1b[0g\x1b[1;1H\tX', expect: { text: grid('                X'), cursor: [17, 0] } },
  { name: 'tbc-3-clears-all', cat: 'tabs', cols: 20, seq: '\x1b[3g\x1b[1;1H\tX', expect: { cursor: [19, 0] } },
  { name: 'cht-forward', cat: 'tabs', seq: '\x1b[2I X', expect: { cursor: [18, 0] } },
  { name: 'cbt-backward', cat: 'tabs', seq: '\x1b[1;18H\x1b[2Z', expect: { cursor: [8, 0] } },

  // ------------------------------------------------------------- charsets
  // SCS: ESC ( 0 selects DEC Special Graphics into G0; SO/SI shift between
  // G0 and G1. The line-drawing repertoire is what every TUI box uses.
  { name: 'scs-g0-decgraphics', cat: 'charset', seq: '\x1b(0lqk\x1b(B', expect: { text: grid('┌─┐') } },
  { name: 'scs-g0-full-repertoire', cat: 'charset', seq: '\x1b(0jklmnqtuvwx\x1b(B', expect: { text: grid('┘┐┌└┼─├┤┴┬│') } },
  { name: 'scs-g1-with-so-si', cat: 'charset', seq: '\x1b)0\x0elqk\x0fabc', expect: { text: grid('┌─┐abc') } },
  { name: 'scs-back-to-ascii', cat: 'charset', seq: '\x1b(0l\x1b(Bl', expect: { text: grid('┌l') } },
  // G2/G3 and the single shifts SS2/SS3.
  { name: 'scs-g2-ss2', cat: 'charset', seq: '\x1b*0\x1bNlA', expect: { text: grid('┌A') } },
  { name: 'scs-g3-ss3', cat: 'charset', seq: '\x1b+0\x1bOlA', expect: { text: grid('┌A') } },
  // LS2/LS3 locking shifts.
  { name: 'scs-ls2', cat: 'charset', seq: '\x1b*0\x1bnlqk', expect: { text: grid('┌─┐') } },
  { name: 'scs-ls3', cat: 'charset', seq: '\x1b+0\x1bolqk', expect: { text: grid('┌─┐') } },
  // DECALN fills the screen with E, a classic alignment probe.
  { name: 'decaln', cat: 'charset', cols: 5, rows: 3, seq: '\x1b#8', expect: { text: ['EEEEE', 'EEEEE', 'EEEEE'], cursor: [0, 0] } },
  // UK charset, ESC ( A: # becomes a pound sign.
  { name: 'scs-uk', cat: 'charset', seq: '\x1b(A#\x1b(B#', expect: { text: grid('£#') } },

  // ------------------------------------------------------------------ sgr
  { name: 'sgr-bold', cat: 'sgr', seq: '\x1b[1mA', style: true },
  { name: 'sgr-faint', cat: 'sgr', seq: '\x1b[2mA', style: true },
  { name: 'sgr-italic', cat: 'sgr', seq: '\x1b[3mA', style: true },
  { name: 'sgr-underline', cat: 'sgr', seq: '\x1b[4mA', style: true },
  { name: 'sgr-blink', cat: 'sgr', seq: '\x1b[5mA', style: true },
  { name: 'sgr-inverse', cat: 'sgr', seq: '\x1b[7mA', style: true },
  { name: 'sgr-invisible', cat: 'sgr', seq: '\x1b[8mA', style: true },
  { name: 'sgr-strikethrough', cat: 'sgr', seq: '\x1b[9mA', style: true },
  { name: 'sgr-double-underline', cat: 'sgr', seq: '\x1b[21mA', style: true },
  { name: 'sgr-overline', cat: 'sgr', seq: '\x1b[53mA', style: true },
  { name: 'sgr-reset-all', cat: 'sgr', seq: '\x1b[1;4;31m\x1b[0mA', style: true },
  { name: 'sgr-bold-off-22', cat: 'sgr', seq: '\x1b[1m\x1b[22mA', style: true },
  { name: 'sgr-22-clears-faint-too', cat: 'sgr', seq: '\x1b[2m\x1b[22mA', style: true },
  { name: 'sgr-italic-off-23', cat: 'sgr', seq: '\x1b[3m\x1b[23mA', style: true },
  { name: 'sgr-underline-off-24', cat: 'sgr', seq: '\x1b[4m\x1b[24mA', style: true },
  { name: 'sgr-blink-off-25', cat: 'sgr', seq: '\x1b[5m\x1b[25mA', style: true },
  { name: 'sgr-inverse-off-27', cat: 'sgr', seq: '\x1b[7m\x1b[27mA', style: true },
  { name: 'sgr-strike-off-29', cat: 'sgr', seq: '\x1b[9m\x1b[29mA', style: true },
  { name: 'sgr-overline-off-55', cat: 'sgr', seq: '\x1b[53m\x1b[55mA', style: true },
  { name: 'sgr-fg-basic', cat: 'sgr', seq: '\x1b[31mA', style: true },
  { name: 'sgr-bg-basic', cat: 'sgr', seq: '\x1b[41mA', style: true },
  { name: 'sgr-fg-bright', cat: 'sgr', seq: '\x1b[91mA', style: true },
  { name: 'sgr-bg-bright', cat: 'sgr', seq: '\x1b[101mA', style: true },
  { name: 'sgr-fg-default-39', cat: 'sgr', seq: '\x1b[31m\x1b[39mA', style: true },
  { name: 'sgr-bg-default-49', cat: 'sgr', seq: '\x1b[41m\x1b[49mA', style: true },
  { name: 'sgr-256-fg', cat: 'sgr', seq: '\x1b[38;5;200mA', style: true },
  { name: 'sgr-256-bg', cat: 'sgr', seq: '\x1b[48;5;200mA', style: true },
  { name: 'sgr-truecolor-fg', cat: 'sgr', seq: '\x1b[38;2;10;20;30mA', style: true },
  { name: 'sgr-truecolor-bg', cat: 'sgr', seq: '\x1b[48;2;10;20;30mA', style: true },
  // Colon-delimited SGR, the ODA/ITU form. This is what a lot of modern
  // software emits and is a common source of divergence.
  { name: 'sgr-colon-truecolor', cat: 'sgr', seq: '\x1b[38:2::10:20:30mA', style: true },
  { name: 'sgr-colon-truecolor-noskip', cat: 'sgr', seq: '\x1b[38:2:10:20:30mA', style: true },
  { name: 'sgr-colon-256', cat: 'sgr', seq: '\x1b[38:5:200mA', style: true },
  // Underline styles, SGR 4:1 through 4:5, and the underline colour, SGR 58.
  { name: 'sgr-underline-single-colon', cat: 'sgr', seq: '\x1b[4:1mA', style: true },
  { name: 'sgr-underline-double-colon', cat: 'sgr', seq: '\x1b[4:2mA', style: true },
  { name: 'sgr-underline-curly', cat: 'sgr', seq: '\x1b[4:3mA', style: true },
  { name: 'sgr-underline-dotted', cat: 'sgr', seq: '\x1b[4:4mA', style: true },
  { name: 'sgr-underline-dashed', cat: 'sgr', seq: '\x1b[4:5mA', style: true },
  { name: 'sgr-underline-none-colon', cat: 'sgr', seq: '\x1b[4:3m\x1b[4:0mA', style: true },
  { name: 'sgr-underline-color-256', cat: 'sgr', seq: '\x1b[4m\x1b[58;5;200mA', style: true },
  { name: 'sgr-underline-color-rgb', cat: 'sgr', seq: '\x1b[4m\x1b[58;2;10;20;30mA', style: true },
  { name: 'sgr-underline-color-default-59', cat: 'sgr', seq: '\x1b[4m\x1b[58;5;200m\x1b[59mA', style: true },
  // Empty and multi-param SGR.
  { name: 'sgr-empty-is-reset', cat: 'sgr', seq: '\x1b[1;31m\x1b[mA', style: true },
  { name: 'sgr-multi-param', cat: 'sgr', seq: '\x1b[1;3;4;31;42mA', style: true },
  // An unknown SGR parameter must not discard the ones around it.
  { name: 'sgr-unknown-param-mid', cat: 'sgr', seq: '\x1b[1;99;4mA', style: true },

  // -------------------------------------------------------- save / restore
  { name: 'decsc-decrc', cat: 'save', seq: '\x1b[3;5H\x1b7\x1b[1;1H\x1b8', expect: { cursor: [4, 2] } },
  { name: 'csi-s-u', cat: 'save', seq: '\x1b[3;5H\x1b[s\x1b[1;1H\x1b[u', expect: { cursor: [4, 2] } },
  { name: 'decsc-restores-sgr', cat: 'save', seq: '\x1b[31m\x1b7\x1b[0m\x1b8A', style: true },
  { name: 'decrc-without-save', cat: 'save', seq: '\x1b[3;5H\x1b8', expect: { cursor: [0, 0] } },
  { name: 'decsc-restores-charset', cat: 'save', seq: '\x1b(0\x1b7\x1b(B\x1b8l', expect: { text: grid('┌') } },

  // ---------------------------------------------------------- alt screen
  { name: 'alt-1049-enter', cat: 'altscreen', seq: 'main\x1b[?1049h', expect: { text: grid() } },
  { name: 'alt-1049-roundtrip', cat: 'altscreen', seq: 'main\x1b[?1049halt\x1b[?1049l', expect: { text: grid('main') } },
  { name: 'alt-1049-restores-cursor', cat: 'altscreen', seq: '\x1b[3;5H\x1b[?1049h\x1b[1;1H\x1b[?1049l', expect: { cursor: [4, 2] } },
  { name: 'alt-47-roundtrip', cat: 'altscreen', seq: 'main\x1b[?47halt\x1b[?47l', expect: { text: grid('main') } },
  { name: 'alt-1047-roundtrip', cat: 'altscreen', seq: 'main\x1b[?1047halt\x1b[?1047l', expect: { text: grid('main') } },
  { name: 'alt-1048-cursor-only', cat: 'altscreen', seq: '\x1b[3;5H\x1b[?1048h\x1b[1;1H\x1b[?1048l', expect: { cursor: [4, 2] } },
  { name: 'alt-scrollback-not-kept', cat: 'altscreen', rows: 3, seq: '\x1b[?1049ha\r\nb\r\nc\r\nd\x1b[?1049l' },

  // ---------------------------------------------------------------- reset
  { name: 'ris', cat: 'reset', seq: '\x1b[31mabc\x1b[3;5H\x1bc', expect: { text: grid(), cursor: [0, 0] } },
  { name: 'ris-clears-scroll-region', cat: 'reset', rows: 4, seq: '\x1b[2;3r\x1bc\x1b[4;1H\n', expect: { cursor: [0, 3] } },
  { name: 'decstr', cat: 'reset', seq: '\x1b[?6h\x1b[2;3r\x1b[!p\x1b[1;1H', expect: { cursor: [0, 0] } },
  { name: 'decstr-keeps-text', cat: 'reset', seq: 'abc\x1b[!p', expect: { text: grid('abc') } },

  // ------------------------------------------------------- control chars
  { name: 'ctrl-bs', cat: 'control', seq: 'abc\bX', expect: { text: grid('abX'), cursor: [3, 0] } },
  { name: 'ctrl-bs-at-col0', cat: 'control', seq: '\bX', expect: { text: grid('X'), cursor: [1, 0] } },
  { name: 'ctrl-cr', cat: 'control', seq: 'abc\rX', expect: { text: grid('Xbc'), cursor: [1, 0] } },
  { name: 'ctrl-lf', cat: 'control', seq: 'abc\nX', expect: { text: grid('abc', '   X'), cursor: [4, 1] } },
  { name: 'ctrl-vt-acts-as-lf', cat: 'control', seq: 'abc\x0bX', expect: { text: grid('abc', '   X'), cursor: [4, 1] } },
  { name: 'ctrl-ff-acts-as-lf', cat: 'control', seq: 'abc\x0cX', expect: { text: grid('abc', '   X'), cursor: [4, 1] } },
  { name: 'ctrl-nul-ignored', cat: 'control', seq: 'a\x00b', expect: { text: grid('ab'), cursor: [2, 0] } },
  { name: 'ctrl-del-ignored', cat: 'control', seq: 'a\x7fb', expect: { text: grid('ab'), cursor: [2, 0] } },
  // LNM (mode 20): LF also does a carriage return.
  { name: 'lnm-on', cat: 'control', seq: '\x1b[20habc\nX', expect: { text: grid('abc', 'X'), cursor: [1, 1] } },
  { name: 'lnm-off', cat: 'control', seq: '\x1b[20labc\nX', expect: { text: grid('abc', '   X'), cursor: [4, 1] } },
  // A control character embedded inside a CSI sequence is executed, and the
  // sequence continues around it.
  { name: 'control-inside-csi', cat: 'control', seq: '\x1b[3\r;5HX' },
  // CAN and SUB abort a sequence in progress.
  { name: 'can-aborts-csi', cat: 'control', seq: '\x1b[3\x18;5HX' },
  { name: 'sub-aborts-csi', cat: 'control', seq: '\x1b[3\x1a;5HX' },

  // ---------------------------------------------------------- c1 controls
  // The 8-bit C1 forms. A UTF-8 stream should not treat 0x84 as IND, since
  // those bytes are continuation bytes; this is a real correctness question.
  { name: 'c1-ind-8bit', cat: 'c1', seq: 'abc\x84X' },
  { name: 'c1-nel-8bit', cat: 'c1', seq: 'abc\x85X' },
  { name: 'c1-ri-8bit', cat: 'c1', seq: '\x1b[2;1Habc\x8dX' },
  { name: 'c1-csi-8bit', cat: 'c1', seq: '\x9b3;5HX' },
  { name: 'c1-osc-8bit', cat: 'c1', seq: '\x9d0;t\x9cX' },

  // ----------------------------------------------------------------- osc
  { name: 'osc-0-title-bel', cat: 'osc', seq: '\x1b]0;hello\x07X', expect: { text: grid('X') } },
  { name: 'osc-0-title-st', cat: 'osc', seq: '\x1b]0;hello\x1b\\X', expect: { text: grid('X') } },
  { name: 'osc-2-title', cat: 'osc', seq: '\x1b]2;hello\x07X', expect: { text: grid('X') } },
  { name: 'osc-4-palette-set', cat: 'osc', seq: '\x1b]4;1;#ff0000\x07\x1b[31mA', style: true },
  { name: 'osc-8-hyperlink', cat: 'osc', seq: '\x1b]8;;https://example.com\x07link\x1b]8;;\x07', expect: { text: grid('link') } },
  { name: 'osc-52-clipboard', cat: 'osc', seq: '\x1b]52;c;aGVsbG8=\x07X', expect: { text: grid('X') } },
  { name: 'osc-104-palette-reset', cat: 'osc', seq: '\x1b]104\x07X', expect: { text: grid('X') } },
  { name: 'osc-10-11-fg-bg', cat: 'osc', seq: '\x1b]10;#ffffff\x07\x1b]11;#000000\x07X', expect: { text: grid('X') } },
  { name: 'osc-unterminated-eats-rest', cat: 'osc', seq: '\x1b]0;no-terminator-here' },
  { name: 'osc-empty', cat: 'osc', seq: '\x1b]\x07X', expect: { text: grid('X') } },

  // ----------------------------------------------------------------- dcs
  { name: 'dcs-decrqss-sgr', cat: 'dcs', seq: '\x1bP$qm\x1b\\X', expect: { text: grid('X') } },
  { name: 'dcs-decrqss-decstbm', cat: 'dcs', seq: '\x1bP$qr\x1b\\X', expect: { text: grid('X') } },
  { name: 'dcs-unknown-consumed', cat: 'dcs', seq: '\x1bPzzz\x1b\\X', expect: { text: grid('X') } },
  { name: 'dcs-sixel-consumed', cat: 'dcs', seq: '\x1bPq#0;2;0;0;0#0~~\x1b\\X' },
  { name: 'dcs-xtgettcap', cat: 'dcs', seq: '\x1bP+q544e\x1b\\X', expect: { text: grid('X') } },
  { name: 'dcs-unterminated', cat: 'dcs', seq: '\x1bPqqqq' },

  // ----------------------------------------------------------------- apc
  { name: 'apc-consumed', cat: 'apc', seq: '\x1b_Gf=24,s=1,v=1;AAAA\x1b\\X', expect: { text: grid('X') } },
  { name: 'apc-unterminated', cat: 'apc', seq: '\x1b_Gf=24' },
  // PM and SOS, the other string controls.
  { name: 'pm-consumed', cat: 'apc', seq: '\x1b^hello\x1b\\X', expect: { text: grid('X') } },
  { name: 'sos-consumed', cat: 'apc', seq: '\x1bXhello\x1b\\X', expect: { text: grid('X') } },

  // --------------------------------------------------------------- modes
  // Set/reset round-trips for the private modes a TUI actually uses. These
  // are compared through behaviour where possible and through the mode flag
  // where both expose one.
  { name: 'mode-25-cursor-hide', cat: 'modes', seq: '\x1b[?25l', mode: [25, false] },
  { name: 'mode-25-cursor-show', cat: 'modes', seq: '\x1b[?25l\x1b[?25h', mode: [25, false] },
  { name: 'mode-1-appcursor', cat: 'modes', seq: '\x1b[?1h', mode: [1, false] },
  { name: 'mode-7-autowrap', cat: 'modes', seq: '\x1b[?7l', mode: [7, false] },
  { name: 'mode-6-origin', cat: 'modes', seq: '\x1b[?6h', mode: [6, false] },
  { name: 'mode-45-reverse-wrap', cat: 'modes', seq: '\x1b[?45h', mode: [45, false] },
  { name: 'mode-1000-mouse', cat: 'modes', seq: '\x1b[?1000h', mode: [1000, false] },
  { name: 'mode-1002-mouse-drag', cat: 'modes', seq: '\x1b[?1002h', mode: [1002, false] },
  { name: 'mode-1003-mouse-any', cat: 'modes', seq: '\x1b[?1003h', mode: [1003, false] },
  { name: 'mode-1006-sgr-mouse', cat: 'modes', seq: '\x1b[?1006h', mode: [1006, false] },
  { name: 'mode-2004-bracketed-paste', cat: 'modes', seq: '\x1b[?2004h', mode: [2004, false] },
  { name: 'mode-2026-sync-output', cat: 'modes', seq: '\x1b[?2026h', mode: [2026, false] },
  { name: 'mode-1004-focus', cat: 'modes', seq: '\x1b[?1004h', mode: [1004, false] },
  { name: 'mode-4-irm-ansi', cat: 'modes', seq: '\x1b[4h', mode: [4, true] },
  { name: 'mode-20-lnm-ansi', cat: 'modes', seq: '\x1b[20h', mode: [20, true] },
  { name: 'mode-multi-set', cat: 'modes', seq: '\x1b[?1;7;25h', mode: [7, false] },

  // ------------------------------------------------------------ malformed
  // Parser robustness. None of these should corrupt the grid or wedge the
  // parser: the next printable character must land normally.
  { name: 'bad-huge-param', cat: 'malformed', seq: '\x1b[99999999999999999999HX' },
  { name: 'bad-many-params', cat: 'malformed', seq: `\x1b[${Array(40).fill('1').join(';')}HX` },
  { name: 'bad-unknown-final', cat: 'malformed', seq: '\x1b[3 \x1b[1;1HX' },
  { name: 'bad-unknown-csi-final', cat: 'malformed', seq: '\x1b[1;2~X' },
  { name: 'bad-intermediate-bytes', cat: 'malformed', seq: '\x1b[1 !"#pX' },
  { name: 'bad-private-prefix-unknown', cat: 'malformed', seq: '\x1b[<1;2;3mX' },
  { name: 'bad-esc-then-esc', cat: 'malformed', seq: '\x1b\x1b[1;1HX' },
  { name: 'bad-csi-then-esc', cat: 'malformed', seq: '\x1b[3\x1b[1;1HX' },
  { name: 'bad-negative-looking', cat: 'malformed', seq: '\x1b[-3HX' },
  { name: 'bad-colon-in-cup', cat: 'malformed', seq: '\x1b[3:5HX' },
  { name: 'bad-trailing-semicolons', cat: 'malformed', seq: '\x1b[1;;;;;HX' },
  { name: 'bad-lone-esc-then-text', cat: 'malformed', seq: 'a\x1bb' },
  { name: 'bad-incomplete-utf8', cat: 'malformed', seq: Buffer.from([0x61, 0xe4, 0xb8, 0x62]) },
  { name: 'bad-overlong-utf8', cat: 'malformed', seq: Buffer.from([0x61, 0xc0, 0x80, 0x62]) },
  { name: 'bad-lone-surrogate-utf8', cat: 'malformed', seq: Buffer.from([0x61, 0xed, 0xa0, 0x80, 0x62]) },
  { name: 'bad-invalid-continuation', cat: 'malformed', seq: Buffer.from([0x61, 0x80, 0x62]) },
  { name: 'bad-truncated-osc-then-csi', cat: 'malformed', seq: '\x1b]0;abc\x1b[1;1HX' },

  // ------------------------------------------------------------- unicode
  // Width and clustering are measured elsewhere; these check that grid
  // bookkeeping around a wide cell is right, which is a separate question.
  { name: 'wide-overwrite-left-half', cat: 'unicode', cols: 8, seq: '世界\x1b[1;1HX', expect: { cursor: [1, 0] } },
  { name: 'wide-overwrite-right-half', cat: 'unicode', cols: 8, seq: '世界\x1b[1;2HX', expect: { cursor: [2, 0] } },
  { name: 'wide-then-erase-half', cat: 'unicode', cols: 8, seq: '世界\x1b[1;2H\x1b[1X' },
  // Cluster composition is not comparable through this harness: ghostty keeps
  // the combining scalars of a cluster off to the side and
  // ghostty_grid_ref_graphemes returns -3 for them in this build, so the driver
  // reads back only each cell's base codepoint. The width and clustering axis is
  // measured separately, against this same ghostty-vt, by
  // test/browser/grapheme_corpus.spec.mjs. These two stay in the corpus so the
  // gap stays visible, but they are excluded from the divergence count.
  { name: 'combining-after-ascii', cat: 'unicode', cols: 8, seq: 'éX' , harnessLimited: 'cluster readback' },
  { name: 'zwj-emoji', cat: 'unicode', cols: 8, seq: '\u{1f468}‍\u{1f469}‍\u{1f467}X' , harnessLimited: 'cluster readback' },
  { name: 'wide-in-insert-mode', cat: 'unicode', cols: 8, seq: 'abcd\x1b[1;1H\x1b[4h世' },
];


/**
 * Query sequences, compared by what each emulator writes back up the pty.
 *
 * This is the capability-detection surface: a TUI sends these at startup and
 * changes what it emits based on the answer. A missing or wrong reply is
 * therefore reachable by real software in a way an obscure grid edge case is
 * not.
 *
 * `expect` is a regular expression the reply must match where the spec fixes
 * the shape of the reply; where the reply is legitimately terminal-specific
 * (a device attributes string names the device) only presence is required,
 * via `expectAny: true`.
 */
export const QUERIES = [
  { name: 'da1-primary', cat: 'query', seq: '\x1b[c', expectAny: true },
  { name: 'da2-secondary', cat: 'query', seq: '\x1b[>c', expectAny: true },
  { name: 'da3-tertiary', cat: 'query', seq: '\x1b[=c', expectAny: true },
  // DSR 6 must report the cursor as CSI row ; col R.
  { name: 'dsr-cursor-position', cat: 'query', seq: '\x1b[3;5H\x1b[6n', expect: /\x1b\[3;5R/ },
  { name: 'dsr-cursor-after-move', cat: 'query', seq: '\x1b[2;2H\x1b[6n', expect: /\x1b\[2;2R/ },
  // DSR 5 reports terminal status; ready is CSI 0 n.
  { name: 'dsr-status', cat: 'query', seq: '\x1b[5n', expect: /\x1b\[0n/ },
  // DECXCPR, the private cursor position report.
  { name: 'decxcpr', cat: 'query', seq: '\x1b[3;5H\x1b[?6n', expect: /\x1b\[\?3;5/ },
  // DECRQM: the reply is CSI ? mode ; value $ y, value 1 set, 2 reset.
  { name: 'decrqm-25-set', cat: 'query', seq: '\x1b[?25h\x1b[?25$p', expect: /\x1b\[\?25;1\$y/ },
  { name: 'decrqm-25-reset', cat: 'query', seq: '\x1b[?25l\x1b[?25$p', expect: /\x1b\[\?25;2\$y/ },
  { name: 'decrqm-7-set', cat: 'query', seq: '\x1b[?7h\x1b[?7$p', expect: /\x1b\[\?7;1\$y/ },
  { name: 'decrqm-1049', cat: 'query', seq: '\x1b[?1049$p', expect: /\x1b\[\?1049;\d\$y/ },
  { name: 'decrqm-2026-sync', cat: 'query', seq: '\x1b[?2026$p', expect: /\x1b\[\?2026;\d\$y/ },
  { name: 'decrqm-ansi-irm', cat: 'query', seq: '\x1b[4h\x1b[4$p', expect: /\x1b\[4;1\$y/ },
  // DECRQSS: the reply is DCS 1 $ r <setting> ST for a supported setting.
  { name: 'decrqss-sgr', cat: 'query', seq: '\x1b[1;31m\x1bP$qm\x1b\\', expect: /\x1bP1\$r.*m\x1b\\/ },
  { name: 'decrqss-decstbm', cat: 'query', seq: '\x1b[2;5r\x1bP$qr\x1b\\', expect: /\x1bP1\$r2;5r\x1b\\/ },
  { name: 'decrqss-decscusr', cat: 'query', seq: '\x1b[3 q\x1bP$q q\x1b\\', expect: /\x1bP1\$r3 q\x1b\\/ },
  // ENQ, answerback.
  { name: 'enq', cat: 'query', seq: '\x05', expectAny: false },
  // XTVERSION.
  { name: 'xtversion', cat: 'query', seq: '\x1b[>0q', expectAny: true },
  // XTGETTCAP for the TN capability (terminal name), hex-encoded "TN".
  { name: 'xtgettcap-tn', cat: 'query', seq: '\x1bP+q544e\x1b\\', expectAny: true },
  // These five are answered by ghostty-vt through host callbacks the embedder
  // registers (ghostty_terminal_set with COLOR_FOREGROUND, COLOR_BACKGROUND,
  // COLOR_PALETTE, SIZE), not through the pty write callback this harness
  // wires. ghostty replying nothing to them here is the harness's doing, so
  // they are scored for xterm.js only.
  // Window operations: 14 t is the text area in pixels, 18 t the size in cells.
  { name: 'xtwinops-14-pixels', cat: 'query', ghosttyNeedsHostCallback: true, seq: '\x1b[14t', expect: /\x1b\[4;\d+;\d+t/ },
  { name: 'xtwinops-18-chars', cat: 'query', ghosttyNeedsHostCallback: true, seq: '\x1b[18t', expect: /\x1b\[8;6;20t/ },
  // OSC colour queries. The reply repeats the OSC with an rgb: spec.
  { name: 'osc-4-query', cat: 'query', ghosttyNeedsHostCallback: true, seq: '\x1b]4;1;?\x07', expect: /\x1b\]4;1;rgb:/ },
  { name: 'osc-10-query-fg', cat: 'query', ghosttyNeedsHostCallback: true, seq: '\x1b]10;?\x07', expect: /\x1b\]10;rgb:/ },
  { name: 'osc-11-query-bg', cat: 'query', ghosttyNeedsHostCallback: true, seq: '\x1b]11;?\x07', expect: /\x1b\]11;rgb:/ },
];

export const CATEGORIES = [...new Set(CORPUS.map((c) => c.cat))];
