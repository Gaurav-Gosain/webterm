/**
 * Optional macOS-style window chrome.
 *
 * A separate entry point, and it imports nothing from the terminal, so a
 * consumer who only wants the terminal never pays for this and a consumer who
 * only wants a frame can use it around anything.
 *
 * Requires the stylesheet: `import 'webterm/chrome.css'`.
 */
export { WindowChrome, createWindowChrome } from './chrome.js';
export { backgroundNames, backgrounds, resolveBackground, shadows } from './presets.js';
export type {
  BackgroundPreset,
  ChromeAppearance,
  ChromeBackground,
  ChromeShadowOptions,
  ChromeStyle,
  ChromeTab,
  TabOptions,
  TrafficLightOptions,
  WindowChromeEvents,
  WindowChromeOptions,
} from './types.js';
