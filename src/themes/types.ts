import type { ITheme } from '@xterm/xterm';

/**
 * Whether a scheme is meant to be read as dark text on light or the reverse.
 *
 * Computed from the background colour rather than taken from the scheme's name,
 * because names lie: `Ocean` is dark and `Belafonte Night` is light.
 */
export type ThemeAppearance = 'light' | 'dark';

/**
 * One entry in the corpus. The palette is a plain `ITheme`, so it can be handed
 * to `new WebTerm({ theme })` or `term.setTheme()` with nothing in between.
 */
export interface ThemeEntry {
  /** The scheme's name as the upstream corpus spells it, for display. */
  name: string;
  appearance: ThemeAppearance;
  theme: ITheme;
}

/**
 * An entry with its id folded in, which is the shape a picker wants: enough to
 * render and group a list without holding onto a palette per row.
 */
export interface ThemeMetadata {
  id: string;
  name: string;
  appearance: ThemeAppearance;
}
