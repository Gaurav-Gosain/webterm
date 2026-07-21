import type { ITerminalAddon, Terminal } from '@xterm/xterm';
import { installRoundedCellWidth } from './cell-metrics.js';
import type { RendererKind, RendererOptions } from './types.js';

/**
 * Probe for a real WebGL context on a throwaway canvas.
 *
 * `typeof WebGL2RenderingContext !== 'undefined'` is not the same question:
 * a browser can expose the constructor and still refuse to create a context on
 * a blocklisted driver, and the addon throws from its own constructor there.
 *
 * This cannot detect software rasterisation. Under SwiftShader the context
 * creates successfully and the WebGL renderer is slower than canvas, so a
 * consumer targeting such an environment should pin `canvas` rather than rely
 * on the probe.
 */
export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return false;
    (gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

interface ContextLossAddon extends ITerminalAddon {
  onContextLoss(handler: () => void): void;
}

/**
 * Resolves the renderer addon and installs it, falling through webgl, canvas
 * and dom in that order.
 *
 * Must run after `term.open()`, so the addons have an element to attach to.
 * The DOM renderer is xterm's own default and needs no addon, so it is the
 * terminal case of every fallback path.
 */
export class RendererManager {
  private addon?: ITerminalAddon;
  private active: RendererKind = 'dom';
  private readonly term: Terminal;
  private readonly options: Required<RendererOptions>;
  private readonly onChange: (renderer: RendererKind) => void;

  constructor(
    term: Terminal,
    options: Required<RendererOptions>,
    onChange: (renderer: RendererKind) => void,
  ) {
    this.term = term;
    this.options = options;
    this.onChange = onChange;
  }

  get current(): RendererKind {
    return this.active;
  }

  async install(): Promise<RendererKind> {
    const prefer = this.options.prefer;
    if (prefer === 'dom') return this.settle('dom');
    // vtgl is opt-in only: 'auto' never reaches it, because it drops features
    // the shipped renderers keep. When it is asked for and cannot start, fall
    // through to xterm's own webgl, then canvas, then dom.
    if (prefer === 'vtgl' && (await this.tryVtgl())) return this.active;
    if ((prefer === 'webgl' || prefer === 'auto' || prefer === 'vtgl') && (await this.tryWebgl()))
      return this.active;
    if (
      (prefer === 'canvas' || prefer === 'auto' || prefer === 'webgl' || prefer === 'vtgl') &&
      (await this.tryCanvas())
    )
      return this.active;
    return this.settle('dom');
  }

  private async tryVtgl(): Promise<boolean> {
    if (!this.term.element) return false;
    try {
      const { VtglRendererAddon } = await import('./vtgl/adapter.js');
      const vtgl = await import('vtgl');
      // The addon installs vtgl from inside activate(), which throws if neither
      // WebGL2 nor Canvas2D will start. loadAddon runs activate synchronously
      // here because the terminal is already open, so a failure surfaces as a
      // throw and the terminal keeps its DOM renderer, leaving the fallback
      // chain free to take over.
      const params = new URLSearchParams(location.search);
      // The HarfBuzz shaper rasters each glyph from its outline into a full-ink
      // tile placed at the shaper's pen with no per-cell crop, so its WebGL2
      // join has no seam; WebGL2 is therefore the default now. Canvas2D stays
      // reachable via ?vtglBackend=canvas2d for a side-by-side comparison.
      const backend = params.get('vtglBackend') === 'canvas2d' ? 'canvas2d' : 'webgl2';
      // Shaper: HarfBuzz by default (correct marks and joins, engine
      // independent). ?vtglShaper=pfb selects the zero-dependency
      // presentation-forms shaper, and =none turns shaping off, for comparison.
      const shaperMode = params.get('vtglShaper') ?? 'hb';
      let shaper;
      if (shaperMode === 'hb') {
        try {
          shaper = await vtgl.createHarfBuzzShaper();
        } catch (e) {
          console.warn('webterm: HarfBuzz shaper failed to load, using presentation forms', e);
        }
      }
      const addon = new VtglRendererAddon(
        shaper
          ? { shaper, backend }
          : { arabicShaping: shaperMode !== 'none', backend },
      );
      this.term.loadAddon(addon);
      this.addon = addon;
      this.settle('vtgl');
      return true;
    } catch (error) {
      console.warn('webterm: vtgl renderer unavailable', error);
      return false;
    }
  }

  private async tryWebgl(): Promise<boolean> {
    if (!this.term.element || !webglAvailable()) return false;
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl');
      const addon = new WebglAddon() as unknown as ContextLossAddon;
      if (this.options.fallbackOnContextLoss) {
        addon.onContextLoss(() => {
          // The context is gone, not coming back, and the addon renders
          // nothing from here on. Drop it and take the next renderer down.
          try {
            addon.dispose();
          } catch {
            // Disposal after a lost context can itself throw; the fallback
            // matters more than the cleanup.
          }
          this.addon = undefined;
          void this.tryCanvas().then((ok) => {
            if (!ok) this.settle('dom');
          });
        });
      }
      this.term.loadAddon(addon as unknown as ITerminalAddon);
      this.addon = addon as unknown as ITerminalAddon;
      installRoundedCellWidth(addon, this.term);
      this.settle('webgl');
      return true;
    } catch (error) {
      console.warn('webterm: WebGL renderer unavailable', error);
      return false;
    }
  }

  private async tryCanvas(): Promise<boolean> {
    if (!this.term.element) return false;
    try {
      const { CanvasAddon } = await import('@xterm/addon-canvas');
      const addon = new CanvasAddon();
      this.term.loadAddon(addon);
      this.addon = addon;
      installRoundedCellWidth(addon, this.term);
      this.settle('canvas');
      return true;
    } catch (error) {
      console.warn('webterm: canvas renderer unavailable', error);
      return false;
    }
  }

  private settle(renderer: RendererKind): RendererKind {
    const changed = this.active !== renderer;
    this.active = renderer;
    if (changed) this.onChange(renderer);
    return renderer;
  }

  dispose(): void {
    try {
      this.addon?.dispose();
    } catch {
      // A renderer addon can throw on disposal after a context loss.
    }
    this.addon = undefined;
  }
}
