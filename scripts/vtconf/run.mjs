// Feed every corpus case to ghostty-vt and to xterm.js and diff the result.
//
//   node scripts/vtconf/run.mjs                 summary to stdout
//   node scripts/vtconf/run.mjs --json out.json full results
//   node scripts/vtconf/run.mjs --only cursor   one category
//   node scripts/vtconf/run.mjs --case cup-basic
//   node scripts/vtconf/run.mjs --verbose       print every divergence in full
//
// By default the xterm side is bare @xterm/headless, which is what the package
// takes as a peer dependency. --webterm measures what the package actually
// ships instead: the same XTWINOPS gate webterm opens and the same report
// handlers it registers. That side is TypeScript source, so it needs the loader
// the unit suite uses:
//
//   node --import ./test/register-ts.mjs scripts/vtconf/run.mjs --webterm
//
// Each case is run on a fresh terminal on both sides, so no case can
// contaminate the next.

import { writeFileSync } from 'node:fs';

import { CORPUS, QUERIES } from './corpus.mjs';
import { GhosttyTerm, loadGhostty } from './ghostty.mjs';
import { XtermTerm } from './xterm.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

const VERBOSE = flag('--verbose');
const ONLY = opt('--only');
const CASE = opt('--case');
const JSON_OUT = opt('--json');
const WEBTERM = flag('--webterm');

/**
 * webterm's report layer, or null when measuring bare xterm.js.
 *
 * Imported from source rather than from dist so the harness measures the tree
 * at hand and not the last build. The import is dynamic because it only
 * resolves under the TypeScript loader.
 */
const LAYER = WEBTERM ? await import('../../src/reports.ts') : null;

const DEFAULT_COLS = 20;
const DEFAULT_ROWS = 6;

/** Compare two row-string arrays. */
function textEq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((r, i) => r === b[i]);
}

/** The style fields both drivers report, so a diff names the attribute. */
const STYLE_KEYS = [
  'bold',
  'italic',
  'faint',
  'blink',
  'inverse',
  'invisible',
  'strikethrough',
  'overline',
  'underline',
  'fg',
  'bg',
];

function colorEq(a, b) {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'palette') return a.index === b.index;
  if (a.kind === 'rgb') return a.r === b.r && a.g === b.g && a.b === b.b;
  return true;
}

/** Diff cell 0's attributes, which is where every SGR case writes its 'A'. */
function styleDiff(g, x) {
  const out = [];
  if (!g || !x) return ['unreadable'];
  for (const k of STYLE_KEYS) {
    const a = g[k];
    const b = x[k];
    const same = k === 'fg' || k === 'bg' ? colorEq(a, b) : a === b;
    if (!same) out.push(`${k}: ghostty=${JSON.stringify(a)} xterm=${JSON.stringify(b)}`);
  }
  return out;
}

