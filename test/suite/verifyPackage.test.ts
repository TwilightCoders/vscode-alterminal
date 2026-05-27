import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

// scripts/verify-package.js is plain CommonJS at the repo root and is NOT part
// of the TS build, so resolve it relative to the repo root and require it.
// (From out/test/test/suite/, the repo root is four levels up.)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractRequiredWebviewFiles, extractRequiredDependencyDirs } = require(
  path.resolve(__dirname, "../../../..", "scripts/verify-package.js"),
);

/**
 * Regression guard for the work-mac "renders a prompt but takes no input"
 * incident: the packaged vsix dropped @xterm/addon-search and
 * @xterm/addon-unicode-graphemes, whose <script> tags then 404'd, throwing
 * during terminal init before input was wired.
 *
 * The fix ties the packaging gate to the webview loader itself. These tests
 * assert (a) the extractor reads the loader correctly, and (b) the REAL
 * templateUtils.ts still declares the two addons that were dropped — so if a
 * future change removes/renames them, both the loader and this guard move
 * together instead of silently drifting.
 */
suite("verify-package: webview resource extraction", () => {
  test("extracts node_modules + extensionUri-rooted resources", () => {
    const sample = `
      const a = getNodeModuleUri("@xterm/xterm/lib/xterm.js");
      const b = getNodeModuleUri("@xterm/addon-search/lib/addon-search.js");
      const c = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, "lib", "xterm-addon-webgpu", "dist", "webgpu-addon.umd.js"),
      );
      // template read: webview.html
    `;
    const files = extractRequiredWebviewFiles(sample);

    assert.ok(files.includes("node_modules/@xterm/xterm/lib/xterm.js"));
    assert.ok(files.includes("node_modules/@xterm/addon-search/lib/addon-search.js"));
    assert.ok(files.includes("lib/xterm-addon-webgpu/dist/webgpu-addon.umd.js"));
    assert.ok(files.includes("src/templates/webview.html"));
  });

  test("the real templateUtils.ts still requires both addons that were once dropped", () => {
    const templateUtilsPath = path.resolve(
      __dirname,
      "../../../..",
      "src/utils/templateUtils.ts",
    );
    const source = fs.readFileSync(templateUtilsPath, "utf8");
    const files = extractRequiredWebviewFiles(source);

    assert.ok(
      files.includes("node_modules/@xterm/addon-unicode-graphemes/lib/addon-unicode-graphemes.js"),
      "loader must still reference addon-unicode-graphemes (the addon whose absence killed input)",
    );
    assert.ok(
      files.includes("node_modules/@xterm/addon-search/lib/addon-search.js"),
      "loader must still reference addon-search",
    );
    assert.ok(
      files.includes("node_modules/@xterm/xterm/lib/xterm.js"),
      "loader must reference the xterm core",
    );
  });
});

suite("verify-package: runtime dependency dirs", () => {
  test("maps every package.json dependency to a node_modules dir", () => {
    const dirs = extractRequiredDependencyDirs({
      dependencies: { foo: "1.0.0", "@scope/bar": "2.0.0" },
    });
    assert.deepStrictEqual(dirs, ["node_modules/@scope/bar", "node_modules/foo"]);
  });

  test("--all-platforms adds the platform node-pty binaries", () => {
    const base = extractRequiredDependencyDirs({ dependencies: { foo: "1" } });
    const all = extractRequiredDependencyDirs(
      { dependencies: { foo: "1" } },
      { allPlatforms: true },
    );
    assert.ok(!base.includes("node_modules/@lydell/node-pty-linux-x64"));
    assert.ok(all.includes("node_modules/@lydell/node-pty-darwin-arm64"));
    assert.ok(all.includes("node_modules/@lydell/node-pty-win32-x64"));
  });

  test("the real package.json still declares the extension-host runtime deps", () => {
    const pkgPath = path.resolve(__dirname, "../../../..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const dirs = extractRequiredDependencyDirs(pkg);
    // These are require()d by the extension host at activation — a missing one
    // crashes the host, the other half of the "silent drop" failure mode.
    for (const dep of ["@lydell/node-pty", "koffi", "xterm-link-provider"]) {
      assert.ok(
        dirs.includes(`node_modules/${dep}`),
        `package.json must keep ${dep} as a runtime dependency`,
      );
    }
  });
});
