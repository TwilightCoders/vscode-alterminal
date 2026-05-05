import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { AlterminalProvider } from "./alterminalProvider";
import { PtyManager } from "./terminal/ptyManager";
import { Logger } from "./utils/logger";
import { WebviewViewSerializer } from "./serialization/webviewViewSerializer";
import { MessageDispatcher } from "./managers/messageDispatcher";
import { DaemonManager } from "./daemon/daemonManager";
import { SettingsEditor } from "./managers/settingsEditor";

export async function activate(context: vscode.ExtensionContext) {
  // Determine dev mode - enable for development, NODE_ENV, or preview versions
  const packageJson = require('../package.json');
  const isDebugMode =
    context.extensionMode === vscode.ExtensionMode.Development ||
    process.env.NODE_ENV === "development" ||
    packageJson.preview === true;

  // Configure logger before any further logging
  Logger.configure(isDebugMode);

  Logger.info("🚀 Alterminal extension is now active!");
  if (isDebugMode) {
    const reason = context.extensionMode === vscode.ExtensionMode.Development ? "Development mode" :
                   process.env.NODE_ENV === "development" ? "NODE_ENV=development" :
                   packageJson.preview === true ? "Preview extension" : "Unknown";
    Logger.info(`🔧 Debug mode enabled (${reason})`);
  }

  // Set debug mode context for conditional UI
  vscode.commands.executeCommand(
    "setContext",
    "alterminal.debugMode",
    isDebugMode,
  );

  // Register window title variables. Users can add these to their
  // window.title setting:
  //   ${bell}   — bell icon + unread count across background tabs
  //   ${remote} — "SSH", "WSL", "TUNNEL", "CODESPACES", ..., or "LOCAL"
  MessageDispatcher.registerTitleVariable();
  registerRemoteTitleVariable();

  // Create shared PtyManager - will be used by AlterminalProvider
  const ptyManager = new PtyManager();
  ptyManager.setExtensionVersion(packageJson.version || "0.0.0");
  ptyManager.setExtensionPath(context.extensionUri.fsPath);

  // PTY Daemon: persistent PTY processes that survive window reloads.
  // Awaited so daemon is ready before webview restore triggers createPty.
  const daemonEnabled = vscode.workspace.getConfiguration("alterminal").get<boolean>("ptyDaemon.enabled", false);
  Logger.info(`[daemon] ptyDaemon.enabled = ${daemonEnabled}`);
  if (daemonEnabled) {
    const daemonManager = new DaemonManager(context, context.extensionUri.fsPath);
    _daemonManager = daemonManager;
    try {
      Logger.info("[daemon] Attempting daemon connection...");
      const client = await daemonManager.connect();
      if (client) {
        Logger.info(`[daemon] Connected, sessionId=${daemonManager.sessionId}`);
        ptyManager.setDaemonClient(client);
        // Wait for the live PTY list before webview restore, so we can
        // skip buffer restore for terminals that will reattach to daemon.
        await ptyManager.daemonListReady;
        Logger.info("[daemon] PTY daemon mode active");
      } else {
        Logger.info("[daemon] PTY daemon unavailable, using direct mode");
      }
    } catch (err) {
      Logger.error("PTY daemon connection failed:", err);
    }
  }

  // Create serializer to manage persisted state
  const serializer = new WebviewViewSerializer(context);

  const provider = new AlterminalProvider(
    context.extensionUri,
    context,
    ptyManager,
    serializer,
  );

  // Tell state manager which terminals have live daemon PTYs (skip their buffers)
  if (ptyManager.liveDaemonPtyIds.size > 0) {
    const sm = provider.getStateManager();
    for (const uuid of ptyManager.liveDaemonPtyIds) {
      sm.skipBufferUuids.add(uuid);
    }
    Logger.info(`[daemon] Skipping buffer restore for ${ptyManager.liveDaemonPtyIds.size} live daemon PTY(s)`);
  }

  const disposable = vscode.window.registerWebviewViewProvider(
    AlterminalProvider.viewType,
    provider,
    {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }
  );

  context.subscriptions.push(disposable, provider);

  // Create status bar item
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    1000,
  );
  let devBuildNumber = 0;
  if (isDebugMode) {
    try { devBuildNumber = require('./generated/buildInfo').DEV_BUILD_NUMBER || 0; } catch {}
  }
  statusBarItem.text = isDebugMode
    ? `$(terminal) Alterminal dev.${devBuildNumber}`
    : "$(terminal) Alterminal";
  statusBarItem.tooltip = "Open Alterminal";
  statusBarItem.command = "alterminal.openTerminal";
  statusBarItem.backgroundColor = new vscode.ThemeColor(
    "statusBarItem.prominentBackground",
  );
  statusBarItem.show();

  context.subscriptions.push(
    statusBarItem,
    vscode.commands.registerCommand("alterminal.refresh", () => {
      provider.refresh();
    }),
    vscode.commands.registerCommand(
      "alterminal.clearWorkspaceState",
      async () => {
        // Clear all alterminal keys (metadata + buffer keys)
        const allKeys = context.workspaceState.keys();
        for (const key of allKeys) {
          if (key.startsWith("alterminal.")) {
            await context.workspaceState.update(key, undefined);
          }
        }
        vscode.window.showInformationMessage(
          "Alterminal workspace state cleared",
        );
      },
    ),
    vscode.commands.registerCommand("alterminal.newTab", () => {
      provider.createNewTab();
    }),
    vscode.commands.registerCommand("alterminal.newTerminal.default", () => {
      provider.createNewTab("default");
    }),
    vscode.commands.registerCommand("alterminal.newTerminal.shell", () => {
      provider.createNewTab("shell");
    }),
    vscode.commands.registerCommand(
      "alterminal.newTerminal.command",
      async () => {
        await provider.launchCommandPicker();
      },
    ),
    vscode.commands.registerCommand("alterminal.openTerminal", async () => {
      await provider.openTerminal();
    }),
    vscode.commands.registerCommand("alterminal.focus", () => {
      vscode.commands.executeCommand(
        "alterminalView.focus",
      );
    }),
    vscode.commands.registerCommand("alterminal.openSettings", () => {
      _settingsEditor.open();
    }),
    vscode.commands.registerCommand("alterminal.restartDaemon", async () => {
      if (!_daemonManager) {
        vscode.window.showWarningMessage("PTY daemon is not enabled");
        return;
      }
      const client = await _daemonManager.restart();
      if (client) {
        ptyManager.setDaemonClient(client);
        vscode.window.showInformationMessage("PTY daemon restarted — shells preserved");
      } else {
        vscode.window.showErrorMessage("Failed to restart PTY daemon");
      }
    }),
    vscode.commands.registerCommand("alterminal.debugState", async () => {
      const metadata = provider.getStateManager().getMetadata();

      let content: string;
      if (!metadata) {
        content = "// No saved workspace state found";
      } else {
        // Strip any lingering buffer fields (pre-migration state)
        const clean = {
          ...metadata,
          terminals: metadata.terminals?.map((t: any) => {
            const { buffer, ...meta } = t;
            return meta;
          }),
        };
        content = JSON.stringify(clean, null, 2);
      }

      // Write to temporary file and open it
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const tempFile = path.join(os.tmpdir(), `alterminal-state-${timestamp}.json`);
      fs.writeFileSync(tempFile, content, "utf8");

      const doc = await vscode.workspace.openTextDocument(tempFile);
      await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Active });

      // Watch for saves — apply edits back live (like git rebase -i)
      const watcher = vscode.workspace.onDidSaveTextDocument((savedDoc) => {
        if (savedDoc.uri.fsPath !== tempFile) return;
        try {
          const edited = JSON.parse(savedDoc.getText());
          if (!edited?.terminals?.length) {
            vscode.window.showWarningMessage("Alterminal: Invalid state — must have at least one terminal.");
            return;
          }
          provider.applyEditedMetadata(edited);
          vscode.window.showInformationMessage("Alterminal: State applied.");
        } catch (e: any) {
          vscode.window.showErrorMessage(`Alterminal: Failed to parse — ${e.message}`);
        }
      });

      // Clean up when the document is closed
      const closeWatcher = vscode.workspace.onDidCloseTextDocument((closedDoc) => {
        if (closedDoc.uri.fsPath !== tempFile) return;
        watcher.dispose();
        closeWatcher.dispose();
        try { fs.unlinkSync(tempFile); } catch {}
      });

      context.subscriptions.push(watcher, closeWatcher);
    }),
    vscode.commands.registerCommand("alterminal.setDebugFilter", async () => {
      const filterOptions = [
        {
          label: "📁 Files Only",
          description: "Show only file cache logs",
          value: ["📁"],
        },
        {
          label: "🔗 Links Only",
          description: "Show only link detection logs",
          value: ["🔗"],
        },
        {
          label: "⚡ Terminal Only",
          description: "Show only terminal event logs",
          value: ["⚡"],
        },
        {
          label: "🚀 Initialization Only",
          description: "Show only startup logs",
          value: ["🚀"],
        },
        {
          label: "📁 🔗 Files + Links",
          description: "Show file and link logs",
          value: ["📁", "🔗"],
        },
        {
          label: "🔧 Troubleshoot Mode",
          description: "Show force debug logs only",
          value: ["🔧"],
        },
        {
          label: "Clear Filter",
          description: "Show all debug logs",
          value: null,
        },
      ];

      const selected = await vscode.window.showQuickPick(filterOptions, {
        placeHolder: "Select debug filter",
        matchOnDescription: true,
      });

      if (selected) {
        provider.setDebugFilter(selected.value);
        const filterText = selected.value
          ? selected.value.join(" ")
          : "cleared";
        vscode.window.showInformationMessage(`Debug filter ${filterText}`);
      }
    }),
    vscode.commands.registerCommand("alterminal.clearDebugFilter", () => {
      provider.setDebugFilter(null);
      vscode.window.showInformationMessage(
        "Debug filter cleared - showing all logs",
      );
    }),
    vscode.commands.registerCommand(
      "alterminal.performanceReport",
      async () => {
        await provider.requestPerformanceReport();
      },
    ),
    vscode.commands.registerCommand(
      "alterminal.showSavedCommands",
      async () => {
        // Backwards compatibility: reuse unified picker
        await provider.launchCommandPicker();
      },
    ),
    vscode.commands.registerCommand(
      "alterminal.saveCurrentCommand",
      async () => {
        await provider.saveCurrentCommand();
      },
    ),
    vscode.commands.registerCommand("alterminal.saveTabCommand", (args) => {
      provider.handleContextMenuCommand("saveTabCommand", args);
    }),
    vscode.commands.registerCommand("alterminal.renameTab", (args) => {
      provider.handleContextMenuCommand("renameTab", args);
    }),
    vscode.commands.registerCommand("alterminal.closeTab", (args) => {
      provider.handleContextMenuCommand("closeTab", args);
    }),
    vscode.commands.registerCommand("alterminal.showTabBuffer", (args) => {
      provider.handleContextMenuCommand("showTabBuffer", args);
    }),
    vscode.commands.registerCommand("alterminal.setTabIcon", (args) => {
      provider.handleContextMenuCommand("setTabIcon", args);
    }),
  );
}

