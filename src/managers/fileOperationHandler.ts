import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PtyManager } from "../terminal/ptyManager";
import { ClipboardBridge } from "../terminal/clipboardBridge";
import { Logger } from "../utils/logger";

// Process names that intercept Ctrl-V at the application layer and read
// the system clipboard directly (i.e. understand rich paste, including
// images). For these, drag-drop of an image routes through the clipboard
// bridge so the bytes actually reach the app's context.
const RICH_PASTE_APPS = /^(claude|claude-code|aider)$/i;

// Process names where we positively want path injection instead of the
// clipboard bridge — typing a quoted path is the natural drag-drop UX in
// a shell, and Ctrl-V there would just be "literal next character."
const KNOWN_SHELLS = /^(bash|zsh|fish|sh|dash|ksh|tcsh|csh|pwsh|powershell|cmd)$/i;

const CTRL_V = "\x16";

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
   * Two routes:
   *
   * 1. **Clipboard bridge** — when the dropped file is an image AND the
   *    foreground process is a known rich-paste app (Claude Code, etc.),
   *    stage the image on the system clipboard and type Ctrl-V into the
   *    PTY. The app intercepts the keystroke, reads the clipboard
   *    directly via OS APIs, and gets the actual bytes. Same end-result
   *    as the user pressing Ctrl-V manually after copying the image.
   *    Clipboard is restored ~300ms later.
   *
   * 2. **Path injection** — for everything else (text files, shells,
   *    vim, anything that doesn't speak rich paste), write the bytes to
   *    /tmp and type the path. The receiving program reads the file
   *    itself if it understands paths.
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

      const isImage = fileType.startsWith("image/");
      const fgProcess = this.ptyManager.getProcessName(tabId) ?? "";
      // Take the clipboard bridge when:
      //   - The foreground process is a known rich-paste app, OR
      //   - The foreground process is unknown (daemon mode doesn't surface
      //     it; "I dropped an image" is a strong intent signal anyway).
      // Skip when we positively know we're in a shell — path injection is
      // the expected behavior there.
      const fgIsRichPaste = RICH_PASTE_APPS.test(fgProcess);
      const fgIsKnownShell = KNOWN_SHELLS.test(fgProcess);
      const useBridge = isImage && process.platform === "darwin"
        && (fgIsRichPaste || !fgIsKnownShell);

      if (useBridge) {
        Logger.debug(`[drop] tab=${tabId} → clipboard bridge (fg="${fgProcess}")`);
        await this.pasteImageViaClipboard(tabId, fileName, fileData);
        return;
      }

      await this.ptyManager.sendFileData(fileData, fileName, fileType, tabId);
    } catch (error) {
      Logger.error("Failed to handle dropped file:", error);
    }
  }

  /**
   * Stage an image on the macOS clipboard, send Ctrl-V to the PTY, and
   * restore the previous clipboard. Used when the running app reads the
   * clipboard on Ctrl-V (Claude Code, etc.) so dropped images flow into
   * the app's rich context instead of as a typed file path.
   */
  private async pasteImageViaClipboard(
    tabId: number,
    fileName: string,
    fileData: string,
  ): Promise<void> {
    const buffer = decodeFileData(fileData);
    const safeName = path
      .basename(fileName)
      .replace(/[\s/\\'"`$()<>|;&*?!]+/g, "_") || "drop.png";
    const tempPath = path.join(os.tmpdir(), `alterminal-clip-${Date.now()}-${safeName}`);

    await fs.promises.writeFile(tempPath, buffer);
    await fs.promises.chmod(tempPath, 0o644);

    try {
      await ClipboardBridge.pasteImage(tempPath, () => {
        this.ptyManager.writeToPty(CTRL_V, tabId);
      });
    } finally {
      // Give the receiving app time to read clipboard + copy bytes
      // into its own cache before the tmp file disappears.
      setTimeout(() => {
        fs.promises.unlink(tempPath).catch(() => {});
      }, 5_000);
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

function decodeFileData(fileData: string): Buffer {
  if (fileData.startsWith("data:")) {
    // "data:image/png;base64,iVBOR..." — strip the header, decode payload.
    const base64 = fileData.split(",")[1] ?? "";
    return Buffer.from(base64, "base64");
  }
  return Buffer.from(fileData, "utf8");
}
