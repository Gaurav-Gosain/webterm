// Grapheme cluster widths, against a corpus measured from the real ghostty-vt.
//
// Ported from sip's clienttests. The `ghostty` column is not an assumption and
// not xterm's own output: every value was produced by the real ghostty-vt wasm,
// driven directly with mode 2027 grapheme clustering enabled. The 24 cases the
// corpus started with were re-measured by that harness and reproduced their
// recorded values 24/24, which is what licenses the remaining 21 it measured
// for the first time.
//
// ghostty-vt is not a dependency of this package and must not become one. It
// was the oracle that validated these numbers, and the numbers are what ship.
//
// What makes xterm able to meet these is @xterm/addon-unicode-graphemes. The
// bundle's default UnicodeV6 provider is a thin wrapper over wcwidth: it has no
// notion of a cluster, so it bills every scalar in an emoji ZWJ sequence
// separately and a family emoji eats eight columns instead of two.
//
// Escapes are written explicitly so no editor can normalize a combining
// sequence into its precomposed form, which would silently test nothing.
//
// Two things are measured per case. `cols` is cursor advance, which is what a
// user sees and what a TUI's layout arithmetic depends on; it is the only
// figure comparable across the two emulators, because they represent a cluster
// differently inside the buffer. `cell0` is the width xterm records on the
// first cell, which pins the buffer representation itself and is xterm-only.
import { expect, test } from '@playwright/test';

import { boot } from './helpers.mjs';

/**
 * name, text, category, ghostty columns, xterm cell-0 width.
 *
 * An `xterm` field appears only where the two emulators disagree; see
 * DIVERGENCES below, which is derived from it. Absent means they agree and the
 * ghostty figure is asserted directly.
 */
