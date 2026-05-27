#!/usr/bin/env bash
# Build the vsix the ONE canonical way, so CI and release can never drift.
#
# vsce's npm-list step rejects cross-platform optional deps (the node-pty
# platform packages), so we package with --no-dependencies and then inject the
# runtime deps ourselves:
#   1. vsce package --no-dependencies            → a bare vsix (code only)
#   2. inject the full production dependency CLOSURE (npm ls, incl. transitive)
#      plus the platform node-pty binaries
#   3. run verify-package.js (the gate) against the assembled tree
#   4. repack
#
# Deriving the dep set from `npm ls` (not a hand-maintained list) is what keeps
# a dropped addon — the bug that once killed all keyboard input — from ever
# shipping again.
#
# Usage: scripts/package-vsix.sh <output.vsix> [--all-platforms]
#   --all-platforms  also require every platform node-pty binary to be present
#                    (the release injects all of them; pass it there, not in a
#                    single-platform local/CI build).
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

OUT="${1:?usage: package-vsix.sh <output.vsix> [--all-platforms]}"
# Resolve OUT to an absolute path (we zip from inside a temp dir).
case "$OUT" in /*) ;; *) OUT="$ROOT/$OUT" ;; esac
GATE_FLAG=""
[ "${2:-}" = "--all-platforms" ] && GATE_FLAG="--all-platforms"

BARE="$ROOT/.vsix-bare.vsix"
npx @vscode/vsce package --no-git-tag-version --skip-license --no-dependencies -o "$BARE"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK" "$BARE"' EXIT
( cd "$WORK" && unzip -q "$BARE" )

# (1) Full production dependency closure, preserving nested node_modules paths.
#     First `npm ls` line is the root package — skipped (not under node_modules).
npm ls --omit=dev --all --parseable 2>/dev/null | while read -r abs; do
  rel="${abs#"$ROOT"/}"
  [ "$rel" = "$abs" ] && continue
  case "$rel" in node_modules/*) ;; *) continue ;; esac
  [ -d "$abs" ] || continue
  mkdir -p "$WORK/extension/$(dirname "$rel")"
  cp -r "$abs" "$WORK/extension/$(dirname "$rel")/"
done

# (2) Platform node-pty binaries: optionalDependencies for OTHER OSes that this
#     runner's npm won't install, so the release pre-fetches them via npm pack.
for dep in @lydell/node-pty-darwin-arm64 @lydell/node-pty-darwin-x64 \
           @lydell/node-pty-linux-arm64 @lydell/node-pty-linux-x64 \
           @lydell/node-pty-win32-x64; do
  src="$ROOT/node_modules/$dep"
  if [ -d "$src" ]; then
    mkdir -p "$WORK/extension/node_modules/$dep"
    cp -r "$src"/. "$WORK/extension/node_modules/$dep/"
  else
    echo "⚠️  platform binary not present (skipping): $dep"
  fi
done

# (3) Gate: fail if anything the webview loads or the host requires is missing.
node "$ROOT/scripts/verify-package.js" "$WORK/extension" \
  "$ROOT/src/utils/templateUtils.ts" $GATE_FLAG

# (4) Repack.
( cd "$WORK" && zip -qr "$OUT" . )
SIZE=$(wc -c < "$OUT")
echo "✅ Packaged $OUT ($((SIZE / 1024 / 1024))MB)"
