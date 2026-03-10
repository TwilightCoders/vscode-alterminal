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
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { execFile } from "child_process";
import { Logger } from "../utils/logger";
import { Debouncer } from "../utils/debouncer";
import { BellDetector } from "./bellDetector";
import { TERMINAL_DEFAULTS } from "../constants";
import { ShellDetector } from "../utils/shellDetector";

export class PtyManager {
  private _ptyProcesses = new Map<number, pty.IPty>();
  private _processMonitorTimers = new Map<number, NodeJS.Timeout>();
  private _currentProcessNames = new Map<number, string>();
  private _terminalTypes = new Map<number, string>();
  private _currentWorkingDirs = new Map<number, string>();
  private _userVars = new Map<number, Map<string, string>>();
  private _alterminal?: vscode.WebviewView;
  private _visibilityDisposable?: { dispose(): void };
  private _extensionVersion: string = "0.0.0";
  private _extensionPath: string = "";
  private _expandCommand: ((cmd: string) => string) | null = null;
  private _onBell: ((tabId: number) => void) | null = null;

  // Tabs using shell integration (OSC 7) don't need the lsof fallback
  private _shellIntegrationTabs = new Set<number>();

  private _bellDetector = new BellDetector();

  // Buffer for PTY output when webview is hidden
  private _outputBuffer = new Map<number, string[]>();
  private _maxBufferSize = 10000; // Maximum lines to buffer per terminal

  // Combined pattern for escape sequences to filter out in a single pass:
  // - OSC 633: VS Code shell integration protocol
  // - OSC 133: FinalTerm shell integration (VS Code also responds to this)
  // - OSC 7: Current working directory (can trigger VS Code behavior)
  // - OSC 9;9: ConEmu/Cmder CWD (Windows, VS Code responds)
  // - OSC 1337: iTerm2 protocol (sometimes used by tools)
  // - DEC private mode ?1004: Focus reporting (in/out events VS Code may intercept)
  private static readonly FILTER_PATTERN = /\x1b(?:\](?:633|133|7|9;9|1337);[^\x07\x1b]*(?:\x07|\x1b\\)|\[\?1004[hl])/g;

