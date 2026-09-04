#!/usr/bin/env bash
# Refresh the committed, platform-named loomptyd binary that ships in release
# vsixes (bin/loomptyd-<platform>-<arch>).
#
# This is deliberately SEPARATE from build-daemon.sh (which runs on every
# `npm run compile`) so that ordinary compiles never touch a committed binary.
# Run this only when loompty itself changes, then commit the updated binary as
# its own change:
#
#   npm run vendor-daemon                 # builds LOOM_DIR's current HEAD
#   LOOM_REF=v0.4.6 npm run vendor-daemon # builds a tag, via a throwaway clone
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

# Building a specific ref must NEVER be done by checking it out in LOOM_DIR.
# That directory is another agent's live working tree, and a checkout there
# leaves their HEAD detached — which makes `git push origin main` a silent
# no-op that reports "Everything up-to-date" while their work sits on a
# nameless commit. It happened twice before this guard existed, and the only
# reason it was caught is that they verify `git ls-remote` against local HEAD
# rather than trusting push output.
#
# So: pass LOOM_REF to build a tag or commit, and we clone to a throwaway
# directory instead. Same shape as every other bug this week — harmless on the
# machine you ran it on, quietly wrong for the other party.
if [ -n "${LOOM_REF:-}" ]; then
  CLONE_DIR="$(mktemp -d)"
  trap 'rm -rf "$CLONE_DIR"' EXIT
  echo "📦 Cloning $LOOM_REF out of $LOOM_DIR (never checking out in place)…"
  git clone --quiet --shared "$LOOM_DIR" "$CLONE_DIR"
  git -C "$CLONE_DIR" -c advice.detachedHead=false checkout --quiet "$LOOM_REF"
  LOOM_DIR="$CLONE_DIR"
fi

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
