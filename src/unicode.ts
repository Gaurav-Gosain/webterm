/**
 * Unicode width overrides layered on top of a delegate provider.
 *
 * @xterm/addon-unicode-graphemes supplies the UAX 29 segmentation this package
 * depends on, and it is right about nearly everything. It is wrong about
 * U+200B ZERO WIDTH SPACE, which it bills one column. Every other emulator
 * worth comparing against, ghostty-vt and wcwidth included, gives it zero, and
 * unlike the other disagreements this one shows up in ordinary text: ZWSP is
 * the standard line-break opportunity marker, so a paragraph carrying a few of
 * them drifts a column right for each one.
 *
 * Rather than patch the addon, this registers a provider that delegates every
 * call to the addon's own provider and rewrites the result for a short list of
 * codepoints. It reuses the delegate's version string, so it simply replaces
 * the addon in the UnicodeService registry and nothing that reads
 * `terminal.unicode.activeVersion` has to know it exists.
 *
 * WHAT IS DELIBERATELY NOT OVERRIDDEN BY DEFAULT, so nobody "fixes" it later:
 *
 *   U+00AD SOFT HYPHEN. xterm gives 0, ghostty 1. Accepted policy difference.
 *     It could not be changed here anyway: InputHandler.print() drops
 *     codepoint 173 before it ever asks a provider for its width.
 *   Devanagari matra (U+0928 U+093F). xterm gives the cluster 1 column,
 *     ghostty 2. Accepted policy difference; a spacing-mark question, not a
 *     zero-width one, and not reachable from a per-codepoint width table.
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

/** The shipped default. Every entry needs a reason in the block above. */
export const DEFAULT_OVERRIDES: Record<number, 0 | 1 | 2> = { 0x200b: 0 };

/**
 * UnicodeService packs a property value as
 *   (charKind << 3) | (width << 1) | shouldJoin
 * with width in two bits.
 */
const CHAR_KIND_SHIFT = 3;

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

  charProperties(codepoint: number, preceding: number): number {
    const value = this.delegate.charProperties(codepoint, preceding);
    const override = this.overrides[codepoint];
    if (override === undefined) return value;
    // A width of 0 is joined onto whatever precedes it. The join is what
    // actually suppresses the advance: InputHandler only skips the cursor
    // increment on the joining branch, so a width of 0 without it would still
    // eat a column. This mirrors what xterm's own UnicodeV6 provider does for
    // every zero-width scalar. A non-zero override is not a join.
    const shouldJoin = override === 0 && preceding !== 0;
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
