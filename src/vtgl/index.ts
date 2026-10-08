// The vtgl renderer as its own entry, `@gaurav-gosain/webterm/vtgl`.
//
// It used to be reached through `import('vtgl')` inside the core, and the
// standalone IIFE inlines every dynamic import, so every page that loaded the
// standalone carried vtgl, the HarfBuzz wasm and the Noto Sans Arabic font:
// about 915 KB that the default renderer never runs. Now the core knows only
// the VtglProvider interface, and a page that wants vtgl hands it in:
//
//   import { vtgl } from '@gaurav-gosain/webterm/vtgl';
//   new WebTerm({ renderer: { prefer: 'vtgl', vtgl: vtgl() } });
//
// A script-tag page loads webterm-vtgl.standalone.global.js after the core
// standalone and passes `WebTermVtgl.vtgl()` the same way.

import { arabicShaper, createHarfBuzzShaper, type ShaperHook } from '@gaurav-gosain/vtgl';

import type { VtglProvider } from '../types.js';
import { VtglRendererAddon, type VtglAddonOptions } from './adapter.js';

export interface VtglOptions {
  /**
   * The drawing backend. Default 'webgl2'. The HarfBuzz shaper rasters each
   * glyph from its outline into a full-ink tile with no per-cell crop, so its
   * WebGL2 join has no seam. 'canvas2d' stays for a side-by-side comparison.
   */
  backend?: 'webgl2' | 'canvas2d';
  /**
   * The Arabic shaper. Default 'harfbuzz': correct marks and joins, and the
   * same on every engine. 'forms' is the presentation-forms shaper, which has
   * no wasm and no font to load. 'none' turns shaping off.
   */
  shaper?: 'harfbuzz' | 'forms' | 'none';
}

/** The provider `renderer.vtgl` takes. */
export function vtgl(options: VtglOptions = {}): VtglProvider {
  const backend = options.backend ?? 'webgl2';
  const mode = options.shaper ?? 'harfbuzz';
  return {
    async createAddon() {
      let shaper: ShaperHook | undefined;
      if (mode === 'harfbuzz') {
        try {
          shaper = await createHarfBuzzShaper();
        } catch (error) {
          console.warn('webterm: HarfBuzz shaper failed to load, using presentation forms', error);
          shaper = arabicShaper();
        }
      } else if (mode === 'forms') {
        shaper = arabicShaper();
      }
      return new VtglRendererAddon(shaper ? { shaper, backend } : { arabicShaping: false, backend });
    },
  };
}

export { VtglRendererAddon, type VtglAddonOptions };
export type { VtglProvider };
