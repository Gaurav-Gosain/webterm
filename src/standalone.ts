// The entry of webterm.standalone.global.js, the build for a page that loads
// webterm with a script tag and reads it from the `WebTerm` global.
//
// It carries the core and the transports. The transports were missing from it,
// so a script-tag consumer (sip) wrote its own WebTransport, WebSocket
// fallback, framing and reconnect. vtgl is not here: it is about 900 KB that
// the default renderer never runs, and it has its own standalone,
// webterm-vtgl.standalone.global.js.
export * from './index.js';
export * from './transport/index.js';
