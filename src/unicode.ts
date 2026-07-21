/**
 * Unicode width overrides layered on top of a delegate provider.
 *
 * @xterm/addon-unicode-graphemes supplies the UAX 29 segmentation this package
 * depends on, and it is right about nearly everything. Where it is not, this
 * registers a provider that delegates every call to the addon's own provider
 * and rewrites the result for a short list of codepoints, measured against
 * ghostty-vt with mode 2027 grapheme clustering. It reuses the delegate's
 * version string, so it simply replaces the addon in the UnicodeService
 * registry and nothing that reads `terminal.unicode.activeVersion` has to know
 * it exists.
 *
 * WHAT IS OVERRIDDEN, and why the addon is a column out on each:
 *
 *   U+200B ZERO WIDTH SPACE to 0. The addon bills it one column; every other
 *     emulator worth comparing against, ghostty-vt and wcwidth included, gives
 *     it zero. Unlike the rest this one shows up in ordinary text: ZWSP is the
 *     standard line-break opportunity marker, so a paragraph carrying a few of
 *     them drifts a column right for each one.
 *   U+1F1E6 through U+1F1FF, the regional indicators, to 2. A pair forms a flag
 *     and the addon already gives the pair its two columns, but a lone
 *     indicator, the odd one left when a run has an odd length, it bills one.
 *     ghostty gives every indicator two, paired or not. The override is a
 *     no-op on the paired case: the second indicator keeps the delegate's join
 *     and so still advances nothing, and the pair stays two columns.
 *   U+093F DEVANAGARI VOWEL SIGN I to 2. It is a spacing matra: it renders in
 *     its own column to the left of its consonant, and ghostty counts the
 *     consonant-plus-matra cluster as two. The addon clusters the two but bills
 *     the matra zero, leaving the cluster one column. The matra keeps the
 *     delegate's join, so the 2 restates the cluster's width rather than adding
 *     a separate cell. Only this matra is measured against the reference and so
 *     only this one is shipped; the other spacing vowel signs are the same
 *     question and would take the same entry once measured.
 *
 * WHAT IS RESEGMENTED (not a width entry, a join-gate on the segmenter):
 *
 *   U+1F3FB through U+1F3FF, the emoji modifiers (Fitzpatrick skin tones), when
 *     they do NOT follow an emoji base. This is not a per-codepoint width entry;
 *     it is a targeted correction to one segmentation decision, so it lives in
 *     the provider rather than in DEFAULT_OVERRIDES. A modifier is
 *     Emoji_Presentation=Yes and renders as a wide colour swatch, so ghostty and
 *     the corpus give it two columns. The addon already widths it two, and after
 *     a real emoji base (U+1F44D THUMBS UP, U+261D INDEX POINTING UP, any
 *     Extended_Pictographic) it correctly folds the modifier into a single
 *     two-column cluster: that case is left completely alone. The defect is
 *     UAX #29 GB9, "do not break before Extend": a lone modifier after a
 *     NON-base character, such as the `[` a reproducer wraps it in, is a grapheme
 *     Extend, so the addon joins it onto that character and widens it in place
 *     instead of standing the modifier up as its own two-column swatch. That
 *     costs the sequence a column. UTS #51's emoji model is the authority for
 *     display here and it disagrees with a blind GB9: an emoji modifier forms an
 *     emoji_modifier_sequence only with an emoji_modifier_base, and a modifier
 *     with no base is shown as the standalone swatch. So when the preceding
 *     cell's grapheme kind is not Extended_Pictographic, the provider re-asks the
 *     delegate as if the modifier were at the start of the line, which yields its
 *     own width-2, non-joining cluster. Extended_Pictographic is used as the gate
 *     because it is the only base signal the addon's packed property carries; it
 *     is a safe superset of Emoji_Modifier_Base (every modifier base is
 *     Extended_Pictographic), so no real base+modifier sequence is split. A
 *     modifier following an Extended_Pictographic that is not itself a modifier
 *     base is the only theoretical gap, and it does not occur in real text.
 *
 * WHAT IS DELIBERATELY NOT OVERRIDDEN BY DEFAULT, so nobody "fixes" it later:
 *
 *   U+00AD SOFT HYPHEN. xterm gives it 0, ghostty 1. This is a deliberate,
 *     documented divergence and ghostty is the opinionated one here, so it is
 *     left exactly as xterm has it and must not be "corrected" to match the
 *     reference. U+00AD is General_Category Cf (Format): a conditional
 *     line-break/hyphenation hint that a text engine renders only when a line
 *     actually breaks on it. A terminal never hyphenates, so a soft hyphen has
 *     no visible role and correctly contributes zero width, which is what
 *     wcwidth and xterm both do. Ghostty's choice to draw it as a visible
 *     width-1 glyph is the less-correct one: making it visible here would put a
 *     stray hyphen-width column into every ordinary word that merely carries a
 *     soft-hyphen break hint, a real-text regression. It could not be changed
 *     from this layer anyway: InputHandler.print() drops codepoint 173 with an
 *     early `continue` before it ever asks a provider for a width. Both facts
 *     point the same way, so the reference expectation is intentionally not met.
 *   U+200C ZERO WIDTH NON-JOINER and U+FEFF ZERO WIDTH NO-BREAK SPACE. Both
 *     already measure zero inside real text. Overriding them would be a no-op
 *     at best.
 *   U+200D ZERO WIDTH JOINER. Forcing its width to zero would break emoji ZWJ
 *     sequences outright: the addon returns the joined cluster's accumulated
 *     width through the ZWJ's own property value, and InputHandler feeds that
 *     value back as the preceding join state for the next scalar. Zero it and
 *     a family emoji re-advances at every joiner. Its only failing case is a
 *     lone ZWJ at column 0, which no width table can fix (see below).
 *   The Cf general category as a whole. Too blunt: it contains U+00AD and
 *     U+200D above, plus the Arabic number formatters, which are not the same
 *     question.
 *
 * A lone zero-width codepoint written at column 0 still advances one column.
 * That is not a width decision: with no preceding cell to join onto,
 * InputHandler has nowhere to put the codepoint and writes it into a cell of
 * its own. xterm does the same for a lone combining mark. Between any two
 * characters, which is where ZWSP actually occurs, the override applies.
 */
