#!/usr/bin/env bash
# Fetch the per-platform node-pty prebuilds for EVERY target OS/arch.
#
# Why this exists: those packages are optionalDependencies with os/cpu
# constraints, so a normal `npm install` only ever installs the one matching the
# machine you're on — and any subsequent `npm install` PRUNES the others. A
# release vsix needs all of them (package-vsix.sh copies whatever is present,
# and verify-binaries.js gates on the full set), so they have to be fetched
# explicitly, bypassing the platform filter. `npm pack` + extract does that;
# `npm install` cannot.
#
#   npm run install-binaries
#
# verify-binaries.js has pointed at this script for a long time while it did not
# exist, which is why a release could quietly ship missing platform binaries.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${NODE_PTY_VERSION:-$(node -p "require('./package.json').dependencies['@lydell/node-pty'].replace(/^[^0-9]*/,'')")}"

PKGS=(
  @lydell/node-pty-darwin-arm64
  @lydell/node-pty-darwin-x64
  @lydell/node-pty-linux-arm64
  @lydell/node-pty-linux-x64
  @lydell/node-pty-win32-x64
)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for pkg in "${PKGS[@]}"; do
  dest="node_modules/$pkg"
  if [[ -d "$dest" ]]; then
    echo "✅ present: $pkg"
    continue
  fi
  echo "⬇️  fetching ${pkg}@${VERSION} ..."
  # npm pack ignores os/cpu constraints — that's the point.
  tarball="$(cd "$TMP" && npm pack "${pkg}@${VERSION}" --silent 2>/dev/null | tail -1)"
  if [[ -z "$tarball" || ! -f "$TMP/$tarball" ]]; then
    echo "❌ failed to fetch ${pkg}@${VERSION}"
    exit 1
  fi
  mkdir -p "$dest"
  # npm tarballs wrap everything in package/
  tar -xzf "$TMP/$tarball" -C "$dest" --strip-components=1
  echo "✅ installed: $pkg"
done

echo "✅ All platform node-pty binaries present"