async function runCase(mod, c) {
  const cols = c.cols ?? DEFAULT_COLS;
  const rows = c.rows ?? DEFAULT_ROWS;

  const g = new GhosttyTerm(mod, cols, rows);
  const x = new XtermTerm(cols, rows, { layer: LAYER });
  await x.initUnicode();

  const res = { name: c.name, cat: c.cat, cols, rows };

  try {
    g.write(c.seq);
    await x.write(c.seq);

    const gText = g.gridText();
    const xText = x.gridText();
    const gCur = [g.cursorX, g.cursorY];
    const xCur = [x.cursorX, x.cursorY];

    res.ghostty = { text: gText, cursor: gCur, screen: g.activeScreen, pendingWrap: g.pendingWrap };
    res.xterm = { text: xText, cursor: xCur, screen: x.activeScreen, pendingWrap: x.pendingWrap };

    const diffs = [];
    if (!textEq(gText, xText)) {
      diffs.push({ kind: 'text', ghostty: gText, xterm: xText });
    }
    if (gCur[0] !== xCur[0] || gCur[1] !== xCur[1]) {
      diffs.push({ kind: 'cursor', ghostty: gCur, xterm: xCur });
    }
    // Compared on its own axis; see XtermTerm#cursorX for why.
    if (g.pendingWrap !== x.pendingWrap) {
      diffs.push({ kind: 'pendingWrap', ghostty: g.pendingWrap, xterm: x.pendingWrap });
    }
    if (res.ghostty.screen !== res.xterm.screen) {
      diffs.push({ kind: 'screen', ghostty: res.ghostty.screen, xterm: res.xterm.screen });
    }

    if (c.style) {
      const gr = g.readRow(0, { withStyle: true });
      const xr = x.readRow(0, { withStyle: true });
      res.ghostty.style = gr?.[0];
      res.xterm.style = xr?.[0];
      const sd = styleDiff(gr?.[0], xr?.[0]);
      if (sd.length) diffs.push({ kind: 'style', fields: sd });
    }

    // Mode flags, only where xterm exposes the mode at all. Where it does
    // not, that absence is itself recorded rather than counted as a
    // divergence: an unexposed mode may still be implemented.
    if (c.mode) {
      const [num, ansi] = c.mode;
      const gm = g.getMode(num, ansi);
      const xm = xtermMode(x, num, ansi);
      res.mode = { num, ansi, ghostty: gm, xterm: xm };
      if (xm === undefined) {
        res.modeUnexposed = true;
      } else if (gm !== xm) {
        diffs.push({ kind: 'mode', mode: num, ghostty: gm, xterm: xm });
      }
    }

    // Spec expectations, where the corpus states them.
    if (c.expect) {
      res.spec = {};
      if (c.expect.text) {
        res.spec.ghosttyText = textEq(gText, c.expect.text);
        res.spec.xtermText = textEq(xText, c.expect.text);
        res.spec.expectedText = c.expect.text;
      }
      if (c.expect.cursor) {
        const e = c.expect.cursor;
        res.spec.ghosttyCursor = gCur[0] === e[0] && gCur[1] === e[1];
        res.spec.xtermCursor = xCur[0] === e[0] && xCur[1] === e[1];
        res.spec.expectedCursor = e;
      }
    }

    res.diffs = diffs;
    // A case the harness cannot read back faithfully is reported but never
    // counted as a divergence between the emulators.
    if (c.harnessLimited) {
      res.harnessLimited = c.harnessLimited;
      res.agree = true;
    } else {
      res.agree = diffs.length === 0;
    }
  } catch (err) {
    res.error = String(err && err.stack ? err.stack : err);
    res.agree = false;
    res.diffs = [{ kind: 'error', message: String(err) }];
  } finally {
    g.free();
    x.dispose();
  }
  return res;
}

/**
 * Map a mode number onto the flag xterm.js publishes, where one exists.
 * Returns undefined when xterm exposes no flag for that mode, which is not
 * the same as the mode being unimplemented.
 */
function xtermMode(x, num, ansi) {
  const m = x.modes;
  if (ansi) {
    if (num === 4) return m.insertMode;
    if (num === 20) return undefined; // xterm.js publishes no LNM flag
    return undefined;
  }
  switch (num) {
    case 1:
      return m.applicationCursorKeysMode;
    case 6:
      return m.originMode;
    case 7:
      return m.wraparoundMode;
    case 25:
      return m.showCursor;
    case 45:
      return m.reverseWraparoundMode;
    case 1000:
      return m.mouseTrackingMode !== 'none';
    case 1002:
      return m.mouseTrackingMode === 'drag' || m.mouseTrackingMode === 'any';
    case 1003:
      return m.mouseTrackingMode === 'any';
    case 1004:
      return m.sendFocusMode;
    case 2004:
      return m.bracketedPasteMode;
    case 2026:
      return m.synchronizedOutputMode;
    default:
      return undefined;
  }
}

function fmt(v) {
  return JSON.stringify(v);
}

