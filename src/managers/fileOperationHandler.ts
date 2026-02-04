import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { PtyManager } from "../terminal/ptyManager";
import { Logger } from "../utils/logger";

/**
 * FileOperationHandler
 *
 * Responsibility: Handle file drops, path resolution, and file/URL opening
 *
 * SOLID Principles:
 * - Single Responsibility: Only handles file and URL operations
 * - Open/Closed: Can add new file types without changing core logic
 * - Dependency Inversion: Depends on PtyManager abstraction
 */
export class FileOperationHandler {
  constructor(
    private readonly ptyManager: PtyManager,
  ) {}

  /**
   * Send file path to PTY
   */
  public sendFilePath(tabId: number, filePath: string): void {
    this.ptyManager.sendFilePath(filePath, tabId);
  }

  /**
   * Handle dropped file from webview
   */
  public async handleDroppedFile(
    tabId: number,
    fileName: string,
    fileType: string,
    fileSize: number,
    fileData: string,
  ): Promise<void> {
    try {
      // Route file operations to PtyManager
      if (fileData) {
        await this.ptyManager.sendFileData(fileData, fileName, fileType, tabId);
      } else {
        this.ptyManager.writeToPty(`Failed to read file: ${fileName}\n`, tabId);
      }
    } catch (error) {
      Logger.error("Failed to handle dropped file:", error);
    }
  }

  /**
   * Handle file open request from webview
   */
  public async handleOpenFile(filePath: string, terminalId: number): Promise<void> {
    try {
      Logger.debug(`🔗 Opening file: ${filePath} from terminal ${terminalId}`);

      // Resolve the file path
      const resolvedPath = await this.resolveFilePath(filePath);

      if (!resolvedPath) {
        Logger.warn(`Could not resolve file path: ${filePath}`);
        return;
      }

      // Check if path exists
      if (!fs.existsSync(resolvedPath)) {
        Logger.warn(`File does not exist: ${resolvedPath}`);
        vscode.window.showWarningMessage(`File not found: ${path.basename(resolvedPath)}`);
        return;
      }

      // Check if it's a directory
      const stats = fs.statSync(resolvedPath);
      if (stats.isDirectory()) {
        // Open directory in explorer
        await vscode.commands.executeCommand(
          "revealInExplorer",
          vscode.Uri.file(resolvedPath),
        );
        Logger.debug(`📁 Opened directory in explorer: ${resolvedPath}`);
      } else {
        // Open file in editor
        const document = await vscode.workspace.openTextDocument(resolvedPath);
        await vscode.window.showTextDocument(document);
        Logger.debug(`📄 Opened file in editor: ${resolvedPath}`);
      }
    } catch (error) {
      Logger.error("Failed to open file:", error);
      vscode.window.showErrorMessage(`Failed to open: ${path.basename(filePath)}`);
    }
  }

  /**
   * Handle URL open request from webview
   */
  public async handleOpenUrl(url: string): Promise<void> {
    try {
      await vscode.env.openExternal(vscode.Uri.parse(url));
      Logger.debug(`🌐 Opened URL: ${url}`);
    } catch (error) {
      Logger.error("Failed to open URL:", error);
      vscode.window.showErrorMessage(`Failed to open URL: ${url}`);
    }
  }

  /**
   * Resolve file path with workspace context
   */
  private async resolveFilePath(filePath: string): Promise<string | null> {
    // If absolute path, use as-is
    if (path.isAbsolute(filePath)) {
      return filePath;
    }

    // If starts with ~, expand home directory
    if (filePath.startsWith("~")) {
      const homeDir = process.env.HOME || process.env.USERPROFILE;
      if (homeDir) {
        return path.join(homeDir, filePath.substring(1));
      }
    }

    // Try relative to workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      for (const folder of workspaceFolders) {
        const resolvedPath = path.join(folder.uri.fsPath, filePath);
        if (fs.existsSync(resolvedPath)) {
          return resolvedPath;
        }
      }

      // If not found in any workspace folder, use first one as base
      return path.join(workspaceFolders[0].uri.fsPath, filePath);
    }

    // No workspace, can't resolve relative path
    Logger.warn(`Cannot resolve relative path without workspace: ${filePath}`);
    return null;
  }
}
