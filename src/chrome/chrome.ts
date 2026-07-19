import { Emitter } from '../emitter.js';
import { CSS_PREFIX } from '../name.js';
import { resolveBackground, shadows } from './presets.js';
import type {
  ChromeTab,
  TabOptions,
  TrafficLightOptions,
  WindowChromeEvents,
  WindowChromeOptions,
} from './types.js';

const BASE = `${CSS_PREFIX}-chrome`;

const LIGHTS = ['close', 'minimize', 'maximize'] as const;
type LightKind = (typeof LIGHTS)[number];

const DEFAULT_LABELS: Record<LightKind, string> = {
  close: 'Close',
  minimize: 'Minimize',
  maximize: 'Maximize',
};

/**
 * The glyphs macOS reveals inside the lights on hover. Drawn as strokes on a
 * 12 unit viewBox so they stay centred and crisp at any light size and any
 * device pixel ratio.
 */
const GLYPHS: Record<LightKind, string> = {
  close: '<path d="M4.2 4.2 L7.8 7.8 M7.8 4.2 L4.2 7.8"/>',
  minimize: '<path d="M3.9 6 H8.1"/>',
  maximize: '<path d="M4.4 7.6 V4.4 H7.6 M7.6 4.4 L4.4 7.6"/>',
};

function px(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? `${value}px` : value;
}

function normalizeLights(option: WindowChromeOptions['lights']): Required<TrafficLightOptions> {
  const base = { show: true, interactive: false, labels: DEFAULT_LABELS };
  if (option === undefined) return base;
  if (typeof option === 'boolean') return { ...base, show: option };
  return {
    show: option.show ?? true,
    interactive: option.interactive ?? false,
    labels: { ...DEFAULT_LABELS, ...option.labels },
  };
}

function normalizeTabs(option: WindowChromeOptions['tabs']): TabOptions | undefined {
  if (!option) return undefined;
  const options = Array.isArray(option) ? { items: option } : option;
  if (!options.items.length) return undefined;
  return options;
}

function resolveShadow(option: WindowChromeOptions['shadow']): string {
  if (option === undefined) return shadows.medium;
  if (option === false) return shadows.none;
  if (option === true) return shadows.medium;
  if (typeof option === 'string') return shadows[option] ?? shadows.medium;
  if (option.css) return option.css;
  return shadows[option.size ?? 'medium'] ?? shadows.medium;
}

/**
 * A macOS-style window frame around a content slot.
 *
 * The frame knows nothing about what goes inside it. `content` is an empty
 * element; a consumer opens a terminal into it, or appends a code block, or
 * leaves it empty and uses the frame as a decorative shell. That is what keeps
 * the terminal core free of any dependency on this module, and the reason this
 * file imports only the emitter and the package name from the rest of the
 * source tree.
 */
export class WindowChrome {
  readonly element: HTMLElement;
  readonly window: HTMLElement;
  /** The slot. Mount a terminal, or anything else, into this. */
  readonly content: HTMLElement;
  /** The padded box the slot sits in. Carries the content background. */
  private readonly contentBox: HTMLElement;

  private options: WindowChromeOptions;
  private readonly emitter = new Emitter<WindowChromeEvents>();
  private readonly teardown: Array<() => void> = [];

  private titlebar?: HTMLElement;
  private titleNode?: HTMLElement;
  private tabList?: HTMLElement;
  private tabNodes: HTMLElement[] = [];
  private tabs?: TabOptions;
  private activeId?: string;
  private focused = true;
  private disposed = false;

  constructor(options: WindowChromeOptions = {}) {
    this.options = { ...options };

    const doc = document;
    this.element = doc.createElement('div');
    this.window = doc.createElement('div');
    this.window.className = `${BASE}-window`;
    this.contentBox = doc.createElement('div');
    this.contentBox.className = `${BASE}-content`;
    this.content = doc.createElement('div');
    this.content.className = `${BASE}-slot`;
    this.contentBox.appendChild(this.content);

    this.element.appendChild(this.window);
    this.render();
  }

  // --- Rendering ------------------------------------------------------------

