#!/usr/bin/env bash
# Refresh the committed, platform-named loomptyd binary that ships in release
# vsixes (bin/loomptyd-<platform>-<arch>).
#
# This is deliberately SEPARATE from build-daemon.sh (which runs on every
# `npm run compile`) so that ordinary compiles never touch a committed binary.
# Run this only when loompty itself changes, then commit the updated binary as
# its own change:
#
#   npm run vendor-daemon
#   git add bin/loomptyd-<platform>-<arch> && git commit
#
# CI has no loompty source to build from, so the release relies entirely on
# this vendored binary being current in the repo.
#
# STATIC BY CONSTRUCTION: the shipped artifact is built with
# -DLOOM_STATIC_UV=ON, which builds libuv from pinned source and links it as a
# static archive. A default (dynamic) build links the BUILD machine's libuv by
# absolute path — e.g. /opt/homebrew/opt/libuv/lib/libuv.1.dylib — which does
# not exist on a user's machine, so the daemon dies at exec with a dyld error.
# That shipped once and cost a day of debugging (no daemon → no PTY session
# persistence → shells never restore, plus connect/spawn churn). Never vendor
# from the dynamic dev build; scripts/verify-binaries.js enforces this at
# release time. Uses its own build dir so the dev build tree's configuration
# (dynamic, faster to rebuild) is left alone.
set -euo pipefail

cd "$(dirname "$0")/.."

LOOM_DIR="${LOOM_DIR:-$HOME/Workspace/TwilightCoders/loompty}"
BUILD_DIR="$LOOM_DIR/build-static"

if [[ ! -f "$LOOM_DIR/cmd/loomptyd/main.cpp" ]]; then
  echo "❌ loompty source not found at $LOOM_DIR — set LOOM_DIR and retry"
  exit 1
fi

if ! grep -q "LOOM_STATIC_UV" "$LOOM_DIR/CMakeLists.txt"; then
  echo "❌ $LOOM_DIR does not support -DLOOM_STATIC_UV (needs loompty >= 5de88a5)."
  echo "   Update the loompty checkout; vendoring a dynamically-linked daemon is not shippable."
  exit 1
fi

echo "🔨 Configuring loompty (static libuv)…"
cmake -S "$LOOM_DIR" -B "$BUILD_DIR" \
  -DLOOM_STATIC_UV=ON -DCMAKE_BUILD_TYPE=Release -DLOOM_BUILD_TESTS=OFF >/dev/null

echo "🔨 Building loomptyd…"
cmake --build "$BUILD_DIR" --target loomptyd >/dev/null

SRC="$BUILD_DIR/loomptyd"
[[ -f "$SRC" ]] || { echo "❌ build produced no $SRC"; exit 1; }

# node arch uses "x64" where uname says "x86_64".
ARCH="$(uname -m)"; [[ "$ARCH" == "x86_64" ]] && ARCH="x64"
PLAT="$(uname -s | tr '[:upper:]' '[:lower:]')"
VENDORED="bin/loomptyd-${PLAT}-${ARCH}"

mkdir -p bin
cp "$SRC" "$VENDORED"
if command -v codesign >/dev/null 2>&1; then
  # Ad-hoc re-sign so the kernel accepts the new inode immediately (a stale
  # signature cache surfaces as "EXC_CRASH (SIGKILL (Code Signature Invalid))").
  codesign --force --sign - "$VENDORED" 2>/dev/null || true
fi

echo "✅ $VENDORED refreshed — $("$VENDORED" --version 2>&1 | head -1)"
node scripts/verify-binaries.js >/dev/null 2>&1 \
  && echo "✅ redistributable (no non-system dynamic deps)" \
  || echo "⚠  verify-binaries reported an issue — run: node scripts/verify-binaries.js"
echo "   Commit it as its own change."
