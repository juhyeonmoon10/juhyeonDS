#!/usr/bin/env bash
# Builds the mGBA core (GBA / GB / GBC) to WebAssembly.
# Requirements: git, cmake, ninja (or make), and an activated Emscripten SDK (emcmake in PATH).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MGBA_DIR="${MGBA_DIR:-$HERE/mgba}"
MGBA_TAG="${MGBA_TAG:-0.10.5}"

if [ ! -d "$MGBA_DIR" ]; then
    git clone --depth 1 --branch "$MGBA_TAG" https://github.com/mgba-emu/mgba.git "$MGBA_DIR"
fi

GEN=()
if command -v ninja >/dev/null 2>&1; then GEN=(-G Ninja); fi

emcmake cmake -S "$HERE" -B "$HERE/build" "${GEN[@]}" -DMGBA_DIR="$MGBA_DIR" -DCMAKE_BUILD_TYPE=Release
cmake --build "$HERE/build" -j"$(nproc 2>/dev/null || echo 2)"

mkdir -p "$HERE/../public/core"
cp "$HERE/build/mgba.js" "$HERE/build/mgba.wasm" "$HERE/../public/core/"
echo "Built: public/core/mgba.js, public/core/mgba.wasm"
