import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { CommandManager } from "../utils/commandManager";
import { Logger } from "../utils/logger";

/**
 * TabContextMenuHandler
 *
 * Responsibility: Handle tab context menu actions
 *
 * SOLID Principles:
 * - Single Responsibility: Only handles tab context menu operations
 * - Open/Closed: Can add new menu actions without changing existing
 * - Dependency Inversion: Depends on CommandManager abstraction
 */
export class TabContextMenuHandler {
  private pendingBufferRequests = new Map<number, (buffer: string) => void>();

  constructor(
    private readonly commandManager: CommandManager,
    private readonly getWebview: () => vscode.Webview | undefined,
  ) {}

  /**
   * Handle context menu command from webview
   */
  public async handleContextMenuCommand(command: string, args: any): Promise<void> {
    switch (command) {
      case "saveTabCommand":
        await this.handleSaveCommand(args);
        break;
      case "renameTab":
        await this.handleRenameTab(args);
        break;
      case "closeTab":
        this.handleCloseTab(args);
        break;
      case "showTabBuffer":
        await this.handleShowTabBuffer(args);
        break;
      case "setTabIcon":
        await this.handleSetTabIcon(args);
        break;
      default:
        Logger.warn(`Unknown context menu command: ${command}`);
    }
  }

  /**
   * Handle buffer content response from webview
   */
  public handleBufferContentResponse(tabId: number, buffer: string): void {
    const resolver = this.pendingBufferRequests.get(tabId);
    if (resolver) {
      this.pendingBufferRequests.delete(tabId);
      resolver(buffer || "");
    }
  }

  /**
   * Save command from tab to quick launch
   */
  private async handleSaveCommand(args: any): Promise<void> {
    try {
      const tabId = args?.tabId;
      const launchCommand = args?.launchCommand;

      if (!launchCommand) {
        Logger.warn(
          "Cannot save command: no launchCommand provided in context",
        );
        vscode.window.showErrorMessage("No command to save");
        return;
      }

      await this.commandManager.saveCommand(launchCommand);
      vscode.window.showInformationMessage(
        `Command "${launchCommand}" saved to quick launch menu!`,
      );
      Logger.info(
        `Context menu - Command saved from tab ${tabId}: ${launchCommand}`,
      );
    } catch (error) {
      Logger.error("Failed to save command from context menu:", error);
      vscode.window.showErrorMessage(
        "Failed to save command. Please try again.",
      );
    }
  }

  /**
   * Start inline rename for a tab
   */
  private async handleRenameTab(args: any): Promise<void> {
    try {
      const tabId = args?.tabId;

      if (!tabId) {
        Logger.warn("Cannot rename tab: no tab ID provided");
        vscode.window.showErrorMessage("No tab selected");
        return;
      }

      const webview = this.getWebview();
      if (webview) {
        // Send rename command to webview to start inline editing
        webview.postMessage({
          command: "renameTab",
          tabId: parseInt(tabId),
        });

        Logger.info(`Context menu - Starting inline rename for tab ${tabId}`);
      }
    } catch (error) {
      Logger.error("Failed to start tab rename from context menu:", error);
      vscode.window.showErrorMessage(
        "Failed to start tab rename. Please try again.",
      );
    }
  }

  /**
   * Close a tab via context menu
   */
  private handleCloseTab(args: any): void {
    try {
      const tabId = args?.tabId;

      if (!tabId) {
        Logger.warn("Cannot close tab: no tab ID provided");
        vscode.window.showErrorMessage("No tab selected");
        return;
      }

      const webview = this.getWebview();
      if (webview) {
        // Send close command to webview
        webview.postMessage({
          command: "closeTab",
          tabId: parseInt(tabId),
        });

        Logger.info(`Context menu - Closed tab ${tabId}`);
      }
    } catch (error) {
      Logger.error("Failed to close tab from context menu:", error);
      vscode.window.showErrorMessage("Failed to close tab. Please try again.");
    }
  }

  /**
   * Show tab buffer in new document
   */
  private async handleShowTabBuffer(args: any): Promise<void> {
    try {
      const tabId = args?.tabId;

      if (!tabId) {
        Logger.warn("Cannot show buffer: no tab ID provided");
        vscode.window.showErrorMessage("No tab selected");
        return;
      }

      const webview = this.getWebview();
      if (!webview) {
        vscode.window.showErrorMessage("Alterminal view not available");
        return;
      }

      const tabIdNum = parseInt(tabId);

      // Set up Promise to wait for response
      const bufferPromise = new Promise<string>((resolve, reject) => {
        this.pendingBufferRequests.set(tabIdNum, resolve);

        // Timeout after 5 seconds
        setTimeout(() => {
          if (this.pendingBufferRequests.has(tabIdNum)) {
            this.pendingBufferRequests.delete(tabIdNum);
            reject(new Error("Timeout"));
          }
        }, 5000);
      });

      // Send request to webview
      webview.postMessage({
        command: "getTabBuffer",
        tabId: tabIdNum,
      });

      // Wait for response
      let content: string;
      try {
        content = await bufferPromise;
        if (!content) {
          content = "(Empty buffer)";
        }
      } catch (error) {
        vscode.window.showErrorMessage("Failed to get buffer content - timeout");
        return;
      }

      // Write to temporary file
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const tempFile = path.join(os.tmpdir(), `alterminal-tab-${tabId}-buffer-${timestamp}.txt`);
      fs.writeFileSync(tempFile, content, "utf8");

      // Open the file
      const doc = await vscode.workspace.openTextDocument(tempFile);
      await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: vscode.ViewColumn.Active,
      });

      Logger.info(`Opened buffer for tab ${tabId}`);
    } catch (error) {
      Logger.error("Failed to show tab buffer:", error);
      vscode.window.showErrorMessage(
        "Failed to show tab buffer. Please try again.",
      );
    }
  }

  /**
   * Show icon picker and set tab icon
   */
  private async handleSetTabIcon(args: any): Promise<void> {
    try {
      const tabId = args?.tabId;

      if (!tabId) {
        Logger.warn("Cannot set icon: no tab ID provided");
        vscode.window.showErrorMessage("No tab selected");
        return;
      }

      // Common codicons for terminals
      const iconOptions = [
        { label: "$(terminal)", description: "Terminal" },
        { label: "$(console)", description: "Console" },
        { label: "$(server)", description: "Server" },
        { label: "$(database)", description: "Database" },
        { label: "$(tools)", description: "Tools" },
        { label: "$(play)", description: "Run/Build" },
        { label: "$(bug)", description: "Debug" },
        { label: "$(gear)", description: "Settings" },
        { label: "$(rocket)", description: "Deploy" },
        { label: "$(beaker)", description: "Test" },
        { label: "$(package)", description: "Package" },
        { label: "$(pulse)", description: "Watch" },
      ];

      const selected = await vscode.window.showQuickPick(iconOptions, {
        placeHolder: "Select an icon for this tab",
        matchOnDescription: true,
      });

      if (!selected) {
        return;
      }

      const webview = this.getWebview();
      if (webview) {
        // Send icon update to webview
        webview.postMessage({
          command: "setTabIcon",
          tabId: parseInt(tabId),
          icon: selected.label,
        });

        Logger.info(`Set icon for tab ${tabId} to ${selected.label}`);
      }
    } catch (error) {
      Logger.error("Failed to set tab icon:", error);
      vscode.window.showErrorMessage(
        "Failed to set tab icon. Please try again.",
      );
    }
  }
}
