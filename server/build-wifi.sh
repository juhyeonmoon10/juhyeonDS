#!/usr/bin/env bash
# Build the native packet bridge on a Linux server with libslirp development files.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
output="${1:-$here/../tools/juhyeonds-wifi}"
if ! pkg-config --atleast-version=4.9.7 slirp; then
  echo "libslirp 4.9.7 이상과 pkg-config를 설치하세요." >&2
  exit 1
fi
mkdir -p "$(dirname "$output")"
read -r -a flags <<< "$(pkg-config --cflags --libs --static slirp)"
"${CXX:-c++}" -std=c++17 -O2 -Wall -Wextra "$here/wifi-slirp.cpp" -o "$output" "${flags[@]}"
echo "Built: $output"