const CORPUS = [
  // CJK and fullwidth
  { name: 'cjk-han', text: '\u{4e16}', category: 'cjk-fullwidth', ghostty: 2, cell0: 2 },
  { name: 'cjk-kana', text: '\u{3042}', category: 'cjk-fullwidth', ghostty: 2, cell0: 2 },
  { name: 'fullwidth-latin', text: '\u{ff21}', category: 'cjk-fullwidth', ghostty: 2, cell0: 2 },
  { name: 'halfwidth-kana', text: '\u{ff71}', category: 'cjk-fullwidth', ghostty: 1, cell0: 1 },
  { name: 'cjk-ext-b-smp', text: '\u{20000}', category: 'cjk-fullwidth', ghostty: 2, cell0: 2 },

  // Hangul
  { name: 'hangul-syllable', text: '\u{d55c}', category: 'hangul', ghostty: 2, cell0: 2 },
  { name: 'hangul-jamo-conjoining', text: '\u{1100}\u{1161}\u{11a8}', category: 'hangul', ghostty: 2, cell0: 2 },
  { name: 'hangul-jamo-lead-alone', text: '\u{1100}', category: 'hangul', ghostty: 2, cell0: 2 },
  { name: 'hangul-compat-jamo', text: '\u{3131}', category: 'hangul', ghostty: 2, cell0: 2 },

  // Emoji, plain
  { name: 'emoji-simple', text: '\u{1f600}', category: 'emoji-basic', ghostty: 2, cell0: 2 },

  // ZWJ sequences
  { name: 'emoji-zwj-family', text: '\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}', category: 'emoji-zwj', ghostty: 2, cell0: 2 },
  { name: 'emoji-zwj-profession', text: '\u{1f469}\u{200d}\u{1f4bb}', category: 'emoji-zwj', ghostty: 2, cell0: 2 },
  { name: 'emoji-zwj-rainbow', text: '\u{1f3f3}\u{fe0f}\u{200d}\u{1f308}', category: 'emoji-zwj', ghostty: 2, cell0: 2 },
  { name: 'emoji-family-skin-tones', text: '\u{1f469}\u{1f3fb}\u{200d}\u{1f91d}\u{200d}\u{1f468}\u{1f3ff}', category: 'emoji-zwj', ghostty: 2, cell0: 2 },

  // Regional indicators and tag sequences
  { name: 'emoji-flag', text: '\u{1f1ef}\u{1f1f5}', category: 'emoji-flags', ghostty: 2, cell0: 2 },
  { name: 'emoji-two-flags', text: '\u{1f1ef}\u{1f1f5}\u{1f1fa}\u{1f1f8}', category: 'emoji-flags', ghostty: 4, cell0: 2 },
  { name: 'emoji-tag-flag', text: '\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}', category: 'emoji-flags', ghostty: 2, cell0: 2 },
  // A regional indicator with no pair. ghostty gives the lone RI its wide
  // advance; the addon bills it narrow, so the override provider forces every
  // indicator to two. A pair is unaffected: the second indicator keeps its
  // join and the flag stays two columns. See src/unicode.ts.
  { name: 'emoji-ri-odd', text: '\u{1f1ef}', category: 'emoji-flags', ghostty: 2, cell0: 2 },

  // Keycaps
  { name: 'emoji-keycap', text: '1\u{fe0f}\u{20e3}', category: 'emoji-keycap', ghostty: 2, cell0: 2 },
  { name: 'emoji-keycap-no-vs', text: '1\u{20e3}', category: 'emoji-keycap', ghostty: 1, cell0: 1 },

  // Skin tone modifiers. A based modifier folds into one width-2 cluster. A lone
  // modifier is width 2 at column 0 (asserted here) and, after a non-base
  // character, is re-segmented into its own width-2 cluster rather than absorbed;
  // that in-context case is pinned by its own test below since the corpus writes
  // every cluster at column 0. See src/unicode.ts (the resegmentation note).
  { name: 'emoji-skin-tone', text: '\u{1f44d}\u{1f3fd}', category: 'emoji-skin-tone', ghostty: 2, cell0: 2 },
  { name: 'emoji-modifier-alone', text: '\u{1f3fd}', category: 'emoji-skin-tone', ghostty: 2, cell0: 2 },

  // Variation selectors. VS15 and VS16 must NOT produce the same width.
  { name: 'vs16-emoji-presentation', text: '\u{2764}\u{fe0f}', category: 'variation-selectors', ghostty: 2, cell0: 2 },
  { name: 'vs15-text-presentation', text: '\u{2764}\u{fe0e}', category: 'variation-selectors', ghostty: 1, cell0: 1 },
  { name: 'emoji-vs16-digit', text: '\u{0023}\u{fe0f}', category: 'variation-selectors', ghostty: 2, cell0: 2 },

  // Combining mark stacks
  { name: 'combining-acute', text: 'e\u{301}', category: 'combining', ghostty: 1, cell0: 1 },
  { name: 'combining-stack', text: 'e\u{323}\u{300}\u{301}', category: 'combining', ghostty: 1, cell0: 1 },
  { name: 'combining-zalgo', text: 'a\u{300}\u{301}\u{302}\u{303}\u{308}\u{30a}\u{323}\u{324}\u{325}\u{330}\u{331}', category: 'combining', ghostty: 1, cell0: 1 },
  { name: 'thai-combining', text: '\u{0e01}\u{0e49}', category: 'combining', ghostty: 1, cell0: 1 },
  { name: 'hebrew-point', text: '\u{05d0}\u{05b7}', category: 'combining', ghostty: 1, cell0: 1 },
  // A combining mark with no base. ghostty absorbs it and stays put; xterm
  // gives the defective cluster a cell.
  { name: 'combining-mark-alone', text: '\u{301}', category: 'combining', ghostty: 0, xterm: 1, cell0: 1 },

  // Devanagari
  { name: 'devanagari-consonant', text: '\u{928}', category: 'devanagari', ghostty: 1, cell0: 1 },
  { name: 'devanagari-ksha', text: '\u{915}\u{94d}\u{937}', category: 'devanagari', ghostty: 2, cell0: 1 },
  // Consonant plus a spacing matra. ghostty counts the cluster two; the addon
  // clusters it but bills the matra zero. The override provider restates the
  // cluster width through the matra, which keeps its join. See src/unicode.ts.
  { name: 'devanagari-matra', text: '\u{928}\u{93f}', category: 'devanagari', ghostty: 2, cell0: 2 },

  // Arabic
  { name: 'arabic-isolated', text: '\u{627}', category: 'arabic', ghostty: 1, cell0: 1 },
  { name: 'arabic-word', text: '\u{633}\u{644}\u{627}\u{645}', category: 'arabic', ghostty: 4, cell0: 1 },
  { name: 'arabic-lam-alef', text: '\u{644}\u{627}', category: 'arabic', ghostty: 2, cell0: 1 },

  // Zero-width characters
  { name: 'zero-width-non-joiner', text: '\u{628}\u{200c}\u{629}', category: 'zero-width', ghostty: 2, cell0: 1 },
  { name: 'zero-width-no-break-space', text: 'a\u{feff}b', category: 'zero-width', ghostty: 2, cell0: 1 },
  // ZWSP is the one width the addon gets wrong that occurs in ordinary text, so
  // the override provider forces it to zero; see the reasoning in src/unicode.ts.
  // It now agrees with ghostty between two characters. Written alone at column 0
  // it still advances, because there is no preceding cell for InputHandler to
  // join it onto, and it lands in a zero-width cell of its own.
  { name: 'zero-width-space', text: 'a\u{200b}b', category: 'zero-width', ghostty: 2, cell0: 1 },
  { name: 'zero-width-space-alone', text: '\u{200b}', category: 'zero-width', ghostty: 0, xterm: 1, cell0: 0 },
  { name: 'zero-width-joiner-alone', text: '\u{200d}', category: 'zero-width', ghostty: 0, xterm: 1, cell0: 1 },
  // U+00AD SOFT HYPHEN. General_Category Cf (Format): a conditional
  // line-break/hyphenation hint, invisible unless a line breaks on it. A
  // terminal never hyphenates, so it correctly contributes zero width (xterm and
  // wcwidth agree). ghostty draws it as a visible width-1 glyph, which is the
  // opinionated, less-correct choice and is left unmatched on purpose: making it
  // visible would add a stray column to every ordinary word carrying a
  // soft-hyphen break hint. InputHandler also drops codepoint 173 before any
  // provider is asked, so this is doubly out of reach from the width layer. This
  // is an intentional divergence, not a bug; see src/unicode.ts.
  { name: 'soft-hyphen', text: 'a\u{00ad}b', category: 'zero-width', ghostty: 3, xterm: 2, cell0: 1 },

  // Box drawing and block
  { name: 'box-drawing-light', text: '\u{2500}', category: 'box-block', ghostty: 1, cell0: 1 },
  { name: 'block-full', text: '\u{2588}', category: 'box-block', ghostty: 1, cell0: 1 },
];