/** Run one query case and compare what each emulator replies up the pty. */
async function runQuery(mod, c) {
  const g = new GhosttyTerm(mod, 20, 6);
  const x = new XtermTerm(20, 6, { layer: LAYER });
  await x.initUnicode();
  const res = { name: c.name, cat: 'query' };
  try {
    g.write(c.seq);
    await x.write(c.seq);
    const gr = g.responses.join('');
    const xr = x.responses.join('');
    res.ghostty = gr;
    res.xterm = xr;

    const check = (r) => {
      if (c.expect) return c.expect.test(r);
      if (c.expectAny) return r.length > 0;
      return null; // presence not required either way
    };
    res.ghosttyOk = check(gr);
    res.xtermOk = check(xr);
    // Not scored against ghostty: the reply would come from a host callback
    // this harness does not wire. See the corpus note.
    if (c.ghosttyNeedsHostCallback) {
      res.ghosttyNeedsHostCallback = true;
      res.ghosttyOk = null;
    }
    res.agree = gr === xr;
    res.bothReplied = gr.length > 0 && xr.length > 0;
    res.neitherReplied = gr.length === 0 && xr.length === 0;
  } catch (err) {
    res.error = String(err);
  } finally {
    g.free();
    x.dispose();
  }
  return res;
}

function esc(s) {
  return JSON.stringify(s).replace(/\\u001b/g, 'ESC');
}

