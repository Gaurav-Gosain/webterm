#!/bin/sh
# Fetch Ghostty at the pinned commit, apply engine/patches, and build
# libghostty-vt for wasm32-freestanding. Output: $CACHE/wasm/lib/libghostty-vt.a.
# With NATIVE=1 it builds the unpatched native library instead, which the
# accuracy check uses as its reference.
#
# Needs Zig 0.16.x (set ZIG). Ghostty compares major.minor exactly.
set -eu
GHOSTTY_COMMIT=246f702876b924a1cb7cade1e99274d1470302fc
here=$(cd "$(dirname "$0")" && pwd)
CACHE=${CACHE:-$here/.ghostty}
ZIG=${ZIG:-zig}
case "$("$ZIG" version)" in 0.16.*) ;; *) echo "ghostty.sh: Zig 0.16.x is required (set ZIG)" >&2; exit 1 ;; esac
src=$CACHE/src
if [ ! -d "$src/.git" ]; then
  git init -q "$src"
  git -C "$src" remote add origin https://github.com/ghostty-org/ghostty
fi
if [ "$(git -C "$src" rev-parse HEAD 2>/dev/null)" != "$GHOSTTY_COMMIT" ]; then
  git -C "$src" fetch -q --depth 1 origin "$GHOSTTY_COMMIT"
  git -C "$src" checkout -q --detach FETCH_HEAD
fi
git -C "$src" checkout -q -- .
if [ "${NATIVE:-0}" = 1 ]; then
  (cd "$src" && "$ZIG" build -Demit-lib-vt -Doptimize=ReleaseFast -Dcpu=baseline \
    --cache-dir "$CACHE/zcache-native" --prefix "$CACHE/native")
  exit 0
fi
for p in "$here"/patches/*.patch; do git -C "$src" apply "$p"; done
(cd "$src" && "$ZIG" build -Demit-lib-vt -Doptimize=ReleaseFast -Dstrip=true \
  -Dtarget=wasm32-freestanding --cache-dir "$CACHE/zcache" --prefix "$CACHE/wasm")
git -C "$src" checkout -q -- .
