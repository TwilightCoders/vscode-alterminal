import * as assert from "assert";
import {
  isVscodeInjectedEnvKey,
  listVscodeInjectedEnv,
  sanitizeSpawnEnv,
} from "../../src/terminal/envSanitizer";

/**
 * Alterminal is NOT VS Code's integrated terminal, but in DAEMON mode our
 * shells inherit the ext-host environment wholesale — including VS Code's
 * shell-integration vars (which make the shell emit OSC 633) and its live IPC
 * hooks (which let tools call back into the workbench). Direct mode already
 * strips these (ptyManager cleanEnv); the daemon path did not. These tests pin
 * the shared sanitization predicate so both paths can present identically as
 * alterminal, and so the "measure first" diagnostic can report exactly what
 * leaks.
 */
suite("envSanitizer", () => {
  suite("isVscodeInjectedEnvKey", () => {
    test("VSCODE_* keys are injected", () => {
      assert.ok(isVscodeInjectedEnvKey("VSCODE_PID", "123"));
      assert.ok(isVscodeInjectedEnvKey("VSCODE_IPC_HOOK_CLI", "/tmp/x.sock"));
      assert.ok(isVscodeInjectedEnvKey("VSCODE_SHELL_INTEGRATION", "1"));
      assert.ok(isVscodeInjectedEnvKey("VSCODE_GIT_IPC_HANDLE", "/tmp/g"));
      assert.ok(isVscodeInjectedEnvKey("VSCODE_NONCE", "abc"));
    });

    test("ELECTRON_* keys are injected", () => {
      assert.ok(isVscodeInjectedEnvKey("ELECTRON_RUN_AS_NODE", "1"));
    });

    test("GIT_ASKPASS / SSH_ASKPASS pointing at VS Code are injected", () => {
      assert.ok(isVscodeInjectedEnvKey("GIT_ASKPASS", "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/git/dist/askpass.sh"));
      assert.ok(isVscodeInjectedEnvKey("SSH_ASKPASS", "/usr/share/code/resources/app/out/askpass.sh"));
    });

    test("a non-VS-Code askpass is NOT injected", () => {
      assert.strictEqual(isVscodeInjectedEnvKey("GIT_ASKPASS", "/usr/local/bin/askpass"), false);
      assert.strictEqual(isVscodeInjectedEnvKey("SSH_ASKPASS", "/usr/lib/ssh/x11-ssh-askpass"), false);
    });

    test("ordinary keys are not injected (TERM_PROGRAM is overridden, not stripped)", () => {
      assert.strictEqual(isVscodeInjectedEnvKey("PATH", "/usr/bin"), false);
      assert.strictEqual(isVscodeInjectedEnvKey("HOME", "/Users/x"), false);
      assert.strictEqual(isVscodeInjectedEnvKey("TERM_PROGRAM", "vscode"), false);
    });
  });

  suite("listVscodeInjectedEnv", () => {
    test("returns the sorted leaked keys present in an env", () => {
      const env = {
        PATH: "/usr/bin",
        VSCODE_PID: "1",
        VSCODE_NONCE: "abc",
        HOME: "/h",
        GIT_ASKPASS: "/x/Code/a",
      };
      assert.deepStrictEqual(listVscodeInjectedEnv(env), ["GIT_ASKPASS", "VSCODE_NONCE", "VSCODE_PID"]);
    });

    test("returns [] for a clean env", () => {
      assert.deepStrictEqual(listVscodeInjectedEnv({ PATH: "/usr/bin", HOME: "/h" }), []);
    });

    test("ignores undefined values", () => {
      assert.deepStrictEqual(listVscodeInjectedEnv({ VSCODE_PID: undefined, PATH: "/b" }), []);
    });
  });

  suite("sanitizeSpawnEnv", () => {
    test("drops injected keys, keeps the rest", () => {
      const env = { PATH: "/usr/bin", VSCODE_PID: "1", HOME: "/h", ELECTRON_RUN_AS_NODE: "1" };
      assert.deepStrictEqual(sanitizeSpawnEnv(env), { PATH: "/usr/bin", HOME: "/h" });
    });

    test("drops undefined values", () => {
      assert.deepStrictEqual(sanitizeSpawnEnv({ A: "1", B: undefined }), { A: "1" });
    });

    test("keeps a non-VS-Code askpass while dropping VSCODE_*", () => {
      const env = { GIT_ASKPASS: "/usr/bin/ask", VSCODE_NONCE: "x" };
      assert.deepStrictEqual(sanitizeSpawnEnv(env), { GIT_ASKPASS: "/usr/bin/ask" });
    });
  });
});
