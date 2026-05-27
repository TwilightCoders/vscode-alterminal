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
set -euo pipefail

cd "$(dirname "$0")/.."

# Build (or refresh) the dev binary first.
bash scripts/build-daemon.sh

DST="bin/loomptyd"
if [[ ! -f "$DST" ]]; then
  echo "❌ $DST not present — set LOOM_DIR and ensure loompty builds, then retry"
  exit 1
fi

# node arch uses "x64" where uname says "x86_64".
ARCH="$(uname -m)"; [[ "$ARCH" == "x86_64" ]] && ARCH="x64"
PLAT="$(uname -s | tr '[:upper:]' '[:lower:]')"
VENDORED="bin/loomptyd-${PLAT}-${ARCH}"

cp "$DST" "$VENDORED"
if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$VENDORED" 2>/dev/null || true
fi
echo "✅ $VENDORED refreshed — commit it as its own change"
