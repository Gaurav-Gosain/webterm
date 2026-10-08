// The entry of webterm.standalone.global.js, the build for a page that loads
// webterm with a script tag and reads it from the `WebTerm` global.
//
// It carries the core, the transports and touch support. The transports were
// missing from it, so a script-tag consumer (sip) wrote its own WebTransport,
// WebSocket fallback, framing and reconnect. vtgl is not here: it is about 900 KB that
// the default renderer never runs, and it has its own standalone,
// webterm-vtgl.standalone.global.js.
export * from './index.js';
export * from './transport/index.js';

// Touch support, as `WebTerm.mobile`. A namespace rather than spread into the
// global, because its names (installKeyBar, DEFAULT_KEYS) say nothing about
// touch on their own.
export * as mobile from './mobile/index.js';
