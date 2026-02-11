/**
 * PTY Process Manager
 *
 * Purpose:
 * - Factory and manager for individual PTY processes
 * - Handles shell initialization, command execution, and process lifecycle
 * - Provides clean API for PTY operations without tab management concerns
 *
 * Responsibilities:
 * - Spawn and manage individual PTY processes with proper environment
 * - Handle shell readiness detection and command execution
 * - Process file drops and convert them to appropriate terminal input
 * - Manage PTY resizing, data flow, and process cleanup
 *
 * Key Features:
 * - Automatic shell detection (bash/zsh on Unix, cmd on Windows)
 * - Smart shell readiness detection based on data flow timing
 * - Configurable auto-command execution
 * - File path handling with proper shell escaping
 * - Clean process-focused API without tab awareness
 *
 * Shell Lifecycle:
 * 1. Spawn shell with login flags and proper environment
 * 2. Monitor data flow to detect when shell is ready
 * 3. Execute configured auto-command after shell settles
 * 4. Handle ongoing I/O and resizing
 * 5. Clean up on disposal
 *
 * Notes:
 * - Uses @lydell/node-pty for cross-platform PTY support
 * - Shell readiness detection prevents commands from being lost
 * - File path escaping is crucial for shell safety
 * - Tab management is handled by TabManager, not PtyManager
 */

import * as vscode from "vscode";
import * as pty from "@lydell/node-pty";
import { Logger } from "../utils/logger";
import { Debouncer } from "../utils/debouncer";
import { TERMINAL_DEFAULTS } from "../constants";

export class PtyManager {
  private _ptyProcesses = new Map<number, pty.IPty>();
  private _processMonitorTimers = new Map<number, NodeJS.Timeout>();
  private _currentProcessNames = new Map<number, string>();
  private _terminalTypes = new Map<number, string>();
  private _currentWorkingDirs = new Map<number, string>();
  private _userVars = new Map<number, Map<string, string>>();
  private _webviewView?: vscode.WebviewView;
  private _activeTabId?: number;
  private _visibilityDisposable?: { dispose(): void };

  private _scrollback: number = 1000;
  private _expandCommand: ((cmd: string) => string) | null = null;

  // Buffer for PTY output when webview is hidden
  private _outputBuffer = new Map<number, string[]>();
  private _maxBufferSize = 10000; // Maximum lines to buffer per terminal

