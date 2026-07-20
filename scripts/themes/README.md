# themes

Generates `src/themes/data.ts`, the vendored corpus of terminal colour schemes
behind the `@gaurav-gosain/webterm/themes` entry point.

```sh
node generate.mjs           # refresh from upstream
node generate.mjs --check   # regenerate and compare, no write
```

Or `npm run themes` and `npm run themes:check` from the repository root.

The output is committed. Install and build never reach the network; this script
is the only thing here that does, and it is run by hand when the corpus is worth
refreshing. `--check` exits non-zero if the committed file no longer matches what
the current upstream would produce, which is the useful thing to run on a
schedule rather than on every build.

## Where the data comes from

[mbadolato/iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes)
is the collection every other project ends up copying from. It is read through
the flattened JSON build that [charmbracelet/vhs](https://github.com/charmbracelet/vhs)
publishes rather than from the upstream `.itermcolors` files, because those are
plists carrying floating point 0..1 components per channel across four scheme
dialects, and vhs has already done the normalisation into one hex-per-role
shape.

The corpus is MIT. The generated file opens with the full notice in a `/*!`
comment, which is the marker that makes esbuild keep it, so it survives into
`dist/themes/index.js` and travels with the copies as the licence requires. The
script refuses to run if the upstream `LICENSE` is no longer the MIT text, so a
relicence upstream stops the generator rather than being carried forward by a
script that never looked.

## Light and dark

Computed, not read. The upstream records do carry a `meta.isDark` flag, but it
is hand-maintained and a new scheme can arrive without it, as thirteen of them
arrive with no cursor colour. Names are worse than useless: `Bright Lights`,
`Thayer Bright` and `Tomorrow Night Bright` are all dark, `Tokyo Night Light`
and `Night Owlish Light` are light.

The background is gamma-decoded out of sRGB and reduced to a WCAG relative
luminance, and the cut is at 0.18, which is mid grey in linear light and the
midpoint the WCAG contrast ratio itself is built around. That threshold agrees
with every `meta.isDark` in the corpus at hand, and the nearest schemes to it are
Unikitty at 0.450 above and Grass at 0.137 below, so the margin is wide and
moving the cut anywhere in 0.15 to 0.30 reclassifies nothing.

## Ids

Lowercase and hyphenated, derived from the display name, with the display name
kept alongside for rendering. Two details are load-bearing.

Camel case is split before the case is folded, because `TokyoNight` and
`tokyonight` are two different palettes that both ship, and folding first would
collapse them into one id and drop a scheme. The split needs two lowercase
letters before the capital, or `iTerm2 Solarized Dark` becomes `i-term2-...`; a
single leading lowercase letter is a prefix on the word after it. `+` is spelled
out for the same reason, since `Dracula` and `Dracula+` are distinct schemes.

The corpus also ships some schemes twice, under a display spelling and a slug
spelling of the same name. Where the two palettes are identical one is dropped.
Where they are not, because one copy was updated upstream and the other was not,
both are kept and the second takes a numbered id, assigned in sorted name order
so the output does not move when the upstream file is reordered.

## Shape of the output

One `themeCorpus` record keyed by id, each entry holding the display name, the
computed appearance and an `ITheme`. The type is annotated as
`Record<ThemeId, ThemeEntry>` against a generated union of ids rather than
inferred through `satisfies`: both give the same key union, but inference also
carries all 22 colours of all 345 palettes into the emitted `.d.ts` as literal
types, which took that file from 9 KB to 256 KB and put the cost on every
consumer's typecheck.

Three mappings onto `ITheme` are choices rather than renames. `selection` is one
colour upstream and becomes `selectionBackground`, with `selectionForeground`
left unset so xterm keeps the cell's own foreground under a selection.
`cursorAccent`, the glyph drawn inside a block cursor, is set to the background,
because xterm otherwise defaults it to black and it disappears on a dark scheme.
The thirteen schemes with no `cursor` take the foreground, which is what a
terminal does when a scheme does not name one.