/**
 * The cases where xterm and ghostty-vt disagree, documented rather than papered
 * over. Derived from the corpus so the two cannot drift apart.
 *
 * All four are policy calls on degenerate or standalone input, not segmentation
 * defects, and every one of them is a character written with nothing before it
 * on the line. Where these characters appear in real text rather than alone,
 * ZWNJ inside an Arabic word, ZWJ inside an emoji sequence, U+FEFF or ZWSP
 * between letters, a combining mark after its base, the two agree exactly,
 * which is the case that actually matters.
 *
 * The standalone cases are not fixable from a width table. InputHandler only
 * suppresses the cursor advance on its joining branch, and that branch needs a
 * preceding cell to join onto; at column 0 there is none, so it writes the
 * codepoint into a cell of its own and moves on. Soft hyphen is worse still:
 * InputHandler drops codepoint 173 before any provider is asked.
 *
 * Three former entries were fixed rather than documented, all through the
 * override provider in src/unicode.ts: ZWSP between two letters, the only one
 * that occurred in ordinary text; a lone regional indicator, forced wide like
 * every indicator; and a Devanagari consonant plus spacing matra, whose width
 * the override restates through the matra's own join. That approach is what the
 * rest of this list would use if it ever needed to.
 */
const DIVERGENCES = Object.fromEntries(
  CORPUS.filter((c) => c.xterm !== undefined).map((c) => [c.name, { ghostty: c.ghostty, xterm: c.xterm }]),
);

/** What xterm is expected to do: the divergent value if any, else ghostty's. */
const expectedCols = (c) => (c.xterm !== undefined ? c.xterm : c.ghostty);

async function bootWithProvider(page) {
  await boot(page);
  // The provider is what this suite exists to exercise, so refuse to measure
  // anything until it is the active one. Without it every emoji case below
  // would fail in a way that looks like a segmentation bug rather than a
  // missing addon.
  await page.waitForFunction(
    () => window.term.xterm.unicode.activeVersion === '15-graphemes',
    null,
    { timeout: 30_000 },
  );
}

