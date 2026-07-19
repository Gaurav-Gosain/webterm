import type { BackgroundPreset, ChromeBackground } from './types.js';

/**
 * The decorative backgrounds.
 *
 * These are the zero-configuration path: the point of the chrome is that a
 * consumer who sets nothing still gets something that looks composed, so the
 * defaults have to be choices rather than a neutral grey.
 *
 * Each is a gradient rather than a flat colour because a flat field behind a
 * shadowed window reads as a mistake: the shadow has nothing to fall across.
 * The angles are all off-axis for the same reason.
 */
export const backgrounds = {
  // Deep violet into teal. The default, because it sits under both a light
  // and a dark frame without fighting either.
  aurora: 'linear-gradient(135deg, #5b2c83 0%, #3f5efb 45%, #2fa39b 100%)',
  candy: 'linear-gradient(135deg, #fbc2eb 0%, #c3a0f0 55%, #a6c1ee 100%)',
  dawn: 'linear-gradient(135deg, #ffd3a5 0%, #fd9a8f 50%, #c96ba8 100%)',
  mint: 'linear-gradient(135deg, #e8f7ef 0%, #b9e6cd 55%, #8fd3b6 100%)',
  noir: 'radial-gradient(120% 120% at 28% 0%, #2b2b31 0%, #151518 58%, #0a0a0c 100%)',
  ocean: 'linear-gradient(160deg, #0f2027 0%, #203a43 50%, #2c5364 100%)',
  slate: 'linear-gradient(150deg, #f2f5f9 0%, #dde4ee 55%, #c6d0de 100%)',
  sunset: 'linear-gradient(135deg, #ff9a6c 0%, #ff5f6d 52%, #b4418e 100%)',
  none: 'transparent',
} satisfies Record<BackgroundPreset, string>;

export const backgroundNames = Object.keys(backgrounds) as BackgroundPreset[];

function isPreset(value: string): value is BackgroundPreset {
  return Object.prototype.hasOwnProperty.call(backgrounds, value);
}

/** Resolve any of the background forms to a single CSS `background` value. */
export function resolveBackground(background: ChromeBackground | undefined): string {
  if (background === undefined) return backgrounds.aurora;

  if (typeof background === 'string') {
    // A bare string is a preset name when it names one, and otherwise a CSS
    // value, so `background: '#101014'` works without a wrapper object. An
    // empty string is neither: it paints nothing, which reads as the stage
    // having been forgotten rather than as a deliberate choice, so it falls
    // back to the default the same way undefined does. `'none'` is the way to
    // ask for no background.
    if (isPreset(background)) return backgrounds[background];
    return background.trim() === '' ? backgrounds.aurora : background;
  }

  if ('preset' in background) return backgrounds[background.preset] ?? backgrounds.aurora;
  if ('css' in background) return background.css;
  if ('gradient' in background) return background.gradient;
  if ('color' in background) return background.color;
  if ('image' in background) {
    const size = background.size ?? 'cover';
    const position = background.position ?? 'center';
    const repeat = background.repeat ?? 'no-repeat';
    return `url("${background.image}") ${position} / ${size} ${repeat}`;
  }
  return backgrounds.aurora;
}

/**
 * Layered shadows.
 *
 * One shadow cannot be right: a real window occludes ambient light close to
 * its edge and casts a wide soft shadow further out, and a single blur can
 * only be one of those. Each of these is a tight contact shadow, two mid
 * layers, and a wide diffuse layer, with alpha falling as blur grows.
 */
export const shadows = {
  none: 'none',
  small: [
    '0 1px 1px rgba(0, 0, 0, 0.04)',
    '0 2px 4px rgba(0, 0, 0, 0.05)',
    '0 6px 12px rgba(0, 0, 0, 0.08)',
  ].join(', '),
  medium: [
    '0 1px 1px rgba(0, 0, 0, 0.03)',
    '0 2px 5px rgba(0, 0, 0, 0.05)',
    '0 8px 16px rgba(0, 0, 0, 0.08)',
    '0 20px 40px rgba(0, 0, 0, 0.14)',
    '0 40px 72px rgba(0, 0, 0, 0.16)',
  ].join(', '),
  large: [
    '0 1px 2px rgba(0, 0, 0, 0.04)',
    '0 4px 8px rgba(0, 0, 0, 0.06)',
    '0 14px 28px rgba(0, 0, 0, 0.10)',
    '0 32px 64px rgba(0, 0, 0, 0.18)',
    '0 64px 120px rgba(0, 0, 0, 0.22)',
  ].join(', '),
} as const;