  // Regex patterns for escape sequences that can cause focus stealing or VS Code interference
  // OSC 633 is VS Code's shell integration protocol
  // OSC 7 is current working directory (can trigger VS Code behavior)
  // OSC 1337 is iTerm2 protocol (sometimes used by tools)
  private static readonly VSCODE_OSC_PATTERN = /\x1b\]633;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
  private static readonly CWD_OSC_PATTERN = /\x1b\]7;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
  private static readonly ITERM_OSC_PATTERN = /\x1b\]1337;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
  
  // iTerm2 SetUserVar: \x1b]1337;SetUserVar=name=base64value\x07
  private static readonly USER_VAR_PATTERN = /\x1b\]1337;SetUserVar=([A-Za-z0-9_]+)=([A-Za-z0-9+/=]*?)(?:\x07|\x1b\\)/g;

  // DEC private mode: Focus reporting (?1004h enables, ?1004l disables)
  // When enabled, terminal sends focus in/out events that VS Code may intercept
  private static readonly FOCUS_REPORTING_PATTERN = /\x1b\[\?1004[hl]/g;

  constructor() {
    // No callbacks needed - will use webview directly
  }

  /**
   * Filter out escape sequences that can cause VS Code to steal focus
   * These include VS Code shell integration sequences and focus reporting mode
   */
  private _filterVSCodeSequences(data: string): string {
    let filtered = data;
    
    // Remove VS Code shell integration sequences (OSC 633)
    filtered = filtered.replace(PtyManager.VSCODE_OSC_PATTERN, '');
    
    // Remove current working directory sequences (OSC 7)
    filtered = filtered.replace(PtyManager.CWD_OSC_PATTERN, '');
    
    // Remove iTerm2 sequences (OSC 1337)
    filtered = filtered.replace(PtyManager.ITERM_OSC_PATTERN, '');
    
    // Remove focus reporting mode enable/disable sequences
    // This prevents VS Code from intercepting focus events meant for the webview terminal
    filtered = filtered.replace(PtyManager.FOCUS_REPORTING_PATTERN, '');
    
    return filtered;
  }

  /**
   * Extract the most recent working directory from OSC 7 sequences in data
   * OSC 7 format: \x1b]7;file://hostname/path\x07
   */
  private _extractCwdFromOsc7(data: string): string | null {
    const matches = data.matchAll(PtyManager.CWD_OSC_PATTERN);
    let lastMatch: string | null = null;
    for (const m of matches) {
      lastMatch = m[0];
    }
    if (!lastMatch) return null;

    // Extract the URL from the OSC 7 sequence (between "7;" and the terminator)
    const urlStart = lastMatch.indexOf('7;') + 2;
    const urlStr = lastMatch.slice(urlStart).replace(/(\x07|\x1b\\)$/, '');
    try {
      const url = new URL(urlStr);
      return decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  }

  /**
   * Extract SetUserVar key-value pairs from OSC 1337 sequences in data
   */
  private _extractUserVars(data: string): Map<string, string> | null {
    let result: Map<string, string> | null = null;
    PtyManager.USER_VAR_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PtyManager.USER_VAR_PATTERN.exec(data)) !== null) {
      const key = match[1];
      const base64Value = match[2];
      try {
        const value = Buffer.from(base64Value, "base64").toString("utf-8");
        if (!result) result = new Map();
        result.set(key, value);
      } catch {
        // Skip invalid base64
      }
    }
    return result;
  }

  /**
   * Handle user variable changes from SetUserVar
   */
  private _handleUserVarChange(tabId: number, vars: Map<string, string>): void {
    if (!this._userVars.has(tabId)) {
      this._userVars.set(tabId, new Map());
    }
    const stored = this._userVars.get(tabId)!;
    const changed: Record<string, string> = {};
    for (const [key, value] of vars) {
      if (stored.get(key) !== value) {
        stored.set(key, value);
        changed[key] = value;
      }
    }
    if (Object.keys(changed).length > 0) {
      this._webviewView?.webview.postMessage({
        command: "userVarChange",
        vars: changed,
        tabId,
      });
    }
  }

  /**
   * Handle working directory change detected from OSC 7
   */
  private _handleCwdChange(tabId: number, cwd: string): void {
    this._currentWorkingDirs.set(tabId, cwd);
    this._webviewView?.webview.postMessage({
      command: "cwdChange",
      cwd,
      tabId,
    });
  }

  public setCommandExpander(fn: (cmd: string) => string) {
    this._expandCommand = fn;
  }

  public setScrollback(scrollback: number) {
    this._scrollback = scrollback;
  }

  public setWebviewView(webviewView: vscode.WebviewView) {
    // Clean up previous visibility subscription
    if (this._visibilityDisposable) {
      this._visibilityDisposable.dispose();
      this._visibilityDisposable = undefined;
    }

    this._webviewView = webviewView;

    // Set up visibility handler to manage output buffering
    this._visibilityDisposable = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        // Webview became visible - replay buffered output
        this._replayBufferedOutput();
      }
    });
  }

  /**
   * Replay buffered output when webview becomes visible
   */
  private _replayBufferedOutput() {
    if (!this._webviewView?.visible) {
      return;
    }

    let totalReplayed = 0;
    for (const [tabId, buffer] of this._outputBuffer.entries()) {
      if (buffer.length > 0) {
        Logger.debug(`📤 Replaying ${buffer.length} buffered messages for tab ${tabId}`);

        // Send all buffered data at once (joined)
        const combinedData = buffer.join('');
        this._webviewView.webview.postMessage({
          command: "data",
          data: combinedData,
          tabId: tabId,
        });

        totalReplayed += buffer.length;
      }
    }

    // Clear all buffers after replay
    this._outputBuffer.clear();

    if (totalReplayed > 0) {
      Logger.info(`✅ Replayed ${totalReplayed} buffered messages`);
    }
  }

  /**
   * Handle messages intended for the PTY manager
   * Encapsulates PTY operations and parameter extraction
   */
  public async handleMessage(message: any): Promise<void> {
    switch (message.command) {
      case "createPty":
        // Single canonical field now: launchCommand (older aliases removed)
        this.createPtyProcess(
          message.tabId,
          message.terminalType,
          message.launchCommand,
          message.cols,
          message.rows,
          message.cwd,
        );
        break;
      case "disposePty":
        this.disposePtyProcess(message.tabId);
        break;
      case "data":
        // Sanitize terminal input - prevent potential code injection
        const sanitizedData =
          typeof message.data === "string" ? message.data : "";
        this.writeToPty(sanitizedData, message.tabId);
        break;
      case "resize":
        this.resizePty(message.cols, message.rows, message.tabId);
        break;
      case "sendFilePath":
        // Validate file path input
        const sanitizedPath =
          typeof message.filePath === "string" ? message.filePath : "";
        const validTabId =
          typeof message.tabId === "number" ? message.tabId : 0;
        if (sanitizedPath && validTabId > 0) {
          this.sendFilePath(sanitizedPath, validTabId);
        }
        break;
      case "sendFileData":
        await this.sendFileData(
          message.fileData,
          message.fileName,
          message.fileType,
          message.tabId,
        );
        break;
      case "newTab":
        this.createPtyProcess(message.tabId, message.terminalType);
        break;
      case "closeTab":
        this.disposePtyProcess(message.tabId);
        break;
      default:
        // Return false to indicate this manager can't handle the message
        return;
    }
  }

  /**
   * Check if this manager can handle a specific message command
   */
  public canHandle(command: string): boolean {
    const ptyCommands = [
      "createPty",
      "disposePty",
      "data",
      "resize",
      "sendFilePath",
      "sendFileData",
      "newTab",
      "closeTab",
    ];
    return ptyCommands.includes(command);
  }

  public createPtyProcess(
    tabId: number,
    terminalType: string = "default",
    launchCommand?: string,
    cols?: number,
    rows?: number,
    cwd?: string,
  ): void {
    // Only create new PTY process if one doesn't exist for this tab
    if (!this._ptyProcesses.has(tabId)) {
      // Store terminal type for this tab
      this._terminalTypes.set(tabId, terminalType);

      // Determine what command/shell to spawn based on terminal type
      const userShell = this._getDefaultShell();
      let command: string;
      let args: string[];

      const isWindowsPowerShell = process.platform === "win32" &&
        (userShell.toLowerCase().includes("powershell") || userShell.toLowerCase().includes("pwsh"));
      const isWindowsCmd = process.platform === "win32" && !isWindowsPowerShell;

      // Expand template variables ({workspace}, {env.VAR}, etc.) at launch time
      const expandedCommand = launchCommand && this._expandCommand
        ? this._expandCommand(launchCommand) : launchCommand;

      switch (terminalType) {
        case "command":
          // Use shell with -c to execute command with full environment
          // This ensures PATH and other shell variables are available
          if (expandedCommand) {
            command = userShell;
            if (isWindowsPowerShell) {
              args = ["-NoLogo", "-Command", expandedCommand];
            } else if (isWindowsCmd) {
              args = ["/c", expandedCommand];
            } else {
              // Unix: Use login shell to load PATH, then execute command interactively
              args = ["-l", "-i", "-c", expandedCommand];
            }
          } else {
            // Default to shell if no command specified
            command = userShell;
            if (isWindowsPowerShell) {
              args = ["-NoLogo"];
            } else if (isWindowsCmd) {
              args = [];
            } else {
              args = ["-l", "-i"];
            }
          }
          break;

        case "shell":
          // Always plain shell (no auto command)
          command = userShell;
          if (isWindowsPowerShell) {
            args = ["-NoLogo"];
          } else if (isWindowsCmd) {
            args = [];
          } else {
            args = ["-l", "-i"];
          }
          break;

        case "default":
        default:
          // Default to plain shell
          command = userShell;
          if (isWindowsPowerShell) {
            args = ["-NoLogo"];
          } else if (isWindowsCmd) {
            args = [];
          } else {
            args = ["-l", "-i"];
          }
          break;
      }

      const resolvedCwd =
        cwd ||
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
        process.env.HOME ||
        process.env.USERPROFILE ||
        process.cwd();

      // Build clean environment: strip VSCODE_* and ELECTRON_* vars that can
      // cause VS Code's built-in terminal to steal focus or trigger shell
      // integration scripts in child processes
      const cleanEnv: { [key: string]: string } = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (key.startsWith("VSCODE_") || key.startsWith("ELECTRON_")) continue;
        cleanEnv[key] = value;
      }

      const ptyProcess = pty.spawn(command, args, {
        name: TERMINAL_DEFAULTS.TERM_TYPE,
        cols: cols || TERMINAL_DEFAULTS.PTY_COLS,
        rows: rows || TERMINAL_DEFAULTS.PTY_ROWS,
        cwd: resolvedCwd,
        env: {
          ...cleanEnv,
          TERM: TERMINAL_DEFAULTS.TERM_TYPE,
          COLORTERM: TERMINAL_DEFAULTS.COLOR_TERM,
          TERM_PROGRAM: "alterminal",
          TERM_PROGRAM_VERSION: vscode.version,
          PATH: process.env.PATH || "",
          SHELL: userShell,
        },
      });

      ptyProcess.onData((data) => {
        // Fast path: if data contains no ESC character, skip all escape
        // sequence extraction and filtering.  This covers the vast majority
        // of plain-text output (individual character echoes, command output
        // lines, etc.) and avoids 5+ regex operations per chunk.
        const hasEsc = data.indexOf('\x1b') !== -1;

        if (hasEsc) {
          // Extract working directory from OSC 7 before filtering strips it
          const cwd = this._extractCwdFromOsc7(data);
          if (cwd && cwd !== this._currentWorkingDirs.get(tabId)) {
            this._handleCwdChange(tabId, cwd);
          }

          // Extract user variables from OSC 1337 SetUserVar before filtering strips them
          const userVars = this._extractUserVars(data);
          if (userVars) {
            this._handleUserVarChange(tabId, userVars);
          }
        }

        // Filter out VS Code-specific escape sequences that can cause focus stealing
        const filteredData = hasEsc ? this._filterVSCodeSequences(data) : data;

        // Skip if all data was filtered out
        if (!filteredData) {
          return;
        }

        // Check if webview is visible
        if (this._webviewView?.visible) {
          // Webview is visible - send data directly
          this._webviewView.webview.postMessage({
            command: "data",
            data: filteredData,
            tabId: tabId,
          });
        } else {
          // Webview is hidden - buffer the output
          if (!this._outputBuffer.has(tabId)) {
            this._outputBuffer.set(tabId, []);
          }

          const buffer = this._outputBuffer.get(tabId)!;
          buffer.push(filteredData);

          // Trim buffer if it gets too large (keep last N entries)
          if (buffer.length > this._maxBufferSize) {
            const excess = buffer.length - this._maxBufferSize;
            buffer.splice(0, excess);
            Logger.warn(`⚠️ Output buffer for tab ${tabId} exceeded max size, trimmed ${excess} oldest entries`);
          }
        }

        // Check for process changes on data events, throttled to avoid
        // repeated syscalls (ptyProcess.process reads the foreground process
        // name via the OS on every invocation).
        Debouncer.debounce(
          `process-check-${tabId}`, 500,
          () => this._checkProcessChange(tabId),
          { leading: true, maxWait: 500 },
        );
      });

      ptyProcess.onExit(() => {
        this._cleanupProcess(tabId);
      });

      this._ptyProcesses.set(tabId, ptyProcess);

      // Seed initial working directory so cwd is never empty
      if (resolvedCwd) {
        this._handleCwdChange(tabId, resolvedCwd);
      }

      // Start monitoring the process name for this tab
      this._startProcessMonitoring(tabId);
    }
  }

  public writeToPty(data: string, tabId: number): void {
    this._ptyProcesses.get(tabId)?.write(data);
  }

  public resizePty(cols: number, rows: number, tabId: number): void {
    this._ptyProcesses.get(tabId)?.resize(cols, rows);
  }

  public sendFilePath(filePath: string, tabId: number): void {
    // Shell-escape by wrapping in single quotes and escaping embedded single quotes
    // This safely handles spaces, semicolons, backticks, $, etc.
    const escapedPath = filePath.replace(/'/g, "'\\''");
    this._ptyProcesses.get(tabId)?.write(`'${escapedPath}' `);
  }

  public disposePtyProcess(tabId: number): void {
    this._cleanupProcess(tabId);
  }

  private _cleanupProcess(tabId: number): void {
    // Clean up process monitoring timer
    if (this._processMonitorTimers.has(tabId)) {
      clearInterval(this._processMonitorTimers.get(tabId)!);
      this._processMonitorTimers.delete(tabId);
    }

    // Kill PTY process
    const ptyProcess = this._ptyProcesses.get(tabId);
    if (ptyProcess) {
      ptyProcess.kill();
      this._ptyProcesses.delete(tabId);
    }

    // Clean up state
    this._currentProcessNames.delete(tabId);
    this._terminalTypes.delete(tabId);
    this._currentWorkingDirs.delete(tabId);
    this._userVars.delete(tabId);
    Debouncer.cancel(`process-check-${tabId}`);

    // Clear output buffer for this tab
    this._outputBuffer.delete(tabId);
  }

  public async sendFileData(
    fileData: string,
    fileName: string,
    fileType: string,
    tabId: number,
  ): Promise<void> {
    try {
      const os = require("os");
      const path = require("path");
      const fs = require("fs").promises;

      const tempDir = os.tmpdir();
      const tempFileName = `alterminal-${Date.now()}-${fileName}`;
      const tempFilePath = path.join(tempDir, tempFileName);

      // Handle different data formats
      let buffer: Buffer;
      if (fileData.startsWith("data:")) {
        // Data URL format (images, binary files)
        const base64Data = fileData.split(",")[1];
        buffer = Buffer.from(base64Data, "base64");
      } else {
        // Plain text content
        buffer = Buffer.from(fileData, "utf8");
      }

      await fs.writeFile(tempFilePath, buffer);
      await fs.chmod(tempFilePath, 0o644);

      // Send the temp file path
      this._ptyProcesses.get(tabId)?.write(`'${tempFilePath}' `);
    } catch (error) {
      Logger.error("Error writing file to temp:", error);
      this._ptyProcesses.get(tabId)?.write(`"${fileName}" `);
    }
  }

  public dispose(): void {
    // Clean up all PTY processes and timers
    const tabIds = Array.from(this._ptyProcesses.keys());
    for (const tabId of tabIds) {
      this._cleanupProcess(tabId);
    }

    // Clean up visibility subscription
    if (this._visibilityDisposable) {
      this._visibilityDisposable.dispose();
      this._visibilityDisposable = undefined;
    }

    // Release webview reference
    this._webviewView = undefined;
  }

  /**
   * Check if we have any running PTY processes (indicates warm boot)
   */
  public hasRunningProcesses(): boolean {
    const hasProcesses = this._ptyProcesses.size > 0;
    return hasProcesses;
  }

  /**
   * Get information about running PTY processes
   */
  public getRunningProcessInfo(): Array<{
    tabId: number;
    terminalType: string;
    processName: string;
  }> {
    const info = [];
    for (const [tabId, ptyProcess] of this._ptyProcesses.entries()) {
      info.push({
        tabId,
        terminalType: this._terminalTypes.get(tabId) || "unknown",
        processName: this._currentProcessNames.get(tabId) || "shell",
      });
    }
    return info;
  }

  /**
   * Check for process name changes and notify webview
   * Called on data events (event-driven) and via fallback polling
   */
  private _checkProcessChange(tabId: number): void {
    const ptyProcess = this._ptyProcesses.get(tabId);
    if (!ptyProcess) return;

    const currentProcess = ptyProcess.process || "shell";
    const previousProcess = this._currentProcessNames.get(tabId);

    if (currentProcess !== previousProcess) {
      this._currentProcessNames.set(tabId, currentProcess);
      this._webviewView?.webview.postMessage({
        command: "processChange",
        processName: currentProcess,
        tabId: tabId,
      });
    }
  }

  /**
   * Start monitoring process name changes
   * Uses event-driven approach (checks on data events) + minimal fallback polling
   */
  private _startProcessMonitoring(tabId: number): void {
    const ptyProcess = this._ptyProcesses.get(tabId);
    if (!ptyProcess) return;

    // Get initial process name
    const initialProcess = ptyProcess.process || "shell";
    this._currentProcessNames.set(tabId, initialProcess);

    // Fallback polling at 5 second interval (5x less frequent than before)
    // Most process changes are caught via onData events, this is just for edge cases
    const timer = setInterval(() => {
      this._checkProcessChange(tabId);
    }, 5000);

    this._processMonitorTimers.set(tabId, timer);
  }

  /**
   * Get the default shell for the current platform
   * Windows: Prefer PowerShell (loads user environment properly) or use VS Code's configured shell
   * Unix: Use $SHELL or fallback to bash
   */
  private _getDefaultShell(): string {
    if (process.platform === "win32") {
      // Check VS Code's terminal.integrated.shell.windows setting first
      const vscodeShell = vscode.workspace.getConfiguration("terminal.integrated.shell").get<string>("windows");
      if (vscodeShell) {
        return vscodeShell;
      }

      // Check for PowerShell (Core) first, then Windows PowerShell, fallback to cmd.exe
      // PowerShell properly loads the user's PATH from the registry
      const comspec = process.env.COMSPEC; // Usually C:\Windows\System32\cmd.exe

      // Try to find PowerShell
      if (process.env.PWSH_PATH) {
        return process.env.PWSH_PATH;
      }

      // Look for pwsh (PowerShell Core) or powershell (Windows PowerShell)
      try {
        const { execSync } = require('child_process');
        try {
          execSync('pwsh.exe -v', { stdio: 'ignore' });
          return 'pwsh.exe';
        } catch {
          try {
            execSync('powershell.exe -v', { stdio: 'ignore' });
            return 'powershell.exe';
          } catch {
            // Fall back to cmd.exe
          }
        }
      } catch {
        // If execSync fails, continue to fallback
      }

      // Fallback to cmd.exe
      return comspec || "cmd.exe";
    }

    // Unix/Mac: use configured shell or default to bash
    return process.env.SHELL || "/bin/bash";
  }
}
