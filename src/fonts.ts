import type { FontSpec } from './types.js';

export const DEFAULT_FONT_FAMILY =
  "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, Monaco, 'Cascadia Mono', monospace";

/** The first family named in a CSS font stack, unquoted. */
export function firstFamily(fontFamily: string): string {
  const first = fontFamily.split(',')[0]?.trim() ?? '';
  return first.replace(/^['"]|['"]$/g, '');
}

/**
 * Load every face through the FontFace API and await it.
 *
 * This has to complete before `new Terminal`: constructing first makes xterm
 * measure the fallback face and cache the wrong cell box, and canvas2d will not
 * synthesize a bold or italic from a partial font set. A failure is warned
 * about rather than thrown, because a missing face should degrade to the
 * fallback stack rather than leave the consumer with no terminal.
 */
export async function loadFonts(fonts: FontSpec[], fontFamily: string): Promise<void> {
  if (!fonts.length || typeof FontFace === 'undefined' || !document.fonts) return;
  const family = firstFamily(fontFamily);

  try {
    const loaded = await Promise.all(
      fonts.map((spec) =>
        new FontFace(spec.family ?? family, spec.source, {
          weight: spec.weight ?? '400',
          style: spec.style ?? 'normal',
        }).load(),
      ),
    );
    for (const face of loaded) document.fonts.add(face);
    await document.fonts.ready;
  } catch (error) {
    console.warn('webterm: font loading failed, falling back to the CSS stack', error);
  }
}