async function main() {
  const mod = await loadGhostty();

  let cases = CORPUS;
  if (ONLY) cases = cases.filter((c) => c.cat === ONLY);
  if (CASE) cases = cases.filter((c) => c.name === CASE);

  const results = [];
  for (const c of cases) results.push(await runCase(mod, c));

  // ------------------------------------------------------------- summary
  const byCat = new Map();
  for (const r of results) {
    if (!byCat.has(r.cat)) byCat.set(r.cat, { total: 0, agree: 0, diverge: 0 });
    const b = byCat.get(r.cat);
    b.total++;
    if (r.agree) b.agree++;
    else b.diverge++;
  }

  const spec = { ghostty: { pass: 0, fail: 0 }, xterm: { pass: 0, fail: 0 } };
  for (const r of results) {
    if (!r.spec) continue;
    for (const [impl, keys] of [
      ['ghostty', ['ghosttyText', 'ghosttyCursor']],
      ['xterm', ['xtermText', 'xtermCursor']],
    ]) {
      const vals = keys.map((k) => r.spec[k]).filter((v) => v !== undefined);
      if (!vals.length) continue;
      if (vals.every(Boolean)) spec[impl].pass++;
      else spec[impl].fail++;
    }
  }

  const diverged = results.filter((r) => !r.agree);
  const limited = results.filter((r) => r.harnessLimited);

  console.log('');
  console.log(`xterm side: ${WEBTERM ? 'webterm on @xterm/headless' : 'bare @xterm/headless'}`);
  console.log(`cases run: ${results.length}`);
  console.log(`agree:     ${results.length - diverged.length}`);
  console.log(`diverge:   ${diverged.length}`);
  console.log('');
  console.log('by category:');
  const catRows = [...byCat.entries()].sort((a, b) => b[1].diverge - a[1].diverge);
  for (const [cat, b] of catRows) {
    console.log(`  ${cat.padEnd(12)} ${String(b.total).padStart(3)} cases  ${String(b.diverge).padStart(3)} diverge`);
  }
  console.log('');
  console.log('against the spec expectations the corpus states:');
  console.log(`  ghostty-vt  pass ${spec.ghostty.pass}  fail ${spec.ghostty.fail}`);
  console.log(`  xterm.js    pass ${spec.xterm.pass}  fail ${spec.xterm.fail}`);

  if (limited.length) {
    console.log('');
    console.log(`harness-limited, excluded from the divergence count: ${limited.length}`);
    for (const r of limited) console.log(`  ${r.name} (${r.harnessLimited})`);
  }

  const unexposed = results.filter((r) => r.modeUnexposed);
  if (unexposed.length) {
    console.log('');
    console.log(`modes xterm.js exposes no flag for (not counted as divergences): ${unexposed.length}`);
    console.log(`  ${unexposed.map((r) => r.name).join(', ')}`);
  }

  if (diverged.length) {
    console.log('');
    console.log('divergences:');
    for (const r of diverged) {
      console.log(`  [${r.cat}] ${r.name}`);
      for (const d of r.diffs) {
        if (d.kind === 'text') {
          if (VERBOSE) {
            console.log(`      text ghostty=${fmt(d.ghostty)}`);
            console.log(`           xterm  =${fmt(d.xterm)}`);
          } else {
            const gi = d.ghostty.findIndex((v, i) => v !== d.xterm[i]);
            console.log(`      text row ${gi}: ghostty=${fmt(d.ghostty[gi])} xterm=${fmt(d.xterm[gi])}`);
          }
        } else if (d.kind === 'cursor') {
          console.log(`      cursor ghostty=${fmt(d.ghostty)} xterm=${fmt(d.xterm)}`);
        } else if (d.kind === 'style') {
          for (const f of d.fields) console.log(`      style ${f}`);
        } else if (d.kind === 'mode') {
          console.log(`      mode ${d.mode} ghostty=${d.ghostty} xterm=${d.xterm}`);
        } else if (d.kind === 'pendingWrap') {
          console.log(`      pendingWrap ghostty=${d.ghostty} xterm=${d.xterm}`);
        } else if (d.kind === 'screen') {
          console.log(`      screen ghostty=${d.ghostty} xterm=${d.xterm}`);
        } else if (d.kind === 'error') {
          console.log(`      error ${d.message}`);
        }
      }
      // Where the corpus states a spec expectation, say who met it.
      if (r.spec) {
        const g = [r.spec.ghosttyText, r.spec.ghosttyCursor].filter((v) => v !== undefined);
        const x = [r.spec.xtermText, r.spec.xtermCursor].filter((v) => v !== undefined);
        if (g.length && x.length) {
          const gOk = g.every(Boolean);
          const xOk = x.every(Boolean);
          const verdict = gOk && !xOk ? 'ghostty matches spec' : xOk && !gOk ? 'xterm matches spec' : gOk && xOk ? 'both match spec' : 'neither matches spec';
          console.log(`      -> ${verdict}`);
        }
      }
    }
  }
  console.log('');

  // ------------------------------------------------------------- queries
  let queryResults = [];
  if (!ONLY || ONLY === 'query') {
    let qs = QUERIES;
    if (CASE) qs = qs.filter((q) => q.name === CASE);
    for (const q of qs) queryResults.push(await runQuery(mod, q));
  }

  if (queryResults.length) {
    const gOk = queryResults.filter((r) => r.ghosttyOk === true).length;
    const xOk = queryResults.filter((r) => r.xtermOk === true).length;
    const gChecked = queryResults.filter((r) => r.ghosttyOk !== null).length;
    const xChecked = queryResults.filter((r) => r.xtermOk !== null).length;
    const hostCb = queryResults.filter((r) => r.ghosttyNeedsHostCallback).length;

    console.log('');
    console.log(`query / report sequences: ${queryResults.length}`);
    console.log(`  correct reply   ghostty ${gOk}/${gChecked}   xterm ${xOk}/${xChecked}`);
    if (hostCb) console.log(`  not scored for ghostty (host callback, see corpus): ${hostCb}`);
    // Head to head on only the cases both are scored on, which is the number
    // that can honestly be compared.
    const both = queryResults.filter((r) => r.ghosttyOk !== null && r.xtermOk !== null);
    const gBoth = both.filter((r) => r.ghosttyOk).length;
    const xBoth = both.filter((r) => r.xtermOk).length;
    console.log(`  head to head on the ${both.length} both are scored on: ghostty ${gBoth}, xterm ${xBoth}`);
    console.log(`  byte-identical replies: ${queryResults.filter((r) => r.agree).length}/${queryResults.length}`);
    console.log('');
    console.log('  per query:');
    for (const r of queryResults) {
      const mark = (ok) => (ok === true ? 'ok  ' : ok === false ? 'FAIL' : '-   ');
      console.log(`    ${r.name.padEnd(22)} ghostty ${mark(r.ghosttyOk)} ${esc(r.ghostty).padEnd(34)} xterm ${mark(r.xtermOk)} ${esc(r.xterm)}`);
    }
  }

  if (JSON_OUT) {
    writeFileSync(
      JSON_OUT,
      JSON.stringify({ results, queries: queryResults, summary: { total: results.length, diverged: diverged.length, spec } }, null, 2),
    );
    console.log(`wrote ${JSON_OUT}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
