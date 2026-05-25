#!/usr/bin/env bash
# Build, package, and install a dev build locally.
# Usage: npm run dev:install
#
# Versioning model: the committed package.json holds ONLY the curated semver
# (e.g. 0.2.0). The build number is a monotonic, version-independent counter
# (.vscode/dev-counter) that we staple on as a pre-release tag — 0.2.0-dev.<N> —
# ONLY for the packaged vsix, so VS Code sees a unique, newer version each
# install. The working package.json is restored to the curated semver
# afterward, so the build number never lands in the repo.
set -euo pipefail

cd "$(dirname "$0")/.."

orig_version=$(node -p "require('./package.json').version")
base=$(node -p 'require("./package.json").version.replace(/-dev\.\d+$/, "")')

# Always return the working package.json to the curated semver on exit —
# success, failure, or interrupt — so the build number is never committed.
restore_version() { npm version "$base" --no-git-tag-version --allow-same-version >/dev/null 2>&1 || true; }
trap restore_version EXIT

# --- Stage the dev build number (not yet earned) ---
# --peek bakes the next build number into buildInfo for the compile below but
# does NOT persist the counter. We --commit it only once a vsix exists, so a
# failed build burns nothing.
build_num=$(node scripts/bump-dev-build.js --peek)
new_version="${base}-dev.${build_num}"
echo "📦 Staging build #$build_num → $new_version"

# --- Build the in-tree WebGPU renderer addon (vendored UMD bundle) ---
if [[ -d lib/xterm-addon-webgpu/node_modules ]]; then
  echo "🎨 Building WebGPU renderer addon…"
  (cd lib/xterm-addon-webgpu && npm run build >/dev/null)
else
  echo "⚠  lib/xterm-addon-webgpu/node_modules missing — 'npm install' there to enable the webgpu renderer"
fi

# --- Compile (bakes in the staged build number) ---
npm run compile

# --- Stamp the build version into package.json for vsce, then package ---
npm version "$new_version" --no-git-tag-version --allow-same-version >/dev/null

vsix="alterminal-dev.vsix"
export ALTERMINAL_DEV_BUILD=1   # verify-binaries.js: skip (local platform only)
# vsce exits non-zero due to --no-dependencies npm install failure, but still
# produces the vsix. Tolerate the exit code and verify the file was created.
npx @vscode/vsce package --no-git-tag-version --skip-license --no-dependencies \
  -o "$vsix" 2>&1 | tail -1
if [[ ! -f "$vsix" ]]; then
  echo "❌ vsce failed to produce $vsix — build #$build_num not consumed"
  exit 1   # trap restores package.json to the curated semver
fi

# --- Build earned: persist the build counter ---
node scripts/bump-dev-build.js --commit "$build_num"
echo "📦 Built $new_version (build #$build_num)"

# --- Install locally ---
code --install-extension "$vsix" --force 2>/dev/null || true
ext_dir="$HOME/.vscode/extensions/twilightcoders.alterminal-$new_version"
if [[ -d "$ext_dir" ]]; then
  cp -r node_modules "$ext_dir/"
fi

echo "✅ Installed $new_version — reload VS Code"
