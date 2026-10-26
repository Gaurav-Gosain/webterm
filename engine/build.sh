#!/bin/sh
# Build dist/engine.wasm: libghostty-vt (wasm32-freestanding) and
# native/engine.c linked into one module. Run ghostty.sh first.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
ZIG=${ZIG:-zig}
CACHE=${CACHE:-$here/.ghostty}
GHOSTTY_SRC=${GHOSTTY_SRC:-$CACHE/src}
GHOSTTY_WASM=${GHOSTTY_WASM:-$CACHE/wasm}
out=${OUT:-$here/dist}
# Wuffs' single-file C source, pinned by Ghostty's package manifest; only its
# declarations are used, the decoder itself is in libghostty-vt.
wuffs=$(dirname "$(ls "$GHOSTTY_SRC"/zig-pkg/*/release/c/wuffs-v0.4.c | head -1)")
mkdir -p "$out"
node "$here/scripts/gen-diacritics.mjs" "$GHOSTTY_SRC/src/terminal/kitty/graphics_unicode.zig" "$here/native/diacritics.h"
node "$here/scripts/gen-keys.mjs" "$GHOSTTY_SRC/include/ghostty/vt/key/event.h" "$here/src/keys.js"
node --no-warnings "$here/scripts/gen-transports.mjs"
"$ZIG" cc -target wasm32-freestanding -O3 -mbulk-memory -msimd128 -nostdlib \
  -I"$GHOSTTY_SRC/include" \
  -DENGINE_PNG -I"$wuffs" -I"$GHOSTTY_SRC/pkg/wuffs/include" \
  -Wl,--no-entry -Wl,--export-memory -Wl,-z,stack-size=262144 \
  -Wl,--gc-sections -Wl,--strip-all \
  "$here/native/engine.c" "$GHOSTTY_WASM/lib/libghostty-vt.a" \
  -o "$out/engine.raw.wasm"
if command -v wasm-opt >/dev/null; then
  wasm-opt -O3 --enable-bulk-memory --enable-simd --enable-nontrapping-float-to-int \
    --enable-sign-ext --enable-mutable-globals "$out/engine.raw.wasm" -o "$out/engine.wasm"
  rm "$out/engine.raw.wasm"
else
  mv "$out/engine.raw.wasm" "$out/engine.wasm"
fi
ls -l "$out/engine.wasm"