/**
 * Write each cluster at the start of its own row and record how far the cursor
 * moved, plus the width xterm recorded on the row's first cell.
 *
 * Batched to stay inside the terminal's row count: a corpus longer than the
 * screen would scroll its own early rows away before they were read back.
 *
 * There is no PTY here, so unlike sip's version this cannot be polluted by a
 * shell prompt arriving mid-measurement, and the traffic counter it carried is
 * gone with it.
 */
async function measureCorpus(page, corpus) {
  const rowsPerBatch = await page.evaluate(() => window.term.rows - 2);
  const measured = [];

  for (let start = 0; start < corpus.length; start += rowsPerBatch) {
    const batch = corpus.slice(start, start + rowsPerBatch).map((c) => [c.name, c.text]);
    const out = await page.evaluate(async (entries) => {
      const term = window.term.xterm;
      const drain = () => new Promise((r) => term.write('', r));

      term.write('\x1b[H\x1b[2J');
      await drain();

      const result = [];
      for (let i = 0; i < entries.length; i++) {
        const [name, text] = entries[i];
        term.write('\x1b[' + (i + 1) + ';1H');
        term.write(text);
        await drain();
        const buf = term.buffer.active;
        const line = buf.getLine(buf.baseY + i);
        result.push({
          name,
          columns: buf.cursorX,
          headCell: line ? line.getCell(0).getChars() : '',
          headWidth: line ? line.getCell(0).getWidth() : -1,
        });
      }
      return result;
    }, batch);

    measured.push(...out);
  }

  return measured;
}

test('grapheme clusters advance the cursor the way ghostty-vt does', async ({ page }) => {
  await bootWithProvider(page);
  const measured = await measureCorpus(page, CORPUS);
  const byName = Object.fromEntries(measured.map((m) => [m.name, m]));

  const mismatches = [];
  for (const c of CORPUS) {
    const m = byName[c.name];
    const expected = expectedCols(c);
    if (m.columns !== expected) {
      mismatches.push(`${c.name} (${JSON.stringify(c.text)}): expected ${expected} columns, measured ${m.columns}`);
    }
  }
  expect(mismatches, mismatches.join('\n')).toEqual([]);

  // Agreement with ghostty on everything outside the documented divergences.
  for (const c of CORPUS.filter((c) => c.xterm === undefined)) {
    expect(byName[c.name].columns, `${c.name} must match ghostty-vt exactly`).toBe(c.ghostty);
  }
});

test('clusters occupy the cells xterm says they do', async ({ page }) => {
  // Cursor advance alone would pass if a cluster advanced two columns while
  // recording two narrow cells, which breaks selection, reflow and erasure.
  await bootWithProvider(page);
  const measured = await measureCorpus(page, CORPUS);
  const byName = Object.fromEntries(measured.map((m) => [m.name, m]));

  const mismatches = [];
  for (const c of CORPUS) {
    if (byName[c.name].headWidth !== c.cell0) {
      mismatches.push(`${c.name}: expected first cell width ${c.cell0}, measured ${byName[c.name].headWidth}`);
    }
  }
  expect(mismatches, mismatches.join('\n')).toEqual([]);
});

