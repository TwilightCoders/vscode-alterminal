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

# Build loomptyd (brings in libloom as a dependency). If the loompty source
# tree is mid-development and won't compile, fall back to the existing
# vendored binary rather than failing the whole extension package — we
# vendor bin/loomptyd precisely so our build is insulated from upstream's
# in-progress state.
if ! cmake --build "$LOOM_DIR/build" --target loomptyd >/dev/null 2>&1; then
  if [[ -f "bin/loomptyd" ]]; then
    echo "⚠  loomptyd build failed (loompty source may be mid-change) — keeping existing bin/loomptyd"
    exit 0
  fi
  echo "❌ loomptyd build failed and no vendored bin/loomptyd to fall back to"
  exit 1
fi

# Copy to bin/ only when the source is newer. A spurious copy invalidates
# macOS's in-kernel code signature cache for bin/loomptyd, causing
# "EXC_CRASH (SIGKILL (Code Signature Invalid))" on the next exec. We
# compare mtimes rather than bytes because we re-sign after copying
# (which makes byte-comparison falsely indicate "different").
mkdir -p bin
SRC="$LOOM_DIR/build/loomptyd"
DST="bin/loomptyd"
SRC_MTIME=$(stat -f %m "$SRC" 2>/dev/null || echo 0)
DST_MTIME=$(stat -f %m "$DST" 2>/dev/null || echo 0)
if [[ ! -f "$DST" || "$SRC_MTIME" -gt "$DST_MTIME" ]]; then
  cp "$SRC" "$DST"
  # Re-sign ad-hoc so the kernel accepts the new inode immediately.
  if command -v codesign >/dev/null 2>&1; then
    codesign --force --sign - "$DST" 2>/dev/null || true
  fi
  # Touch dst to mtime = now so subsequent runs skip unless cmake rebuilt.
  touch "$DST"
  echo "✅ bin/loomptyd updated"
else
  echo "✅ bin/loomptyd up to date"
fi
