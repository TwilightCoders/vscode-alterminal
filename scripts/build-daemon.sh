#!/usr/bin/env bash
# Build alterminald from native/ and place it in bin/.
# Requires libloom (loompty) — set LOOM_DIR to the loompty source tree.
# Falls back to ~/Workspace/TwilightCoders/loompty if not set.
set -euo pipefail

cd "$(dirname "$0")/.."

LOOM_DIR="${LOOM_DIR:-$HOME/Workspace/TwilightCoders/loompty}"

if [[ ! -f "$LOOM_DIR/core/include/loom/loom.h" ]]; then
  echo "⚠  libloom not found at $LOOM_DIR — skipping alterminald build"
  echo "   Set LOOM_DIR to the loompty source tree"
  exit 0
fi

# Build libloom if needed
if [[ ! -f "$LOOM_DIR/build/libloom.a" ]]; then
  echo "🔨 Building libloom..."
  cmake -S "$LOOM_DIR" -B "$LOOM_DIR/build" -DLOOM_BUILD_TESTS=OFF >/dev/null
  cmake --build "$LOOM_DIR/build" --target loom_static >/dev/null
fi

# Build alterminald
cmake -S native -B native/build -DLOOM_DIR="$LOOM_DIR" >/dev/null 2>&1
cmake --build native/build >/dev/null 2>&1

# Copy to bin/
mkdir -p bin
cp native/build/alterminald bin/alterminald

echo "✅ bin/alterminald built"
