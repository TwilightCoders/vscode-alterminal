#!/usr/bin/env node
//
// verify-package.js — fail the build if the packaged vsix is missing any
// static resource the webview actually loads.
//
// The webview boots by loading a fixed set of node_modules scripts/styles and
// a couple of in-tree bundles, declared in src/utils/templateUtils.ts. If any
// of those files is absent from the package, the webview throws mid-init and
// (historically) silently killed all keyboard input. The packaging step used
// to copy a HAND-MAINTAINED list of deps into the vsix, which drifted from the
// loader and dropped @xterm/addon-search + @xterm/addon-unicode-graphemes.
//
// This gate ties verification to the loader itself: it parses the exact files
// templateUtils references and checks they exist under the packaged extension
// root. Run it in CI after repackaging, and locally before any manual package.
//
// Usage:
//   node scripts/verify-package.js <packaged-extension-root> [templateUtils.ts]
//
// <packaged-extension-root> is the directory containing the unpacked vsix's
// `node_modules/`, `lib/`, `src/` (i.e. the `extension/` dir inside the vsix).

const fs = require("fs");
const path = require("path");

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

function main() {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: node scripts/verify-package.js <packaged-extension-root> [templateUtils.ts]");
    process.exit(2);
  }
  const templateUtilsPath =
    process.argv[3] || path.join(__dirname, "..", "src", "utils", "templateUtils.ts");

  const source = fs.readFileSync(templateUtilsPath, "utf8");
  const required = extractRequiredWebviewFiles(source);

  const missing = required.filter((rel) => !fs.existsSync(path.join(root, rel)));

  if (missing.length > 0) {
    console.error(`❌ Packaged extension is missing ${missing.length} webview resource(s):`);
    missing.forEach((m) => console.error("  - " + m));
    console.error(`\nChecked root: ${root}`);
    console.error("These files are loaded by the webview at boot; a missing one breaks the terminal.");
    process.exit(1);
  }

  console.log(`✅ All ${required.length} webview resources present in package:`);
  required.forEach((r) => console.log("  - " + r));
}

if (require.main === module) {
  main();
}

module.exports = { extractRequiredWebviewFiles };
