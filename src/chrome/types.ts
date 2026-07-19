/**
 * Options and events for the window chrome.
 *
 * Nothing here refers to a terminal. The chrome is a frame around a slot, so
 * the same options describe a frame around a code block or an image.
 */

export type ChromeAppearance = 'auto' | 'light' | 'dark';

export type ChromeStyle = 'macos';

export type BackgroundPreset =
  | 'aurora'
  | 'candy'
  | 'dawn'
  | 'mint'
  | 'noir'
  | 'ocean'
  | 'slate'
  | 'sunset'
  | 'none';

/**
 * A background is a preset name, a plain CSS value, or one of the tagged
 * forms. The tagged forms exist so a consumer building options from a form or
 * a config file does not have to concatenate CSS strings themselves.
 */
export type ChromeBackground =
  | BackgroundPreset
  | (string & {})
  | { preset: BackgroundPreset }
  | { color: string }
  | { gradient: string }
  | { image: string; size?: string; position?: string; repeat?: string }
  | { css: string };

export interface TrafficLightOptions {
  /** Draw the three lights at all. Default true. */
  show?: boolean;
  /**
   * Make the lights real buttons. Default false, in which case they are inert
   * decoration and are hidden from the accessibility tree, because a control
   * that is announced but does nothing is worse than no control.
   */
  interactive?: boolean;
  /** Labels for the buttons, when interactive. */
  labels?: { close?: string; minimize?: string; maximize?: string };
}

export interface ChromeTab {
  id: string;
  title: string;
}

export interface TabOptions {
  items: ChromeTab[];
  activeId?: string;
  /**
   * Whether a tab can be selected. Default false: visual-only tabs are a
   * screenshot device, and like the lights they stay out of the accessibility
   * tree until they do something.
   */
  interactive?: boolean;
}

export interface ChromeShadowOptions {
  /** Named intensity, or false for no shadow. Default 'medium'. */
  size?: 'none' | 'small' | 'medium' | 'large';
  /** Override the whole box-shadow value. */
  css?: string;
}

export interface WindowChromeOptions {
  /** Frame idiom. Only the macOS frame ships today. */
  style?: ChromeStyle;
  /** Default 'auto', which follows prefers-color-scheme. */
  appearance?: ChromeAppearance;
  /** Title bar text. Omit for an empty title bar. */
  title?: string;
  /** Default 'center', matching the platform. */
  titleAlign?: 'left' | 'center';
  /** Draw the title bar at all. Default true. */
  titleBar?: boolean;
  lights?: boolean | TrafficLightOptions;
  tabs?: ChromeTab[] | TabOptions;
  /** Corner radius, any CSS length. Default 10px, the platform value. */
  radius?: string | number;
  shadow?: boolean | ChromeShadowOptions['size'] | ChromeShadowOptions;
  /** Decorative background behind the window. Default 'aurora'. */
  background?: ChromeBackground;
  /** Space between the background edge and the window. Default 48px. */
  padding?: string | number;
  /** Explicit window size. Omitted, the window fills the padded stage. */
  width?: string | number;
  height?: string | number;
  /** Caps the window width while it still fills the stage below that. */
  maxWidth?: string | number;
  /**
   * Background of the content slot. Set this to the terminal's background so
   * the partial cell that fit() leaves on the right and bottom edges is not a
   * differently coloured strip.
   */
  contentBackground?: string;
  /**
   * Inset between the frame and the content. Default 0, because a terminal
   * usually wants the whole slot; a few pixels reads better when the title bar
   * is off and the content would otherwise touch the corner arc.
   *
   * The fit addon subtracts the container's padding when it measures, so this
   * shrinks the grid rather than overflowing it.
   */
  contentPadding?: string | number;
  /** Title bar height, any CSS length. Default 38px. */
  titleBarHeight?: string | number;
  /** Title bar font stack. Defaults to the platform UI stack. */
  fontFamily?: string;
  /** Extra class names on the stage element. */
  className?: string;
  /** Arbitrary custom properties, applied to the stage. */
  vars?: Record<string, string>;
}

export interface WindowChromeEvents {
  close: () => void;
  minimize: () => void;
  maximize: () => void;
  tabchange: (id: string, tab: ChromeTab) => void;
}
