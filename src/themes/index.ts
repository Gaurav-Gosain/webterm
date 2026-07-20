import type { ITheme } from '@xterm/xterm';
import { themeCorpus, type ThemeId } from './data.js';
import type { ThemeEntry, ThemeMetadata } from './types.js';

export { themeCorpus };
export type { ThemeId };
export type { ThemeAppearance, ThemeEntry, ThemeMetadata } from './types.js';

/**
 * `ThemeId` where the completion list matters, any string where it does not.
 *
 * The intersection with `Record<never, never>` is what stops TypeScript from
 * widening the union away: without it the whole type collapses to `string` and
 * the completions disappear. Ids read out of a config file or a URL are not
 * literals, and rejecting them would push every caller through a cast.
 */
export type ThemeIdInput = ThemeId | (string & Record<never, never>);

/** The full entry, palette and appearance, or undefined for an unknown id. */
export function getThemeEntry(id: ThemeIdInput): ThemeEntry | undefined {
  // Indexed off a null-prototype-free object literal, so an id of `toString` or
  // `constructor` would otherwise return a function. The own-property check is
  // what keeps a user-supplied id from reaching Object.prototype.
  return Object.hasOwn(themeCorpus, id)
    ? (themeCorpus as Record<string, ThemeEntry>)[id]
    : undefined;
}

/**
 * The palette alone, ready for `new WebTerm({ theme })` or `term.setTheme()`.
 */
export function getTheme(id: ThemeIdInput): ITheme | undefined {
  return getThemeEntry(id)?.theme;
}

let cachedList: readonly ThemeMetadata[] | undefined;

/**
 * Id, name and appearance for every scheme, sorted by id.
 *
 * Built on first call rather than at module scope so importing the corpus to
 * look up one theme does not walk all of it, and cached afterwards because a
 * picker asks for this on every render. The array is the same object each time,
 * which is what makes it safe as a dependency in a memo or an effect.
 */
export function listThemes(): readonly ThemeMetadata[] {
  cachedList ??= Object.entries(themeCorpus).map(([id, entry]) => ({
    id,
    name: entry.name,
    appearance: entry.appearance,
  }));
  return cachedList;
}