  // Extraction patterns (separate from filter because we need capture groups)
  private static readonly CWD_OSC_PATTERN = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  // iTerm2 SetUserVar: \x1b]1337;SetUserVar=name=base64value\x07
  private static readonly USER_VAR_PATTERN = /\x1b\]1337;SetUserVar=([A-Za-z0-9_]+)=([A-Za-z0-9+/=]*?)(?:\x07|\x1b\\)/g;

  constructor() {
    // No callbacks needed - will use webview directly
  }

  /**
   * Filter out escape sequences that can cause VS Code to steal focus
   * These include VS Code shell integration sequences and focus reporting mode
   */
  private _filterVSCodeSequences(data: string): string {
    return data.replace(PtyManager.FILTER_PATTERN, '');
  }

  /**
   * Extract the most recent working directory from OSC 7 sequences in data
   * OSC 7 format: \x1b]7;file://hostname/path\x07
   */
  private _extractCwdFromOsc7(data: string): string | null {
    PtyManager.CWD_OSC_PATTERN.lastIndex = 0;
    let lastUrl: string | null = null;
    let m: RegExpExecArray | null;
    while ((m = PtyManager.CWD_OSC_PATTERN.exec(data)) !== null) {
      lastUrl = m[1]; // capture group has the URL directly
    }
    if (!lastUrl) return null;
    try {
      return decodeURIComponent(new URL(lastUrl).pathname);
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
      this._alterminal?.webview.postMessage({
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
    this._alterminal?.webview.postMessage({
      command: "cwdChange",
      cwd,
      tabId,
    });
  }

  public setCommandExpander(fn: (cmd: string) => string) {
    this._expandCommand = fn;
  }

  public onBell(fn: (tabId: number) => void) {
    this._onBell = fn;
  }

  public setExtensionVersion(version: string) {
    this._extensionVersion = version;
  }

  public setExtensionPath(extensionPath: string) {
    this._extensionPath = extensionPath;
  }

  public setAlterminal(alterminal: vscode.WebviewView) {
    // Clean up previous visibility subscription
    if (this._visibilityDisposable) {
      this._visibilityDisposable.dispose();
      this._visibilityDisposable = undefined;
    }

    this._alterminal = alterminal;

    // Set up visibility handler to manage output buffering
    this._visibilityDisposable = alterminal.onDidChangeVisibility(() => {
      if (alterminal.visible) {
        // Webview became visible - replay buffered output
        this._replayBufferedOutput();
      }
    });
  }

  /**
   * Replay buffered output when webview becomes visible
   */
  private _replayBufferedOutput() {
    if (!this._alterminal?.visible) {
      return;
    }

    let totalReplayed = 0;
    for (const [tabId, buffer] of this._outputBuffer.entries()) {
      if (buffer.length > 0) {
        Logger.debug(`📤 Replaying ${buffer.length} buffered messages for tab ${tabId}`);

        // Send all buffered data at once (joined)
        const combinedData = buffer.join('');
        this._alterminal.webview.postMessage({
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
          message.shellPath,
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
  private static readonly _ptyCommands = new Set([
    "createPty", "disposePty", "data", "resize",
    "sendFilePath", "sendFileData", "newTab", "closeTab",
  ]);

  public canHandle(command: string): boolean {
    return PtyManager._ptyCommands.has(command);
  }

  public createPtyProcess(
    tabId: number,
    terminalType: string = "default",
    launchCommand?: string,
    cols?: number,
    rows?: number,
    cwd?: string,
    shellPath?: string,
  ): void {
    // Only create new PTY process if one doesn't exist for this tab
    if (!this._ptyProcesses.has(tabId)) {
      // Store terminal type for this tab
      this._terminalTypes.set(tabId, terminalType);

      // Determine what command/shell to spawn based on terminal type
      const userShell = shellPath || this._getDefaultShell();
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
        case "default":
        default:
          // Plain interactive shell (no auto command)
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

      // Build clean environment: strip vars that can cause VS Code's
      // built-in terminal to steal focus or trigger shell integration
      const cleanEnv: { [key: string]: string } = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (key.startsWith("VSCODE_") || key.startsWith("ELECTRON_")) continue;
        // Strip askpass helpers only when they point to VS Code's credential helper.
        // User-configured helpers (keychain, ksshaskpass, etc.) are left intact.
        if ((key === "GIT_ASKPASS" || key === "SSH_ASKPASS") && /vscode|Code/i.test(value)) continue;
        cleanEnv[key] = value;
      }

      // Set up shell integration for CWD reporting via OSC 7.
      // Each shell type uses a different injection mechanism.
      const shellIntEnv: Record<string, string> = {};
      const shellBase = path.basename(command).toLowerCase();
      let hasShellIntegration = false;

      if (this._extensionPath && terminalType !== "command") {
        if (shellBase === "zsh" || shellBase.startsWith("zsh")) {
          const zdotdir = path.join(this._extensionPath, "shell-integration", "zsh");
          shellIntEnv.ALTERMINAL_ORIG_ZDOTDIR = process.env.ZDOTDIR || process.env.HOME || "";
          shellIntEnv.ZDOTDIR = zdotdir;
          hasShellIntegration = true;
        } else if (shellBase === "bash" || shellBase.startsWith("bash")) {
          const bashInit = path.join(this._extensionPath, "shell-integration", "bash.sh");
          shellIntEnv.ALTERMINAL_SHELL_INIT = bashInit;
          shellIntEnv.PROMPT_COMMAND = `. "$ALTERMINAL_SHELL_INIT"`;
          hasShellIntegration = true;
        } else if (shellBase === "fish") {
          const fishInit = path.join(this._extensionPath, "shell-integration", "fish.fish");
          args.push("--init-command", `source ${fishInit}`);
          hasShellIntegration = true;
        }
      }

      if (hasShellIntegration) {
        this._shellIntegrationTabs.add(tabId);
      }

      const ptyProcess = pty.spawn(command, args, {
        name: TERMINAL_DEFAULTS.TERM_TYPE,
        cols: cols || TERMINAL_DEFAULTS.PTY_COLS,
        rows: rows || TERMINAL_DEFAULTS.PTY_ROWS,
        cwd: resolvedCwd,
        env: {
          ...cleanEnv,
          ...shellIntEnv,
          TERM: TERMINAL_DEFAULTS.TERM_TYPE,
          COLORTERM: TERMINAL_DEFAULTS.COLOR_TERM,
          TERM_PROGRAM: "alterminal",
          TERM_PROGRAM_VERSION: this._extensionVersion,
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

        // Extract metadata from the raw data BEFORE filtering strips the
        // escape sequences (OSC 7 for CWD, OSC 1337 for user vars).
        if (hasEsc) {
          const cwd = this._extractCwdFromOsc7(data);
          if (cwd && cwd !== this._currentWorkingDirs.get(tabId)) {
            this._handleCwdChange(tabId, cwd);
          }

          const userVars = this._extractUserVars(data);
          if (userVars) {
            this._handleUserVarChange(tabId, userVars);
          }
        }

        // Detect bare BEL characters (\x07) — delegates to BellDetector
        // which handles chunked OSC sequences across data events.
        if (this._onBell && this._bellDetector.detect(tabId, data)) {
          this._onBell(tabId);
        }

        // Filter out VS Code-specific escape sequences that can cause focus stealing
        const filteredData = hasEsc ? this._filterVSCodeSequences(data) : data;

        // Skip if all data was filtered out
        if (!filteredData) {
          return;
        }

        // Forward data to webview
        if (this._alterminal?.visible) {
          this._alterminal.webview.postMessage({
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
          { maxWait: 500 },
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
    this._shellIntegrationTabs.delete(tabId);
    this._bellDetector.delete(tabId);
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
      const tempDir = os.tmpdir();
      // Strip path separators to prevent directory traversal
      const safeName = path.basename(fileName).replace(/[/\\]/g, "_");
      const tempFileName = `alterminal-${Date.now()}-${safeName}`;
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

      await fs.promises.writeFile(tempFilePath, buffer);
      await fs.promises.chmod(tempFilePath, 0o644);

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
    this._alterminal = undefined;
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
      this._alterminal?.webview.postMessage({
        command: "processChange",
        processName: currentProcess,
        tabId: tabId,
      });
    }

    // For shells without our integration (unsupported shells), fall back
    // to async OS-level CWD inspection.  Shells WITH integration emit
    // OSC 7 directly — no need for the subprocess overhead.
    if (!this._shellIntegrationTabs.has(tabId)) {
      this._checkCwdAsync(tabId, ptyProcess.pid);
    }
  }

  /**
   * Asynchronously check the CWD of a process by PID.
   * Only used for shells without our shell integration scripts.
   *
   * Linux:  reads /proc/<pid>/cwd symlink — single async syscall.
   * macOS:  uses lsof — async subprocess, ~2ms typical.
   */
  private _checkCwdAsync(tabId: number, pid: number): void {
    try {
      if (process.platform === "linux") {
        fs.readlink(`/proc/${pid}/cwd`, (err: any, cwd: string) => {
          if (!err && cwd && cwd !== this._currentWorkingDirs.get(tabId)) {
            this._handleCwdChange(tabId, cwd);
          }
        });
      } else if (process.platform === "darwin") {
        execFile("lsof", ["-a", "-d", "cwd", "-Fn", "-p", String(pid)], {
          encoding: "utf8",
          timeout: 2000,
        }, (err: any, stdout: string) => {
          if (err) return;
          const match = stdout.match(/\nn(.+)/);
          if (match && match[1] !== this._currentWorkingDirs.get(tabId)) {
            this._handleCwdChange(tabId, match[1]);
          }
        });
      }
    } catch {
      // Process may have exited
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
    // Check VS Code's terminal shell setting first
    const configKey = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "osx" : "linux";
    const vscodeShell = vscode.workspace.getConfiguration("terminal.integrated.shell").get<string>(configKey);
    if (vscodeShell) return vscodeShell;

    // Use ShellDetector's cached results — no blocking execSync calls
    const shells = ShellDetector.detectShells();
    const defaultShell = shells.find((s) => s.isDefault);
    if (defaultShell) return defaultShell.path;

    // Final fallback
    return process.platform === "win32"
      ? process.env.COMSPEC || "cmd.exe"
      : process.env.SHELL || "/bin/bash";
  }
}
