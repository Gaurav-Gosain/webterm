/** The namespace every name the touch layer emits starts with, unless the caller picks one. */
export const DEFAULT_NAMESPACE = 'webterm';

const NAMESPACE_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Check a namespace before it goes into an id, a class, a selector and a
 * storage key. A namespace that is not a plain CSS identifier would produce
 * styles that match nothing, which fails silently, so it throws instead.
 */
export function checkNamespace(ns: string | undefined): string {
  if (ns === undefined) return DEFAULT_NAMESPACE;
  if (typeof ns !== 'string' || !NAMESPACE_RE.test(ns)) {
    throw new TypeError(`webterm/mobile: namespace must be a CSS identifier, got ${JSON.stringify(ns)}`);
  }
  return ns;
}

/** Touch device, or an explicit ?mobile=1 / ?mobile=0 override for testing. */
export function detectTouch(): boolean {
  try {
    const forced = new URLSearchParams(location.search).get('mobile');
    if (forced === '1') return true;
    if (forced === '0') return false;
  } catch {
    /* no location */
  }
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const touch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
  return !!(coarse && touch);
}

/**
 * The font size to start at.
 *
 * On a phone the choice is between columns and legibility and there is no
 * setting that wins both. This keeps the configured default everywhere
 * except a narrow touch viewport, where it steps down by a point so the
 * program gets a few more columns without the text becoming a texture. It
 * is skipped once the user has picked a size of their own.
 */
export function pickFontSize(defaultPx: number, userChose?: boolean): number {
  if (userChose || !detectTouch()) return defaultPx;
  const w = Math.min(window.innerWidth || 0, window.innerHeight || 0);
  if (!w || w >= 600) return defaultPx; // tablet: the desktop size fits
  return Math.min(defaultPx, 13);
}