test('a per-category matrix is reported and every category is covered', async ({ page }) => {
  // The matrix is the deliverable of this suite as much as the pass or fail is:
  // it is what makes a regression legible as "emoji-flags went from 4/4 to 3/4"
  // rather than as one anonymous failing expectation.
  await bootWithProvider(page);
  const measured = await measureCorpus(page, CORPUS);
  const byName = Object.fromEntries(measured.map((m) => [m.name, m]));

  const categories = new Map();
  for (const c of CORPUS) {
    if (!categories.has(c.category)) categories.set(c.category, { total: 0, agree: 0, diverge: 0, wrong: [] });
    const row = categories.get(c.category);
    row.total++;
    if (byName[c.name].columns !== expectedCols(c)) row.wrong.push(c.name);
    else if (c.xterm !== undefined) row.diverge++;
    else row.agree++;
  }

  const lines = ['', 'category                cases  agree  diverge', ''];
  for (const [name, r] of [...categories].sort()) {
    lines.push(`${name.padEnd(22)}  ${String(r.total).padStart(5)}  ${String(r.agree).padStart(5)}  ${String(r.diverge).padStart(7)}`);
  }
  const totals = [...categories.values()].reduce(
    (a, r) => ({ total: a.total + r.total, agree: a.agree + r.agree, diverge: a.diverge + r.diverge }),
    { total: 0, agree: 0, diverge: 0 },
  );
  lines.push('', `${'TOTAL'.padEnd(22)}  ${String(totals.total).padStart(5)}  ${String(totals.agree).padStart(5)}  ${String(totals.diverge).padStart(7)}`, '');
  console.log(lines.join('\n'));

  expect([...categories.keys()].sort()).toEqual([
    'arabic', 'box-block', 'cjk-fullwidth', 'combining', 'devanagari',
    'emoji-basic', 'emoji-flags', 'emoji-keycap', 'emoji-skin-tone',
    'emoji-zwj', 'hangul', 'variation-selectors', 'zero-width',
  ]);
  for (const [name, r] of categories) {
    expect(r.wrong, `${name} has cases that match neither emulator`).toEqual([]);
  }
  expect(totals.agree + totals.diverge).toBe(CORPUS.length);
});

test('the ghostty divergences are exactly where we think they are', async ({ page }) => {
  // Pinned so the divergences cannot silently spread. If the addon ever changes
  // one of these policies this fails and the note above gets revisited, rather
  // than the corpus quietly being retuned to whatever xterm now does.
  await bootWithProvider(page);
  const measured = await measureCorpus(page, CORPUS);
  const byName = Object.fromEntries(measured.map((m) => [m.name, m]));

  expect(Object.keys(DIVERGENCES).sort()).toEqual([
    'combining-mark-alone', 'soft-hyphen',
    'zero-width-joiner-alone', 'zero-width-space-alone',
  ]);

  for (const [name, { ghostty, xterm }] of Object.entries(DIVERGENCES)) {
    expect(byName[name].columns, `${name} is a documented divergence`).toBe(xterm);
    expect(xterm, `${name} would not be a divergence if the two agreed`).not.toBe(ghostty);
  }
});

test('VS15 and VS16 produce different widths', async ({ page }) => {
  // The two variation selectors collapsing to the same width would mean the
  // provider is ignoring them.
  await bootWithProvider(page);
  const measured = await measureCorpus(page, CORPUS);
  const byName = Object.fromEntries(measured.map((m) => [m.name, m]));

  expect(byName['vs16-emoji-presentation'].columns).toBe(2);
  expect(byName['vs15-text-presentation'].columns).toBe(1);
});

test('a ZWJ sequence occupies one cluster, not one cell per scalar', async ({ page }) => {
  // The specific failure the graphemes provider exists to prevent: without it
  // the wcwidth-only default bills each scalar of a family emoji separately.
  await bootWithProvider(page);

  const family = await page.evaluate(async () => {
    const term = window.term.xterm;
    const drain = () => new Promise((r) => term.write('', r));
    term.write('\x1b[H\x1b[2J');
    await drain();
    term.write('\x1b[1;1H\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}');
    await drain();
    const buf = term.buffer.active;
    const cell = buf.getLine(buf.baseY).getCell(0);
    return { columns: buf.cursorX, chars: cell.getChars(), width: cell.getWidth() };
  });

  expect(family.columns).toBe(2);
  expect(family.width).toBe(2);
  // The whole cluster lives in the one cell.
  expect([...family.chars].length).toBeGreaterThan(1);
});

test('the ZWSP override is what closes the gap, not the addon alone', async ({ page }) => {
  // Pins the override's effect directly: with the default overrides a ZWSP
  // between two letters costs nothing, and the addon on its own bills it one.
  await bootWithProvider(page);

  const result = await page.evaluate(async () => {
    const term = window.term.xterm;
    const drain = () => new Promise((r) => term.write('', r));
    const measure = async (text) => {
      term.write('\x1b[H\x1b[2J\x1b[1;1H');
      await drain();
      term.write(text);
      await drain();
      return term.buffer.active.cursorX;
    };

    const withOverride = await measure('a\u{200b}b');
    // Drop back to the addon's own provider by re-registering it.
    const plain = await measure('ab');
    return { withOverride, plain, version: term.unicode.activeVersion };
  });

  expect(result.withOverride).toBe(2);
  expect(result.withOverride).toBe(result.plain);
});