  private render(): void {
    const o = this.options;

    this.element.className = [BASE, o.className].filter(Boolean).join(' ');
    // Absent for 'auto', so the prefers-color-scheme rule can select on its
    // absence rather than needing to lose a specificity race.
    if (o.appearance && o.appearance !== 'auto') {
      this.element.dataset.appearance = o.appearance;
    } else {
      delete this.element.dataset.appearance;
    }
    this.element.dataset.style = o.style ?? 'macos';
    this.element.dataset.titleAlign = o.titleAlign ?? 'center';
    this.element.dataset.focused = String(this.focused);

    this.applyVars();

    // Rebuild the chrome above the slot. The content element itself is never
    // recreated, so an update() does not destroy a terminal living inside it.
    for (const node of [...this.window.children]) {
      if (node !== this.contentBox) node.remove();
    }
    this.tabNodes = [];
    this.titlebar = undefined;
    this.titleNode = undefined;
    this.tabList = undefined;

    if (o.titleBar !== false) this.window.appendChild(this.buildTitleBar());

    this.tabs = normalizeTabs(o.tabs);
    if (this.tabs) {
      this.activeId = this.tabs.activeId ?? this.activeId ?? this.tabs.items[0]?.id;
      this.window.appendChild(this.buildTabs(this.tabs));
    }

    // appendChild moves an existing child rather than copying it, so the slot
    // ends up last without ever being detached.
    this.window.appendChild(this.contentBox);
  }

  private applyVars(): void {
    const o = this.options;
    const style = this.element.style;
    const set = (name: string, value: string | undefined) => {
      if (value === undefined) style.removeProperty(`--${BASE}-${name}`);
      else style.setProperty(`--${BASE}-${name}`, value);
    };

    set('background', resolveBackground(o.background));
    set('shadow', resolveShadow(o.shadow));
    set('radius', px(o.radius));
    set('padding', px(o.padding));
    set('titlebar-height', px(o.titleBarHeight));
    set('content-bg', o.contentBackground);
    set('content-padding', px(o.contentPadding));
    set('font', o.fontFamily);

    // The window sizing lives on the window, not on a custom property, because
    // it is layout rather than theme.
    const w = this.window.style;
    w.width = px(o.width) ?? '100%';
    w.height = px(o.height) ?? '100%';
    w.maxWidth = px(o.maxWidth) ?? '';

    for (const [name, value] of Object.entries(o.vars ?? {})) {
      style.setProperty(name.startsWith('--') ? name : `--${name}`, value);
    }
  }

  private buildTitleBar(): HTMLElement {
    const o = this.options;
    const bar = document.createElement('div');
    bar.className = `${BASE}-titlebar`;
    this.titlebar = bar;

    const lights = normalizeLights(o.lights);
    bar.appendChild(lights.show ? this.buildLights(lights) : this.buildMirror());

    const title = document.createElement('div');
    title.className = `${BASE}-title`;
    title.textContent = o.title ?? '';
    this.titleNode = title;
    bar.appendChild(title);

    // Mirrors the lights' width so a centred title is centred on the window.
    bar.appendChild(this.buildMirror());
    return bar;
  }

  private buildMirror(): HTMLElement {
    const mirror = document.createElement('div');
    mirror.className = `${BASE}-titlebar-mirror`;
    mirror.setAttribute('aria-hidden', 'true');
    return mirror;
  }

  private buildLights(options: Required<TrafficLightOptions>): HTMLElement {
    const group = document.createElement('div');
    group.className = `${BASE}-lights`;
    // Decorative lights are not controls, so they stay out of the
    // accessibility tree entirely rather than being announced as something a
    // screen reader user can act on and then doing nothing.
    if (!options.interactive) group.setAttribute('aria-hidden', 'true');

    for (const kind of LIGHTS) {
      const node = document.createElement(options.interactive ? 'button' : 'span');
      node.className = `${BASE}-light`;
      node.dataset.light = kind;

      if (options.interactive && node instanceof HTMLButtonElement) {
        node.type = 'button';
        node.setAttribute('aria-label', options.labels[kind] ?? DEFAULT_LABELS[kind]);
        node.innerHTML =
          `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" ` +
          `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPHS[kind]}</svg>`;
        const onClick = () => this.emitter.emit(kind);
        node.addEventListener('click', onClick);
        this.teardown.push(() => node.removeEventListener('click', onClick));
      }

      group.appendChild(node);
    }
    return group;
  }

