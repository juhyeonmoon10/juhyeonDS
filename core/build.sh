#!/usr/bin/env bash
# Builds the melonDS core to WebAssembly.
# Requirements: git, cmake, ninja (or make), and an activated Emscripten SDK (emcmake in PATH).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MELONDS_DIR="${MELONDS_DIR:-$HERE/melonDS}"
MELONDS_TAG="${MELONDS_TAG:-1.1}"

if [ ! -d "$MELONDS_DIR" ]; then
    git clone --depth 1 --branch "$MELONDS_TAG" https://github.com/melonDS-emu/melonDS.git "$MELONDS_DIR"
fi

# Frame skip support (emulate a frame without drawing it); see frameskip.patch.
if ! grep -q "SkipRender" "$MELONDS_DIR/src/GPU.h"; then
    git -C "$MELONDS_DIR" apply "$HERE/frameskip.patch"
fi

GEN=()
if command -v ninja >/dev/null 2>&1; then GEN=(-G Ninja); fi

emcmake cmake -S "$HERE" -B "$HERE/build" "${GEN[@]}" -DMELONDS_DIR="$MELONDS_DIR" -DCMAKE_BUILD_TYPE=Release
cmake --build "$HERE/build" -j"$(nproc 2>/dev/null || echo 2)"

mkdir -p "$HERE/../public/core"
cp "$HERE/build/melonds.js" "$HERE/build/melonds.wasm" "$HERE/../public/core/"
echo "Built: public/core/melonds.js, public/core/melonds.wasm"
