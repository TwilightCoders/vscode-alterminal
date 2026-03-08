import * as assert from "assert";
import * as vscode from "vscode";
import { CommandManager } from "../../src/utils/commandManager";

/**
 * Helper to create a mock VSCodeAPI for CommandManager tests.
 * Stores saved commands in memory and stubs all UI interactions.
 */
function createMockVSCodeAPI(savedCommands: any[] = []) {
  const stored = { "alterminal.savedCommands": savedCommands };
  return {
    getConfiguration: (_section: string) => ({
      get: <T>(key: string, defaultValue: T): T => {
        const fullKey = key;
        return (stored as any)[`alterminal.${fullKey}`] ?? defaultValue;
      },
      update: async (key: string, value: any, _target: any) => {
        (stored as any)[`alterminal.${key}`] = value;
      },
    }),
    window: vscode.window,
    commands: vscode.commands,
  };
}

suite("CommandManager Test Suite", () => {
  test("launchSavedCommand should match by command string", async () => {
    const launched: { command: string; cwd?: string }[] = [];
    const api = createMockVSCodeAPI([
      { command: "echo hello", label: "Hello", count: 1, lastUsed: new Date().toISOString() },
    ]);
    const cm = new CommandManager(api as any, (cmd, cwd) => {
      launched.push({ command: cmd, cwd });
    });
    await cm.loadSavedCommands();

    await cm.launchSavedCommand("echo hello");

    assert.strictEqual(launched.length, 1);
    assert.strictEqual(launched[0].command, "echo hello");
    assert.strictEqual(launched[0].cwd, undefined);
  });

  test("launchSavedCommand should disambiguate by label when commands share the same string", async () => {
    const launched: { command: string; cwd?: string }[] = [];
    const api = createMockVSCodeAPI([
      { command: "run-tool", label: "Tool (workspace)", count: 3, lastUsed: new Date().toISOString() },
      { command: "run-tool", label: "Tool (subfolder)", count: 0, lastUsed: new Date().toISOString(), cwd: "/some/path" },
    ]);
    const cm = new CommandManager(api as any, (cmd, cwd) => {
      launched.push({ command: cmd, cwd });
    });
    await cm.loadSavedCommands();

    // Without label — falls back to first match (no cwd)
    await cm.launchSavedCommand("run-tool");
    assert.strictEqual(launched.length, 1);
    assert.strictEqual(launched[0].cwd, undefined);

    // With label matching second entry — should get its cwd
    launched.length = 0;
    await cm.launchSavedCommand("run-tool", "Tool (subfolder)");
    assert.strictEqual(launched.length, 1);
    assert.strictEqual(launched[0].cwd, "/some/path");

    // With label matching first entry — no cwd
    launched.length = 0;
    await cm.launchSavedCommand("run-tool", "Tool (workspace)");
    assert.strictEqual(launched.length, 1);
    assert.strictEqual(launched[0].cwd, undefined);
  });

  test("launchSavedCommand should fall back to command-only match when label doesn't match", async () => {
    const launched: { command: string; cwd?: string }[] = [];
    const api = createMockVSCodeAPI([
      { command: "deploy", label: "Deploy Prod", count: 1, lastUsed: new Date().toISOString(), cwd: "/prod" },
    ]);
    const cm = new CommandManager(api as any, (cmd, cwd) => {
      launched.push({ command: cmd, cwd });
    });
    await cm.loadSavedCommands();

    // Label doesn't match, but command does — should still launch
    await cm.launchSavedCommand("deploy", "Nonexistent Label");
    assert.strictEqual(launched.length, 1);
    assert.strictEqual(launched[0].cwd, "/prod");
  });

  test("generateLabel should produce smart labels", () => {
    const api = createMockVSCodeAPI();
    const cm = new CommandManager(api as any, () => {});

    assert.strictEqual(cm.generateLabel("npm run dev"), "NPM: run dev");
    assert.strictEqual(cm.generateLabel("python -m pytest"), "Python: pytest");
    assert.strictEqual(cm.generateLabel("node server.js"), "Node: server.js");
    assert.match(cm.generateLabel("some-long-command --with flags"), /some-long-command/);
  });

  test("saveCommand should not duplicate existing commands", async () => {
    const api = createMockVSCodeAPI([
      { command: "echo hi", label: "Hi", count: 2, lastUsed: "2025-01-01T00:00:00.000Z" },
    ]);
    const cm = new CommandManager(api as any, () => {});
    await cm.loadSavedCommands();

    await cm.saveCommand("echo hi", "Updated Label");
    const commands = cm.getSavedCommands();

    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0].label, "Updated Label");
    assert.strictEqual(commands[0].count, 2); // count not changed by saveCommand
  });

  test("saveCommand should add cwd to new commands", async () => {
    const api = createMockVSCodeAPI([]);
    const cm = new CommandManager(api as any, () => {});
    await cm.loadSavedCommands();

    await cm.saveCommand("run-tool", "My Tool", "/custom/path");
    const commands = cm.getSavedCommands();

    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0].cwd, "/custom/path");
  });

  test("getSavedCommands should sort by usage and recency", async () => {
    const api = createMockVSCodeAPI([
      { command: "rarely", label: "Rare", count: 1, lastUsed: "2025-01-01T00:00:00.000Z" },
      { command: "often", label: "Often", count: 10, lastUsed: "2025-06-01T00:00:00.000Z" },
      { command: "recent", label: "Recent", count: 1, lastUsed: "2025-12-01T00:00:00.000Z" },
    ]);
    const cm = new CommandManager(api as any, () => {});
    await cm.loadSavedCommands();

    const sorted = cm.getSavedCommands();
    assert.strictEqual(sorted[0].command, "often"); // highest count wins
  });
});