import type { Terminal } from '@xterm/xterm';

/**
 * The shipped default. Every entry needs a reason in the block above.
 *
 * The regional indicators are filled as a range rather than listed one at a
 * time: an indicator is any of U+1F1E6 through U+1F1FF, so the fix has to cover
 * the whole range or it only moves the misalignment to a flag the corpus does
 * not name.
 */
function buildDefaults(): Record<number, 0 | 1 | 2> {
  const map: Record<number, 0 | 1 | 2> = { 0x200b: 0 };
  for (let cp = 0x1f1e6; cp <= 0x1f1ff; cp++) map[cp] = 2;
  map[0x093f] = 2;
  return map;
}

export const DEFAULT_OVERRIDES: Record<number, 0 | 1 | 2> = buildDefaults();

/**
 * UnicodeService packs a property value as
 *   (charKind << 3) | (width << 1) | shouldJoin
 * with width in two bits.
 */
const CHAR_KIND_SHIFT = 3;

/**
 * The grapheme-break kind lives in the low nibble of the charKind field. The
 * addon's own third-party tables use the same encoding; these mirror the two
 * values the modifier join-gate needs so it does not have to import from the
 * addon's private `third-party` module.
 */
const GRAPHEME_BREAK_MASK = 0xf;
const GRAPHEME_BREAK_EXT_PIC = 11;

/** The Fitzpatrick emoji modifiers, U+1F3FB through U+1F3FF. */
const EMOJI_MODIFIER_LO = 0x1f3fb;
const EMOJI_MODIFIER_HI = 0x1f3ff;

export function packCharProperties(charKind: number, width: number, shouldJoin: boolean): number {
  return ((charKind & 0xffffff) << CHAR_KIND_SHIFT) | ((width & 3) << 1) | (shouldJoin ? 1 : 0);
}

export function unpackCharProperties(value: number): {
  charKind: number;
  width: number;
  shouldJoin: boolean;
} {
  return {
    charKind: value >> CHAR_KIND_SHIFT,
    width: (value >> 1) & 3,
    shouldJoin: (value & 1) === 1,
  };
}

/** The shape xterm's proposed unicode provider API requires. */
export interface UnicodeProvider {
  readonly version: string;
  ambiguousCharsAreWide: boolean;
  charProperties(codepoint: number, preceding: number): number;
  wcwidth(codepoint: number): number;
}

/**
 * Delegates to another provider and rewrites the packed property value for a
 * fixed set of codepoints. The delegate's charKind is preserved so the addon's
 * segmentation state machine keeps working across the override.
 */
export class OverrideProvider implements UnicodeProvider {
  readonly version: string;
  private readonly delegate: UnicodeProvider;
  private readonly overrides: Record<number, 0 | 1 | 2>;

  constructor(delegate: UnicodeProvider, overrides: Record<number, 0 | 1 | 2>) {
    this.delegate = delegate;
    this.overrides = overrides;
    this.version = delegate.version;
  }

  get ambiguousCharsAreWide(): boolean {
    return this.delegate.ambiguousCharsAreWide;
  }

