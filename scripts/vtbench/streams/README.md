# Captured streams

Real byte streams, captured from real programs through a real pty. Nothing
here is hand-written, and nothing is a synthetic best case for either parser.

Stored gzipped: 25 MB of raw pty output does not belong in a git history. The
`bytes` column is the uncompressed size, which is what the benchmark feeds.
The harnesses decompress once up front, outside every timed region.

Each was captured with `capture.py` (in this directory), which forks a pty,
sets the window size with `TIOCSWINSZ`, sets `TERM=xterm-256color`, runs the
program, and records every byte the program wrote for a fixed duration.

| file | program | capture size | bytes | what it exercises |
| --- | --- | --- | --- | --- |
| `plain-ls.raw.gz` | `ls -laR --color=never /usr/lib /usr/share` | 200x55 | 8,000,000 | plain text and newlines, zero escape sequences |
| `scroll-cat.raw.gz` | `cat /var/log/pacman.log` | 200x55 | 4,098,879 | continuous scrolling, 48,826 line feeds, almost no escapes |
| `sgr-bat.raw.gz` | `bat --color=always` over a 300 KB JS bundle | 200x55 | 8,000,000 | SGR-dominated: 520,252 SGR sequences, one per 15 bytes |
| `btop-200x55.raw.gz` | `btop` | 200x55 | 3,915,103 | heavy TUI redraw: 202,535 CSI, 147,795 SGR, 579,834 bytes of non-ASCII box drawing, no line feeds at all |
| `btop-80x24.raw.gz` | `btop` | 80x24 | 979,686 | the same, captured at a small grid |
| `vim-200x55.raw.gz` | `vim` paging through a 4 MB log with `syntax on` | 200x55 | 779,468 | full-screen repaints driven by 120 page-forward keys |

Measured escape density, from `node -e` over each file:

```
plain-ls        ESC       0  CSI       0  SGR       0  LF 147692
scroll-cat      ESC      38  CSI      30  SGR      30  LF  48826
sgr-bat         ESC  520253  CSI  520253  SGR  520252  LF  51860
btop-200x55     ESC  202535  CSI  202535  SGR  147795  LF      0
btop-80x24      ESC   59384  CSI   59384  SGR   46063  LF      0
vim-200x55      ESC   59190  CSI   59185  SGR   38629  LF     50
```

## A stream captured at one size, replayed at another

The runner feeds every stream at every grid size. A stream captured at 200x55
and replayed into an 80x24 grid is not what that program would have emitted at
80x24: absolute cursor addressing lands differently and lines wrap where they
would not have.

That is fine for this measurement and deliberate. Both emulators receive the
identical bytes and are judged on the identical work, so the comparison holds.
What the small-grid rows do not tell you is how a program behaves at that size,
only how the two parsers compare on that byte mix at that grid geometry. The
`btop-80x24.raw.gz` capture is included so there is at least one genuinely
size-matched TUI stream for the small grid.
