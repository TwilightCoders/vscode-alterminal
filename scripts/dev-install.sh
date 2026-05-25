#!/usr/bin/env bash
# Bump dev build number, compile, package, and install locally.
# Usage: npm run dev:install
set -euo pipefail

cd "$(dirname "$0")/.."

# --- Bump dev build number ---
# Extracts current dev.N, increments N, writes back to package.json.
current=$(node -p "require('./package.json').version")
if [[ "$current" =~ ^([0-9]+\.[0-9]+\.[0-9]+-dev\.)([0-9]+)$ ]]; then
  prefix="${BASH_REMATCH[1]}"
  build="${BASH_REMATCH[2]}"
  next=$((build + 1))
  new_version="${prefix}${next}"
else
  echo "⚠  Version '$current' doesn't match X.Y.Z-dev.N pattern — skipping bump"
  new_version="$current"
fi

if [[ "$new_version" != "$current" ]]; then
  # Use npm version to update package.json + package-lock.json without git tag
  npm version "$new_version" --no-git-tag-version --allow-same-version >/dev/null
  echo "📦 Version: $current → $new_version"
else
  echo "📦 Version: $current (unchanged)"
fi

# --- Build the in-tree WebGPU renderer addon (vendored UMD bundle) ---
if [[ -d lib/xterm-addon-webgpu/node_modules ]]; then
  echo "🎨 Building WebGPU renderer addon…"
  (cd lib/xterm-addon-webgpu && npm run build >/dev/null)
else
  echo "⚠  lib/xterm-addon-webgpu/node_modules missing — 'npm install' there to enable the webgpu renderer"
fi

# --- Compile ---
npm run compile

# --- Package ---
# vsce exits non-zero due to --no-dependencies npm install failure, but still
# produces the vsix. Tolerate the exit code and verify the file was created.
vsix="alterminal-dev.vsix"
# Tell verify-binaries.js to skip (we only have the local platform binary)
export ALTERMINAL_DEV_BUILD=1
npx @vscode/vsce package --no-git-tag-version --skip-license --no-dependencies \
  -o "$vsix" 2>&1 | tail -1
if [[ ! -f "$vsix" ]]; then
  echo "❌ vsce failed to produce $vsix"
  exit 1
fi

# --- Install locally ---
code --install-extension "$vsix" --force 2>/dev/null || true
ext_dir="$HOME/.vscode/extensions/twilightcoders.alterminal-$new_version"
if [[ -d "$ext_dir" ]]; then
  cp -r node_modules "$ext_dir/"
fi

echo "✅ Installed $new_version — reload VS Code"