  set ambiguousCharsAreWide(value: boolean) {
    this.delegate.ambiguousCharsAreWide = value;
  }

  /**
   * The preceding-state the delegate should segment against. Normally this is
   * exactly what InputHandler passed. The one exception is a Fitzpatrick emoji
   * modifier standing on a character that is not an emoji base: UAX #29 GB9
   * would join it onto that character and absorb its width, but UTS #51 shows a
   * base-less modifier as a standalone swatch, so it is segmented as if it began
   * the line, which yields its own width-2, non-joining cluster. A modifier
   * after an Extended_Pictographic base is left to join exactly as before, so no
   * real skin-toned emoji is split. See the header block for the full argument.
   */
  private precedingFor(codepoint: number, preceding: number): number {
    if (
      codepoint >= EMOJI_MODIFIER_LO &&
      codepoint <= EMOJI_MODIFIER_HI &&
      preceding !== 0 &&
      ((preceding >> CHAR_KIND_SHIFT) & GRAPHEME_BREAK_MASK) !== GRAPHEME_BREAK_EXT_PIC
    ) {
      return 0;
    }
    return preceding;
  }

  charProperties(codepoint: number, preceding: number): number {
    const value = this.delegate.charProperties(codepoint, this.precedingFor(codepoint, preceding));
    const override = this.overrides[codepoint];
    if (override === undefined) return value;
    // A width of 0 is joined onto whatever precedes it. The join is what
    // actually suppresses the advance: InputHandler only skips the cursor
    // increment on the joining branch, so a width of 0 without it would still
    // eat a column. This mirrors what xterm's own UnicodeV6 provider does for
    // every zero-width scalar.
    //
    // A non-zero override keeps the delegate's own join bit rather than
    // clearing it. The addon sets that bit on the scalars it clusters, and
    // InputHandler reads the width of a joining scalar back as the cluster's
    // running width: for a joining scalar the override therefore restates what
    // the whole cluster is worth, not what the scalar is worth on its own, and
    // clearing the join here would split the cluster instead of rewidthing it.
    // A regional indicator ending a pair, or a Devanagari matra after its
    // consonant, is a joining scalar whose delegate width is one column short.
    // A non-zero override on a non-joining scalar, a lone regional indicator
    // with nothing to pair with, just replaces its width.
    const { shouldJoin: delegateJoin } = unpackCharProperties(value);
    const shouldJoin = override === 0 ? preceding !== 0 : delegateJoin;
    return packCharProperties(value >> CHAR_KIND_SHIFT, override, shouldJoin);
  }

  wcwidth(codepoint: number): number {
    const override = this.overrides[codepoint];
    return override === undefined ? this.delegate.wcwidth(codepoint) : override;
  }
}

interface UnicodeRegistry {
  register(provider: UnicodeProvider): void;
  activeVersion: string;
  versions: string[];
}

/**
 * Load a unicode addon into `term` and layer `overrides` on top of whatever
 * provider it registers. Returns the active version, or undefined when no
 * provider was captured and the addon was left to stand on its own.
 *
 * The addon's provider instance is captured as it registers itself, which
 * avoids reaching into the addon's private fields. The interception has to go
 * on the prototype, not on an instance: `Terminal.unicode` is a getter that
 * hands back a freshly constructed UnicodeApi on every access, so the object
 * the addon registers through is never the one read afterwards.
 */
export function installUnicodeOverrides(
  term: Terminal,
  addon: { activate(terminal: Terminal): void; dispose(): void },
  overrides: Record<number, 0 | 1 | 2>,
): string | undefined {
  const unicodeApi = term.unicode as unknown as UnicodeRegistry;
  const proto = Object.getPrototypeOf(unicodeApi) as UnicodeRegistry;
  const register = proto.register;
  let delegate: UnicodeProvider | undefined;

  proto.register = function (provider: UnicodeProvider) {
    // The last provider the addon registers is its own; capture it whatever it
    // calls itself, so a version-string change upstream does not silently turn
    // the overrides off.
    if (provider && typeof provider.charProperties === 'function') delegate = provider;
    return register.call(this, provider);
  };
  try {
    term.loadAddon(addon as never);
  } finally {
    proto.register = register;
  }

  if (!delegate) return undefined;
  const version = delegate.version;
  const unicode = term.unicode as unknown as UnicodeRegistry;
  if (Object.keys(overrides).length > 0) {
    // Same version string, so this displaces the addon in the registry.
    unicode.register(new OverrideProvider(delegate, overrides));
  }
  // activeVersion has to be assigned afterwards either way: the setter is what
  // resolves the string back to a provider instance.
  unicode.activeVersion = version;
  return version;
}
