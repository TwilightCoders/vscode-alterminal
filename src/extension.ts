import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { AlterminalProvider } from "./alterminalProvider";
import { PtyManager } from "./terminal/ptyManager";
import { Logger } from "./utils/logger";
import { WebviewViewSerializer } from "./serialization/webviewViewSerializer";

export function activate(context: vscode.ExtensionContext) {
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


  // Create shared PtyManager - will be used by AlterminalProvider
  const ptyManager = new PtyManager();

  // Create serializer to manage persisted state
  const serializer = new WebviewViewSerializer(context);

  const provider = new AlterminalProvider(
    context.extensionUri,
    context,
    ptyManager,
    serializer,
  );

  const disposable = vscode.window.registerWebviewViewProvider(
    AlterminalProvider.viewType,
    provider,
  );

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
          "alterminal.state",
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
      const savedState = context.workspaceState.get("alterminal.state") as any;

      let content: string;
      let extension: string;
      if (!savedState) {
        content = "No saved workspace state found";
        extension = ".txt";
      } else {
        // Clone and strip buffers
        const stateWithoutBuffers = {
          ...savedState,
          terminals: savedState.terminals?.map((t: any) => ({
            ...t,
            buffer: t.buffer ? "<omitted - use 'Show Buffer' on tab>" : undefined,
          })),
        };
        content = JSON.stringify(stateWithoutBuffers, null, 2);
        extension = ".json";
      }

      // Write to temporary file
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const tempFile = path.join(os.tmpdir(), `alterminal-state-${timestamp}${extension}`);
      fs.writeFileSync(tempFile, content, "utf8");

      // Open the file
      const doc = await vscode.workspace.openTextDocument(tempFile);
      await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: vscode.ViewColumn.Active,
      });
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

export function deactivate() {
  Logger.info("🛑 Alterminal extension is being deactivated");
}
