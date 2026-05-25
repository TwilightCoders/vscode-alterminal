import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { ExtToWebviewMessage } from "../shared/messages";
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
        } satisfies ExtToWebviewMessage);

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
        } satisfies ExtToWebviewMessage);

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
      } satisfies ExtToWebviewMessage);

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

      // The picker lives in the webview now — full searchable grid of all
      // ~525 codicons instead of the old 12-item QuickPick. The webview
      // applies the chosen icon directly through its tabManager.setTabIcon
      // path, so no postMessage round-trip back to the host is needed.
      const webview = this.getWebview();
      if (webview) {
        webview.postMessage({
          command: "openIconPicker",
          tabId: parseInt(tabId),
        } satisfies ExtToWebviewMessage);
      }
    } catch (error) {
      Logger.error("Failed to open icon picker:", error);
      vscode.window.showErrorMessage(
        "Failed to open icon picker. Please try again.",
      );
    }
  }
}