// Module-level references for deactivate() to access
let _daemonManager: DaemonManager | null = null;
const _settingsEditor = new SettingsEditor();

export function deactivate() {
  Logger.info("Alterminal extension is being deactivated");
  if (_daemonManager) {
    _daemonManager.disconnect();
    _daemonManager = null;
  }
  Logger.dispose();
}

/**
 * Register a `${remote}` window title variable.
 *
 * Resolves to an uppercase label for the current remote context ("SSH",
 * "WSL", "CODESPACES", "TUNNEL", "DEV-CONTAINER", ...) or "LOCAL" when
 * running locally. VS Code's built-in `${remoteName}` exposes only the
 * raw authority string (e.g. "ssh-remote"), with no way to get a clean
 * label independent of `${rootName}`. We fill that gap.
 *
 * Registered unconditionally — static per window, no cost to leave on.
 */
function registerRemoteTitleVariable(): void {
  const REMOTE_CONTEXT_KEY = "alterminal:remote";
  const remoteName = vscode.env.remoteName;
  const label = remoteName
    ? remoteName.replace(/-remote$/i, "").toUpperCase()
    : "LOCAL";
  vscode.commands.executeCommand("setContext", REMOTE_CONTEXT_KEY, label);
  vscode.commands.executeCommand(
    "registerWindowTitleVariable",
    "remote",
    REMOTE_CONTEXT_KEY,
  );
}
