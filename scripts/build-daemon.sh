#!/usr/bin/env bash
# Build loomptyd (the loompty reference PTY daemon) and place it in bin/.
# loomptyd is loompty's reference binary — we vendor it rather than maintain
# our own wrapper. LOOM_DIR points at the loompty source tree.
# Falls back to ~/Workspace/TwilightCoders/loompty if not set.
set -euo pipefail

cd "$(dirname "$0")/.."

LOOM_DIR="${LOOM_DIR:-$HOME/Workspace/TwilightCoders/loompty}"

if [[ ! -f "$LOOM_DIR/cmd/loomptyd/main.cpp" ]]; then
  echo "⚠  loompty not found at $LOOM_DIR — skipping loomptyd build"
  echo "   Set LOOM_DIR to the loompty source tree"
  exit 0
fi

# Configure loompty if needed
if [[ ! -f "$LOOM_DIR/build/build.ninja" && ! -f "$LOOM_DIR/build/Makefile" ]]; then
  echo "🔨 Configuring loompty..."
  cmake -S "$LOOM_DIR" -B "$LOOM_DIR/build" -DLOOM_BUILD_TESTS=OFF >/dev/null
fi

# Build loomptyd (brings in libloom as a dependency)
cmake --build "$LOOM_DIR/build" --target loomptyd >/dev/null 2>&1

# Copy to bin/
mkdir -p bin
cp "$LOOM_DIR/build/loomptyd" bin/loomptyd

echo "✅ bin/loomptyd built"
