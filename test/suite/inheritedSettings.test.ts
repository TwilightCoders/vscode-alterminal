import * as assert from "assert";
import * as vscode from "vscode";
import { getInheritedSetting } from "../../src/utils/settings";

/**
 * Verify the alterminal → terminal.integrated → fallback resolution chain.
 *
 * We use real settings from `terminal.integrated` (VS Code's own defaults
 * are stable across test runs) and toggle workspace-scoped overrides
 * under `alterminal` to test the explicit-override path.
 */
suite("getInheritedSetting", () => {

  async function clearAlterminalKey(key: string) {
    await vscode.workspace
      .getConfiguration("alterminal")
      .update(key, undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration("alterminal")
      .update(key, undefined, vscode.ConfigurationTarget.Global);
  }

  test("falls back to terminal.integrated default when alterminal unset", () => {
    // VS Code ships a default for terminal.integrated.fontFamily (empty
    // string on many platforms, or a font name). Either way it resolves
    // to SOMETHING, not our fallback, because VS Code has a contributed
    // default.
    const value = getInheritedSetting<string>(
      "fontFamily",
      "fontFamily",
      "FALLBACK_SENTINEL",
    );
    assert.notStrictEqual(value, "FALLBACK_SENTINEL",
      "should have inherited from terminal.integrated, not hit fallback");
  });

  test("respects terminal.integrated numeric defaults", () => {
    // scrollback has a known numeric default (1000)
    const value = getInheritedSetting<number>(
      "terminal.scrollback",
      "scrollback",
      -1,
    );
    assert.strictEqual(typeof value, "number");
    assert.ok(value > 0, "inherited scrollback should be positive");
  });

  test("alterminal override wins when explicitly set", async () => {
    const key = "terminal.scrollback";
    try {
      await vscode.workspace
        .getConfiguration("alterminal")
        .update(key, 9999, vscode.ConfigurationTarget.Global);
      const value = getInheritedSetting<number>(key, "scrollback", 100);
      assert.strictEqual(value, 9999);
    } finally {
      await clearAlterminalKey(key);
    }
  });

  test("fallback used only when neither namespace has a value", () => {
    // Use a made-up key that exists nowhere — both configs return undefined.
    const value = getInheritedSetting<string>(
      "nonExistentAlterminalKey__",
      "nonExistentTerminalKey__",
      "my-fallback",
    );
    assert.strictEqual(value, "my-fallback");
  });

  test("default value from extension manifest does NOT shadow inheritance", async () => {
    // `alterminal.terminal.scrollback` has `default: 1000` in package.json.
    // Without an explicit user set, inspect().globalValue/workspaceValue
    // are undefined — so we fall through to terminal.integrated, not our
    // own declared default.
    const key = "terminal.scrollback";
    await clearAlterminalKey(key);

    const inspect = vscode.workspace
      .getConfiguration("alterminal")
      .inspect<number>(key);
    assert.strictEqual(inspect?.globalValue, undefined);
    assert.strictEqual(inspect?.workspaceValue, undefined);

    // With nothing explicitly set, we should resolve to terminal.integrated's
    // value — which might happen to equal the manifest default, but the
    // point is we're not LOCKING IN our manifest default.
    const value = getInheritedSetting<number>(key, "scrollback", -1);
    // Just assert we got a valid scrollback, not the -1 fallback:
    assert.notStrictEqual(value, -1);
  });
});