  private buildTabs(tabs: TabOptions): HTMLElement {
    const interactive = tabs.interactive ?? false;
    const list = document.createElement('div');
    list.className = `${BASE}-tabs`;
    this.tabList = list;

    if (interactive) list.setAttribute('role', 'tablist');
    else list.setAttribute('aria-hidden', 'true');

    for (const tab of tabs.items) {
      const node = document.createElement(interactive ? 'button' : 'div');
      node.className = `${BASE}-tab`;
      node.dataset.tabId = tab.id;
      node.textContent = tab.title;
      const active = tab.id === this.activeId;
      node.dataset.active = String(active);

      if (interactive && node instanceof HTMLButtonElement) {
        node.type = 'button';
        node.setAttribute('role', 'tab');
        node.setAttribute('aria-selected', String(active));
        // Roving tabindex: one stop for the whole list, arrows move within it.
        node.tabIndex = active ? 0 : -1;
        const onClick = () => this.selectTab(tab.id);
        const onKeyDown = (event: KeyboardEvent) => this.onTabKeyDown(event);
        node.addEventListener('click', onClick);
        node.addEventListener('keydown', onKeyDown);
        this.teardown.push(() => {
          node.removeEventListener('click', onClick);
          node.removeEventListener('keydown', onKeyDown);
        });
      }

      this.tabNodes.push(node);
      list.appendChild(node);
    }
    return list;
  }

  private onTabKeyDown(event: KeyboardEvent): void {
    const nodes = this.tabNodes;
    const index = nodes.indexOf(event.currentTarget as HTMLElement);
    if (index < 0) return;

    let next = index;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + nodes.length) % nodes.length;
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % nodes.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = nodes.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const node = nodes[next];
    if (!node) return;
    // Follows focus, which is the expected behaviour for a tab list whose
    // panels are already present.
    node.focus();
    const id = node.dataset.tabId;
    if (id) this.selectTab(id);
  }

  // --- Public API -----------------------------------------------------------

  /** Append the chrome to a parent element. */
  mount(parent: HTMLElement): this {
    parent.appendChild(this.element);
    return this;
  }

  /** Replace the title bar text. */
  setTitle(title?: string): this {
    this.options.title = title;
    if (this.titleNode) this.titleNode.textContent = title ?? '';
    return this;
  }

  /** Replace the tab strip. */
  setTabs(tabs: ChromeTab[] | TabOptions | undefined, activeId?: string): this {
    this.options.tabs = tabs;
    if (activeId !== undefined) this.activeId = activeId;
    this.render();
    return this;
  }

  /** Select a tab by id, emitting `tabchange` if it changed. */
  selectTab(id: string): this {
    if (this.activeId === id) return this;
    const tab = this.tabs?.items.find((item) => item.id === id);
    if (!tab) return this;
    this.activeId = id;

    for (const node of this.tabNodes) {
      const active = node.dataset.tabId === id;
      node.dataset.active = String(active);
      if (node instanceof HTMLButtonElement) {
        node.setAttribute('aria-selected', String(active));
        node.tabIndex = active ? 0 : -1;
      }
    }

    this.emitter.emit('tabchange', id, tab);
    return this;
  }

  /** The id of the active tab, if any. */
  get activeTab(): string | undefined {
    return this.activeId;
  }

  /**
   * Toggle the focused look. An unfocused macOS window greys its lights, which
   * is worth mirroring when the frame sits beside other content.
   */
  setFocused(focused: boolean): this {
    this.focused = focused;
    this.element.dataset.focused = String(focused);
    return this;
  }

  /**
   * Merge new options and rebuild. The content element survives, so anything
   * mounted inside it, including an open terminal, is untouched.
   */
  update(options: WindowChromeOptions): this {
    this.options = { ...this.options, ...options };
    this.runTeardown();
    this.render();
    return this;
  }

  on<K extends keyof WindowChromeEvents>(
    event: K,
    listener: WindowChromeEvents[K],
  ): () => void {
    return this.emitter.on(event, listener);
  }

  /** Remove the chrome from the document and drop every listener. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.runTeardown();
    this.emitter.clear();
    this.element.remove();
  }

  private runTeardown(): void {
    while (this.teardown.length) this.teardown.pop()?.();
  }
}

/** Construct a window frame. See {@link WindowChrome}. */
export function createWindowChrome(options: WindowChromeOptions = {}): WindowChrome {
  return new WindowChrome(options);
}
