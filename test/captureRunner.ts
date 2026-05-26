/**
 * Launches the WebGPU capture harness (test/capture/index.ts) inside a real
 * Electron VS Code. Mirrors runTest.ts's env scrubbing so it boots when invoked
 * from a VS Code-integrated terminal. Run via `npm run capture`.
 */
import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main() {
  try {
    // See runTest.ts: strip inherited VS Code env so the test Electron boots as
    // a GUI app rather than plain Node.
    delete process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.VSCODE_PID;
    delete process.env.VSCODE_IPC_HOOK;
    delete process.env.VSCODE_NLS_CONFIG;
    delete process.env.VSCODE_CWD;

    const extensionDevelopmentPath = path.resolve(__dirname, "../../../");
    const extensionTestsPath = path.resolve(__dirname, "./capture/index");

    await runTests({ extensionDevelopmentPath, extensionTestsPath });
  } catch (err) {
    console.error("Capture run failed:", err);
    process.exit(1);
  }
}

main();
