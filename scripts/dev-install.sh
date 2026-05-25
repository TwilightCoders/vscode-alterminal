#!/usr/bin/env bash
# Bump dev build number, compile, package, and install locally.
# Usage: npm run dev:install
set -euo pipefail

cd "$(dirname "$0")/.."

# --- Bump dev build number ---
# Use the SAME counter F5 uses (.vscode/dev-counter → src/generated/buildInfo.ts),
# then sync package.json's -dev.N to it. One number drives every display surface.
node scripts/bump-dev-build.js
counter=$(cat .vscode/dev-counter)
current=$(node -p "require('./package.json').version")
base=$(node -p 'require("./package.json").version.replace(/-dev\.\d+$/, "")')
new_version="${base}-dev.${counter}"
# npm version updates package.json + package-lock.json without a git tag
npm version "$new_version" --no-git-tag-version --allow-same-version >/dev/null
echo "📦 Version: $current → $new_version (build #$counter)"

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