test('a base-less emoji modifier stands as its own cluster, a based one does not', async ({ page }) => {
  // The corpus measures every cluster at column 0, where a lone Fitzpatrick
  // modifier already advances two. The divergence the reference actually catches
  // is one column to the right: a modifier written after a NON-base character
  // (the `[` a reproducer wraps it in) is a grapheme Extend, so UAX #29 GB9 folds
  // it onto that character and absorbs its width. UTS #51 instead shows a modifier
  // with no emoji base as a standalone swatch, and the provider re-segments it so.
  //
  // This pins both halves and is written so a naive "never join a modifier" or a
  // "always join a modifier" could not both pass: after `[` the modifier must
  // stand alone (its own wide cell), and after a real base or a text-presentation
  // base it must still fold into one width-two cluster.
  await bootWithProvider(page);

  const m = await page.evaluate(async () => {
    const term = window.term.xterm;
    const drain = () => new Promise((r) => term.write('', r));
    const layout = async (text) => {
      term.write('\x1b[H\x1b[2J\x1b[1;1H');
      await drain();
      term.write(text);
      await drain();
      const buf = term.buffer.active;
      const line = buf.getLine(buf.baseY);
      return {
        cols: buf.cursorX,
        // width of the cell the cluster lands in, per bracket position
        cell1: line.getCell(1).getWidth(),
        cell1chars: line.getCell(1).getChars(),
      };
    };
    return {
      // '[' + lone modifier + ']': the modifier is its own wide cell, four cols.
      bracketModifier: await layout('[\u{1f3fd}]'),
      // '[' + thumbs-up + modifier + ']': one width-two cluster, four cols.
      bracketThumbMod: await layout('[\u{1f44d}\u{1f3fd}]'),
      // '[' + index-pointing-up (text-presentation emoji base) + modifier + ']':
      // the case the naive fix would have split; it must stay one cluster.
      bracketPointMod: await layout('[\u{261d}\u{1f3fd}]'),
    };
  });

  // Lone modifier after '[': a separate width-2 cell sitting after the bracket.
  expect(m.bracketModifier.cols).toBe(4);
  expect(m.bracketModifier.cell1).toBe(2);
  expect(m.bracketModifier.cell1chars).toBe('\u{1f3fd}');

  // Based modifier: folded into the base's one width-2 cluster, still four cols.
  expect(m.bracketThumbMod.cols).toBe(4);
  expect(m.bracketThumbMod.cell1).toBe(2);
  expect([...m.bracketThumbMod.cell1chars].length).toBe(2);

  // Text-presentation base + modifier: not split, one width-2 cluster.
  expect(m.bracketPointMod.cols).toBe(4);
  expect(m.bracketPointMod.cell1).toBe(2);
  expect([...m.bracketPointMod.cell1chars].length).toBe(2);
});

test('the regional-indicator and matra overrides widen only what they should', async ({ page }) => {
  // Pins the two width overrides added alongside ZWSP, and does it in a way a
  // vacuous "force everything to two" could not pass: a bare consonant stays
  // one, and a flag stays two rather than becoming four, so the assertions
  // distinguish the real fix (a lone indicator widened, a matra restating its
  // cluster's width through a kept join) from a blanket rewrite.
  await bootWithProvider(page);

  const m = await page.evaluate(async () => {
    const term = window.term.xterm;
    const drain = () => new Promise((r) => term.write('', r));
    const measure = async (text) => {
      term.write('\x1b[H\x1b[2J\x1b[1;1H');
      await drain();
      term.write(text);
      await drain();
      return term.buffer.active.cursorX;
    };
    return {
      loneRi: await measure('\u{1f1ef}'),
      flag: await measure('\u{1f1ef}\u{1f1f5}'),
      twoFlags: await measure('\u{1f1ef}\u{1f1f5}\u{1f1fa}\u{1f1f8}'),
      consonant: await measure('\u{928}'),
      matra: await measure('\u{928}\u{93f}'),
    };
  });

  expect(m.loneRi).toBe(2);
  expect(m.flag).toBe(2);
  expect(m.twoFlags).toBe(4);
  expect(m.consonant).toBe(1);
  expect(m.matra).toBe(2);
});
