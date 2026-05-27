#!/usr/bin/env node
//
// verify-package.js — fail the build if the packaged vsix is missing anything
// the extension needs at runtime, on either side of the webview boundary.
//
// Two failure modes, both historically fatal and both silent:
//
//   1. Webview side. The webview boots by loading a fixed set of node_modules
//      scripts/styles + in-tree bundles, declared in src/utils/templateUtils.ts.
//      A missing one throws mid-init and once killed all keyboard input.
//   2. Extension-host side. The host `require()`s node-pty, koffi, and
//      xterm-link-provider at activation; a missing one crashes activation.
//
// The packaging step used to copy a HAND-MAINTAINED list of deps into the vsix,
// which drifted from package.json and dropped @xterm/addon-search +
// @xterm/addon-unicode-graphemes. This gate ties verification to ground truth:
//   - webview files: parsed from the loader (templateUtils.ts)
//   - runtime deps: every entry in package.json `dependencies` (+ the platform
//     node-pty binaries, with --all-platforms)
// and checks they all exist under the packaged extension root.
//
// Usage:
//   node scripts/verify-package.js <packaged-extension-root> [templateUtils.ts] [--all-platforms]
//
// <packaged-extension-root> is the `extension/` dir inside the unpacked vsix.
// --all-platforms additionally requires every platform node-pty binary (the
// release injects all of them; a local single-platform build does not).

const fs = require("fs");
const path = require("path");

// Platform-specific node-pty binaries the release ships for all targets.
const PLATFORM_NODE_PTY = [
  "@lydell/node-pty-darwin-arm64",
  "@lydell/node-pty-darwin-x64",
  "@lydell/node-pty-linux-arm64",
  "@lydell/node-pty-linux-x64",
  "@lydell/node-pty-win32-x64",
];

/**
 * Extract every static resource path (relative to the extension root) that the
 * webview loads, by parsing templateUtils.ts. Pure function — unit-tested.
 *
 * @param {string} source  contents of src/utils/templateUtils.ts
 * @returns {string[]} sorted, de-duplicated relative paths
 */
function extractRequiredWebviewFiles(source) {
  const files = new Set();

  // getNodeModuleUri("<pkg>/<path>")  →  node_modules/<pkg>/<path>
  // Tolerates multi-line calls with a trailing comma:
  //   getNodeModuleUri(\n  "@xterm/addon-search/lib/addon-search.js",\n)
  for (const m of source.matchAll(/getNodeModuleUri\(\s*"([^"]+)"\s*,?\s*\)/g)) {
    files.add(path.posix.join("node_modules", m[1]));
  }

  // vscode.Uri.joinPath(extensionUri, "a", "b", ...)  →  a/b/...
  // (covers the in-tree WebGPU bundle and any other extensionUri-rooted asset)
  for (const m of source.matchAll(
    /joinPath\(\s*extensionUri\s*,\s*((?:"[^"]+"\s*,?\s*)+)\)/g,
  )) {
    const parts = [...m[1].matchAll(/"([^"]+)"/g)].map((p) => p[1]);
    if (parts.length) files.add(path.posix.join(...parts));
  }

  // The HTML template is read from disk at runtime in packaged installs
  // (templateUtils candidateTemplatePaths). It ships via a .vscodeignore
  // exception, so verify it too.
  if (source.includes("webview.html")) {
    files.add("src/templates/webview.html");
  }

  return [...files].sort();
}

/**
 * The node_modules directories that must be packaged: every runtime
 * `dependencies` entry (these are require()d by the extension host or loaded by
 * the webview), plus the platform node-pty binaries when allPlatforms is set.
 * Pure function — unit-tested.
 *
 * @param {object} pkgJson        parsed package.json
 * @param {{allPlatforms?: boolean}} [opts]
 * @returns {string[]} sorted, de-duplicated relative dir paths
 */
function extractRequiredDependencyDirs(pkgJson, opts = {}) {
  const dirs = new Set();
  for (const dep of Object.keys(pkgJson.dependencies || {})) {
    dirs.add(path.posix.join("node_modules", dep));
  }
  if (opts.allPlatforms) {
    for (const dep of PLATFORM_NODE_PTY) {
      dirs.add(path.posix.join("node_modules", dep));
    }
  }
  return [...dirs].sort();
}

function main() {
  const args = process.argv.slice(2);
  const allPlatforms = args.includes("--all-platforms");
  const positional = args.filter((a) => !a.startsWith("--"));
  const root = positional[0];
  if (!root) {
    console.error(
      "usage: node scripts/verify-package.js <packaged-extension-root> [templateUtils.ts] [--all-platforms]",
    );
    process.exit(2);
  }
  const templateUtilsPath =
    positional[1] || path.join(__dirname, "..", "src", "utils", "templateUtils.ts");
  const pkgJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );

  const webviewFiles = extractRequiredWebviewFiles(fs.readFileSync(templateUtilsPath, "utf8"));
  const depDirs = extractRequiredDependencyDirs(pkgJson, { allPlatforms });
  const required = [...webviewFiles, ...depDirs];

  const missing = required.filter((rel) => !fs.existsSync(path.join(root, rel)));

  if (missing.length > 0) {
    console.error(`❌ Packaged extension is missing ${missing.length} required resource(s):`);
    missing.forEach((m) => console.error("  - " + m));
    console.error(`\nChecked root: ${root}`);
    console.error("These are loaded by the webview or required by the extension host; a missing one breaks the terminal.");
    process.exit(1);
  }

  console.log(
    `✅ All ${required.length} required resources present in package ` +
      `(${webviewFiles.length} webview files, ${depDirs.length} dependency dirs):`,
  );
  required.forEach((r) => console.log("  - " + r));
}

if (require.main === module) {
  main();
}

module.exports = { extractRequiredWebviewFiles, extractRequiredDependencyDirs };
