import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main() {
  try {
    // When `npm test` runs from a terminal spawned inside VS Code (the
    // integrated terminal, or Alterminal itself), the parent Electron exports
    // ELECTRON_RUN_AS_NODE=1 (alongside VSCODE_PID, VSCODE_IPC_HOOK, etc.).
    // That env var makes the test Electron we're about to launch run as plain
    // Node, which rejects VS Code's GUI flags ("bad option: --no-sandbox", etc.)
    // and aborts before Mocha ever starts. Stripping these inherited vars lets
    // the downloaded VS Code boot normally. (Not a corrupt download.)
    delete process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.VSCODE_PID;
    delete process.env.VSCODE_IPC_HOOK;
    delete process.env.VSCODE_NLS_CONFIG;
    delete process.env.VSCODE_CWD;

    // The folder containing the Extension Manifest package.json
    // Passed to `--extensionDevelopmentPath`
    const extensionDevelopmentPath = path.resolve(__dirname, "../../../");

    // The path to the extension test script
    // Passed to --extensionTestsPath
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");

    // Download VS Code, unzip it and run the integration test
    await runTests({ extensionDevelopmentPath, extensionTestsPath });
  } catch (err) {
    console.error("Failed to run tests");
    process.exit(1);
  }
}

main();
