import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { PtyManager } from "../terminal/ptyManager";
import { Logger } from "../utils/logger";

// Bracketed paste markers. Claude Code's paste handler splits the
// pasted text on whitespace-before-absolute-path (regex `/ (?=\/|[A-Za-z]:\\)/`),
// tests each token against `/\.(png|jpe?g|gif|webp)$/i`, and if it
// resolves to a readable file, reads the bytes and attaches as an image
// — producing the `[Image #N]` placeholder. Sending the raw bytes does
// NOT trigger this; only a real on-disk path does.
const BRACKET_PASTE_START = "\x1b[200~";
const BRACKET_PASTE_END = "\x1b[201~";

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
   * Handle dropped file from webview.
   *
   * Images: write to tempfile and inject the absolute path inside a
   * bracketed paste. Claude Code's paste handler detects image-extension
   * paths inside paste blocks and attaches the file natively (the
   * `[Image #N]` flow). The path must be naked (no quotes) and start
   * with `/` (or a Windows drive letter) because of Claude's split
   * regex `/ (?=\/|[A-Za-z]:\\)/`. Other terminal apps simply see the
   * path text and do whatever they normally would.
   *
   * Non-images: write to tempfile and type the quoted path. Shell and
   * editor consumers handle it.
   */
  public async handleDroppedFile(
    tabId: number,
    fileName: string,
    fileType: string,
    _fileSize: number,
    fileData: string,
  ): Promise<void> {
    try {
      if (!fileData) {
        this.ptyManager.writeToPty(`Failed to read file: ${fileName}\n`, tabId);
        return;
      }

      if (fileType.startsWith("image/")) {
        const tmpPath = await this.ptyManager.writeDroppedFileToTemp(fileData, fileName);
        const payload = `${BRACKET_PASTE_START}${tmpPath}${BRACKET_PASTE_END}`;
        Logger.debug(`[drop] tab=${tabId} → bracketed path ${tmpPath}`);
        this.ptyManager.writeToPty(payload, tabId);
        return;
      }

      await this.ptyManager.sendFileData(fileData, fileName, fileType, tabId);
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
