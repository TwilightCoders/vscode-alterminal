import * as vscode from "vscode";
import { AlterminalProvider } from "./alterminalProvider";
import { PtyManager } from "./terminal/ptyManager";
import { Logger } from "./utils/logger";

export function activate(context: vscode.ExtensionContext) {
  // Determine dev mode the same way we show state debug UI (extensionMode)
  const isDebugMode =
    context.extensionMode === vscode.ExtensionMode.Development ||
    process.env.NODE_ENV === "development";

  // Configure logger before any further logging
  Logger.configure(isDebugMode);

  Logger.info("🚀 Alterminal extension is now active!");

  // Set debug mode context for conditional UI
  vscode.commands.executeCommand(
    "setContext",
    "alterminal.debugMode",
    isDebugMode,
  );


  // Create shared PtyManager - will be used by AlterminalProvider
  const ptyManager = new PtyManager();

  const provider = new AlterminalProvider(
    context.extensionUri,
    context,
    ptyManager,
  );

  Logger.debug("🔌 Registering WebviewViewProvider...");
  const disposable = vscode.window.registerWebviewViewProvider(
    AlterminalProvider.viewType,
    provider,
  );
  Logger.debug("✅ WebviewViewProvider registered");

  context.subscriptions.push(disposable);

  // Create status bar item
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    1000,
  );
  statusBarItem.text = "$(terminal) Alterminal";
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
        await context.workspaceState.update(
          "alterminal.webviewState",
          undefined,
        );
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
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "alterminal",
      );
    }),
    vscode.commands.registerCommand("alterminal.debugState", async () => {
      const savedState = context.workspaceState.get("alterminal.webviewState");
      const message = savedState
        ? `Saved workspace state: ${JSON.stringify(savedState, null, 2)}`
        : "No saved workspace state found";
      vscode.window.showInformationMessage("Debug State", {
        modal: true,
        detail: message,
      });
    }),
    vscode.commands.registerCommand("alterminal.testLinks", () => {
      provider.testLinks();
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
  );
}

export function deactivate() {
  Logger.info("🛑 Alterminal extension is being deactivated");
  Logger.debug("🧹 Cleanup complete");
}
