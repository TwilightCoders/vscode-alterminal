#!/usr/bin/env bash
# Bump dev build number, compile, package, and install locally.
# Usage: npm run dev:install
set -euo pipefail

cd "$(dirname "$0")/.."

# --- Stage the dev build number (not yet earned) ---
# Use the SAME counter F5 uses (.vscode/dev-counter → src/generated/buildInfo.ts).
# --peek bakes the next number into buildInfo for the compile below but does NOT
# persist the counter, and we don't touch package.json yet. The bump is only
# committed once packaging actually produces a vsix — a failed build burns
# nothing and leaves package.json/the counter untouched.
build_num=$(node scripts/bump-dev-build.js --peek)
current=$(node -p "require('./package.json').version")
base=$(node -p 'require("./package.json").version.replace(/-dev\.\d+$/, "")')
new_version="${base}-dev.${build_num}"
echo "📦 Staging build #$build_num ($current → $new_version)"

# --- Build the in-tree WebGPU renderer addon (vendored UMD bundle) ---
if [[ -d lib/xterm-addon-webgpu/node_modules ]]; then
  echo "🎨 Building WebGPU renderer addon…"
  (cd lib/xterm-addon-webgpu && npm run build >/dev/null)
else
  echo "⚠  lib/xterm-addon-webgpu/node_modules missing — 'npm install' there to enable the webgpu renderer"
fi

# --- Compile (bakes in the staged build number) ---
npm run compile

# --- Bump package.json so vsce stamps the right version into the vsix ---
# Done only now, after compile succeeds; reverted below if packaging fails.
npm version "$new_version" --no-git-tag-version --allow-same-version >/dev/null

# --- Package ---
# vsce exits non-zero due to --no-dependencies npm install failure, but still
# produces the vsix. Tolerate the exit code and verify the file was created.
vsix="alterminal-dev.vsix"
# Tell verify-binaries.js to skip (we only have the local platform binary)
export ALTERMINAL_DEV_BUILD=1
npx @vscode/vsce package --no-git-tag-version --skip-license --no-dependencies \
  -o "$vsix" 2>&1 | tail -1
if [[ ! -f "$vsix" ]]; then
  # No artifact — undo the version bump and don't consume the build number.
  npm version "$current" --no-git-tag-version --allow-same-version >/dev/null
  echo "❌ vsce failed to produce $vsix — reverted to $current (build #$build_num not consumed)"
  exit 1
fi

# --- Build earned: persist the build counter ---
node scripts/bump-dev-build.js --commit "$build_num"
echo "📦 Version: $current → $new_version (build #$build_num)"

# --- Install locally ---
code --install-extension "$vsix" --force 2>/dev/null || true
ext_dir="$HOME/.vscode/extensions/twilightcoders.alterminal-$new_version"
if [[ -d "$ext_dir" ]]; then
  cp -r node_modules "$ext_dir/"
fi

echo "✅ Installed $new_version — reload VS Code"
