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
import * as crypto from "crypto";
import { execFile, execFileSync } from "child_process";
import { Logger } from "../utils/logger";
import { Debouncer } from "../utils/debouncer";
import { BellDetector } from "./bellDetector";
import { TERMINAL_DEFAULTS } from "../constants";
import { ShellDetector } from "../utils/shellDetector";
import { sanitizeSpawnEnv } from "./envSanitizer";
import type { PtyDaemonClient } from "../daemon/ptyDaemonClient";
import { shellEscape } from "../daemon/ptyDaemonClient";
import type { ExtToWebviewMessage } from "../shared/messages";
import {
  filterVSCodeSequences,
  extractCwdFromOsc7,
  extractUserVars,
  replaceBelWithST,
  detectFocusRequest,
  describeFocusSuspects,
} from "./dataPipeline";
import { BoundedChunkBuffer } from "./boundedChunkBuffer";

const HIDDEN_BUFFER_MAX_CHUNKS = 10000;
const HIDDEN_BUFFER_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB per tab

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
  private _suppressFocusStealing: boolean = true;
  // Fired when a PTY chunk contains a genuine "raise/focus this window"
  // request. The provider redirects this to Alterminal's own view instead of
  // letting VS Code honour it on its integrated terminal.
  private _onFocusRequest: ((tabId: number) => void) | null = null;
  // Bounded diagnostic ring of focus-relevant escapes seen on the wire, so an
  // observed steal can be attributed to actual bytes (Dale can dump via the
  // "Alterminal: Dump Focus Diagnostics" command) rather than guessed at.
  private _focusDiag: Array<{ ts: number; tabId: number; seqs: string[]; redirected: boolean }> = [];
  private static readonly FOCUS_DIAG_MAX = 100;

  // Daemon mode: routes PTY operations through a persistent daemon process
  private _daemonClient: PtyDaemonClient | null = null;
  // Map tabId → ptyId (UUID) for daemon mode PTY identity
  private _tabPtyIds = new Map<number, string>();
  // Reverse map ptyId → tabId for daemon event routing
  private _ptyIdToTab = new Map<string, number>();
  // Tabs whose next inbound chunk should be prefixed with a terminal clear.
  // Only used on the fallback (attach+replay) path when a daemon doesn't
  // yet support `reattach`; the seamless `reattach` path needs no clear.
  private _clearOnNextData = new Set<number>();
  // Last known terminal dimensions per tab, so live re-attach can resize
  // the PTY to the client's real size (and correct loompty's rows+1 adopt).
  private _tabDims = new Map<number, { cols: number; rows: number }>();
  // Live daemon PTYs discovered on connect (before tabs restore)
  private _liveDaemonPtys = new Set<string>();
  // Resolves once the daemon PTY list has been fetched
  private _daemonListReady: Promise<void> = Promise.resolve();

  // Tabs using shell integration (OSC 7) don't need the lsof fallback
  private _shellIntegrationTabs = new Set<number>();

  private _bellDetector = new BellDetector();

  // Buffer for PTY output when webview is hidden. Bounded by both chunk
  // count and total bytes — runaway output (e.g. cat'ing a large file in
  // a hidden tab) used to retain GBs because the cap was chunk-count only.
  private _outputBuffer = new Map<number, BoundedChunkBuffer>();

  // Data pipeline functions (filterVSCodeSequences, extractCwdFromOsc7,
  // extractUserVars, replaceBelWithST) and regex constants are in
  // ./dataPipeline.ts for testability.

  constructor() {
    // No callbacks needed - will use webview directly
  }

  /**
   * Set the daemon client for persistent PTY mode.
   * When set, PTY operations route through the daemon instead of
   * spawning processes directly in the extension host.
   */
  public setDaemonClient(client: PtyDaemonClient | null): void {
    // Clean up previous daemon event listeners
    if (this._daemonClient) {
      this._daemonClient.removeAllListeners();
    }

    this._daemonClient = client;
    this._liveDaemonPtys.clear();

    if (client) {
      client.on("data", (ptyId: string, data: string) => {
        const tabId = this._ptyIdToTab.get(ptyId);
        if (tabId === undefined) return;
        this._handlePtyData(tabId, data);
      });

      client.on("exit", (ptyId: string, _exitCode: number) => {
        const tabId = this._ptyIdToTab.get(ptyId);
        if (tabId === undefined) return;
        this._cleanupProcess(tabId);
      });

      // Pre-fetch live PTYs so createPtyProcess can reattach on restore.
      // Stored as a promise so createPtyProcess can await it (avoids race).
      Logger.info("[daemon] Fetching live PTY list from daemon...");
      this._daemonListReady = client.list().then((ptys) => {
        for (const pty of ptys) {
          this._liveDaemonPtys.add(pty.ptyId);
        }
        Logger.info(`[daemon] Live PTYs from daemon: ${ptys.length} [${ptys.map(p => p.ptyId).join(", ")}]`);
      }).catch((err) => {
        Logger.error("[daemon] Failed to fetch PTY list:", err);
      });
    }
  }

  /** Whether the daemon is active and connected. */
  public get daemonActive(): boolean {
    return this._daemonClient?.connected ?? false;
  }

  /** UUIDs of live daemon PTYs (available after daemon list is fetched). */
  public get liveDaemonPtyIds(): Set<string> {
    return this._liveDaemonPtys;
  }

  /** Resolves when the daemon PTY list has been fetched. */
  public get daemonListReady(): Promise<void> {
    return this._daemonListReady;
  }

  /**
   * Reattach to PTYs that survived a reload via the daemon.
   * Called during restore when daemon has live PTYs matching saved UUIDs.
   */
  public async reattachDaemonPty(tabId: number, ptyId: string): Promise<boolean> {
    if (!this._daemonClient?.connected) return false;

    this._tabPtyIds.set(tabId, ptyId);
    this._ptyIdToTab.set(ptyId, tabId);

    // `attach` replays the FULL scrollback as its first bytes. Clear the target
    // (viewport + scrollback via \x1b[3J) on that first chunk so the replay
    // lands in an empty buffer — otherwise any content the webview already holds
    // (a SerializeAddon restore, or a retained-context buffer) stacks a second
    // identical copy underneath the replay: the scrollback-duplication bug.
    // Enforces loompty's contract invariant: full-replay ⟺ fresh/cleared target.
    // (Bonus: content now comes from the raw replay, so xterm rebuilds wrap
    // flags and resize reflows the restored history correctly.)
    this._clearOnNextData.add(tabId);

    try {
      await this._daemonClient.attach(ptyId);
      Logger.info(`Reattached to daemon PTY ${ptyId} for tab ${tabId}`);
      return true;
    } catch (err) {
      Logger.error(`Failed to reattach to daemon PTY ${ptyId}:`, err);
      this._clearOnNextData.delete(tabId);
      this._tabPtyIds.delete(tabId);
      this._ptyIdToTab.delete(ptyId);
      return false;
    }
  }

  /**
   * Re-attach every live tab's session on the current daemon client.
   *
   * Called after a zero-downtime handoff swaps the client: the old client's
   * per-session data sockets died on disconnect, so without this the
   * terminals freeze (no output in, nowhere for input to go). Each tab is
   * flagged so its first replayed chunk clears the stale buffer, avoiding
   * duplicated scrollback. Unlike the restore path (fresh webview, fresh
   * xterm), this runs against live, already-populated terminals.
   */
  public async reattachAllDaemonPtys(): Promise<void> {
    if (!this._daemonClient?.connected) return;
    const entries = Array.from(this._tabPtyIds.entries());
    Logger.info(`[daemon] re-attaching ${entries.length} session(s) after handoff`);
    for (const [tabId, ptyId] of entries) {
      this._ptyIdToTab.set(ptyId, tabId);
      const dims = this._tabDims.get(tabId);
      // Preferred: resume-only `reattach` — the terminal already holds the
      // buffer, so no scrollback replay (no repaint, seamless).
      try {
        await this._daemonClient.reattach(ptyId, dims);
        Logger.info(`[daemon] re-attached (resume-only) tab ${tabId} → ${ptyId}`);
        continue;
      } catch (err) {
        // Daemon may predate `reattach` support — fall back to a full
        // `attach`, clearing the stale buffer first so the replay doesn't
        // duplicate. Correct, just with a visible repaint.
        Logger.warn(`[daemon] reattach unsupported/failed for tab ${tabId} (${ptyId}); falling back to attach+replay: ${(err as Error)?.message || err}`);
      }
      this._clearOnNextData.add(tabId);
      try {
        await this._daemonClient.attach(ptyId, dims);
        Logger.info(`[daemon] re-attached (attach+replay) tab ${tabId} → ${ptyId}`);
      } catch (err2) {
        this._clearOnNextData.delete(tabId);
        Logger.error(`[daemon] re-attach failed for tab ${tabId} (${ptyId}):`, err2);
      }
    }
  }

  /**
   * List live PTYs in the daemon for this session.
   */
  public async listDaemonPtys(): Promise<Array<{ ptyId: string; pid: number; processName: string; cwd: string }>> {
    if (!this._daemonClient?.connected) return [];
    try {
      return await this._daemonClient.list();
    } catch {
      return [];
    }
  }

  /**
   * Toggle stripping of OSC sequences known to make VS Code steal focus.
   * Defaults to true; can be turned off via alterminal.suppressFocusStealingSequences.
   */
  public setSuppressFocusStealing(value: boolean): void {
    this._suppressFocusStealing = value;
  }

  /**
   * Filter out escape sequences that can cause VS Code to steal focus
   * These include VS Code shell integration sequences and focus reporting mode
   */
  private _filterVSCodeSequences(data: string): string {
    return filterVSCodeSequences(data);
  }

  /**
   * Common PTY data handler — used by both direct PTY and daemon modes.
   * Extracts metadata, filters sequences, detects bell, forwards to webview.
   */
  private _handlePtyData(tabId: number, data: string): void {
    const hasEsc = data.indexOf('\x1b') !== -1;

    if (hasEsc) {
      // Cheap indexOf pre-gates: the extractor regexes can only match when their
      // OSC prefix is present, so skip the full-chunk scan otherwise. TUIs emit
      // ESC on nearly every chunk but rarely OSC 7 / OSC 1337, so this avoids two
      // global-regex passes per chunk on the hot path. (Strict supersets of
      // CWD_OSC_PATTERN / USER_VAR_PATTERN — behaviour-identical.)
      const cwd = data.indexOf("\x1b]7;") !== -1 ? this._extractCwdFromOsc7(data) : null;
      if (cwd && cwd !== this._currentWorkingDirs.get(tabId)) {
        this._handleCwdChange(tabId, cwd);
      }

      const userVars = data.indexOf("\x1b]1337;SetUserVar=") !== -1
        ? this._extractUserVars(data)
        : null;
      if (userVars) {
        this._handleUserVarChange(tabId, userVars);
      }

      // Focus-steal handling. Detect on the RAW chunk (before the filter
      // strips it). A genuine raise/focus request is redirected to OUR view
      // (see provider.onFocusRequest); everything focus-relevant is recorded
      // for diagnostics so an observed steal can be pinned to actual bytes.
      const suspects = describeFocusSuspects(data);
      const wantsFocus = this._suppressFocusStealing && detectFocusRequest(data);
      if (suspects.length > 0) {
        this._focusDiag.push({
          ts: Date.now(),
          tabId,
          seqs: suspects,
          redirected: wantsFocus,
        });
        if (this._focusDiag.length > PtyManager.FOCUS_DIAG_MAX) {
          this._focusDiag.splice(0, this._focusDiag.length - PtyManager.FOCUS_DIAG_MAX);
        }
      }
      if (wantsFocus && this._onFocusRequest) {
        Logger.info(`Focus request from PTY [tab ${tabId}] → redirecting to Alterminal: ${suspects.join(" ")}`);
        this._onFocusRequest(tabId);
      }
    }

    if (this._onBell && this._bellDetector.detect(tabId, data)) {
      Logger.debug(`🔔 Bell detected [tab ${tabId}]`);
      this._onBell(tabId);
      // Notify webview so it can show tab badge (xterm.js won't fire
      // onBell since we strip \x07 before it reaches the terminal).
      this._alterminal?.webview.postMessage({
        command: "bell",
        tabId,
      } satisfies ExtToWebviewMessage);
    }

    let filteredData = (hasEsc && this._suppressFocusStealing) ? this._filterVSCodeSequences(data) : data;
    // Replace BEL with ST so xterm.js doesn't fire onBell for OSC terminators.
    // BellDetector already ran above on the raw data.
    filteredData = replaceBelWithST(filteredData);

    // First chunk after a live re-attach: clear the stale on-screen buffer
    // (screen + scrollback) so the daemon's replayed scrollback renders
    // clean rather than duplicating. Atomic with the replay — same stream,
    // no cross-message race.
    if (this._clearOnNextData.has(tabId)) {
      this._clearOnNextData.delete(tabId);
      filteredData = "\x1b[2J\x1b[3J\x1b[H" + filteredData;
    }
    if (!filteredData) return;

    if (this._alterminal?.visible) {
      this._alterminal.webview.postMessage({
        command: "data",
        data: filteredData,
        tabId,
      } satisfies ExtToWebviewMessage);
    } else {
      let buffer = this._outputBuffer.get(tabId);
      if (!buffer) {
        buffer = new BoundedChunkBuffer({
          maxChunks: HIDDEN_BUFFER_MAX_CHUNKS,
          maxBytes: HIDDEN_BUFFER_MAX_BYTES,
        });
        this._outputBuffer.set(tabId, buffer);
      }
      buffer.push(filteredData);
    }

    // Throttled process check (direct mode only — daemon doesn't have ptyProcess.process)
    if (!this._daemonClient) {
      Debouncer.debounce(
        `process-check-${tabId}`, 500,
        () => this._checkProcessChange(tabId),
        { maxWait: 500 },
      );
    }
  }

  /**
   * Extract the most recent working directory from OSC 7 sequences in data
   * OSC 7 format: \x1b]7;file://hostname/path\x07
   */
  private _extractCwdFromOsc7(data: string): string | null {
    return extractCwdFromOsc7(data);
  }

  /**
   * Extract SetUserVar key-value pairs from OSC 1337 sequences in data
   */
  private _extractUserVars(data: string): Map<string, string> | null {
    return extractUserVars(data);
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
      } satisfies ExtToWebviewMessage);
    }
  }

  /**
   * Handle working directory change detected from OSC 7
   */
  private _handleCwdChange(tabId: number, cwd: string): void {
    Logger.info(`CWD change [tab ${tabId}]: ${cwd}`);
    this._currentWorkingDirs.set(tabId, cwd);
    this._alterminal?.webview.postMessage({
      command: "cwdChange",
      cwd,
      tabId,
    } satisfies ExtToWebviewMessage);
  }

  public setCommandExpander(fn: (cmd: string) => string) {
    this._expandCommand = fn;
  }

  public onBell(fn: (tabId: number) => void) {
    this._onBell = fn;
  }

  /**
   * Register the handler invoked when the PTY emits a genuine raise/focus
   * request. The provider uses this to focus Alterminal's own view instead
   * of letting VS Code grab its integrated terminal.
   */
  public onFocusRequest(fn: (tabId: number) => void) {
    this._onFocusRequest = fn;
  }

  /**
   * Snapshot of the focus-steal diagnostic ring (most recent last). Surfaced
   * via the "Alterminal: Dump Focus Diagnostics" command.
   */
  public getFocusDiagnostics(): Array<{ ts: number; tabId: number; seqs: string[]; redirected: boolean }> {
    return this._focusDiag.slice();
  }

  public setExtensionVersion(version: string) {
    this._extensionVersion = version;
  }

  public setExtensionPath(extensionPath: string) {
    this._extensionPath = extensionPath;
  }

  /** Foreground process name for a tab (e.g. "claude", "bash"), or undefined. */
  public getProcessName(tabId: number): string | undefined {
    return this._currentProcessNames.get(tabId);
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

        // flush() concatenates and clears in one pass — avoids the
        // peak-memory hit from holding the joined string and the chunks
        // simultaneously.
        totalReplayed += buffer.length;
        this._alterminal.webview.postMessage({
          command: "data",
          data: buffer.flush(),
          tabId: tabId,
        } satisfies ExtToWebviewMessage);
      }
    }

    // Clear remaining buffer entries (already flushed above).
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
        Logger.info(`[daemon] createPty msg: tabId=${message.tabId} uuid=${message.uuid} daemonConnected=${this._daemonClient?.connected ?? false}`);
        // Single canonical field now: launchCommand (older aliases removed)
        this.createPtyProcess(
          message.tabId,
          message.terminalType,
          message.launchCommand,
          message.cols,
          message.rows,
          message.cwd,
          message.shellPath,
          message.uuid,
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
      case "clearBuffer": {
        const ptyId = this._tabPtyIds.get(message.tabId);
        if (ptyId && this._daemonClient?.connected) {
          this._daemonClient.clearBuffer(ptyId);
        }
        break;
      }
      case "checkProcesses":
        this._checkChildProcesses(message.tabId);
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
    "sendFilePath", "sendFileData", "newTab", "closeTab", "clearBuffer",
    "checkProcesses",
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
    uuid?: string,
  ): void {
    // Only create new PTY process if one doesn't exist for this tab
    if (this._ptyProcesses.has(tabId) || this._tabPtyIds.has(tabId)) {
      return;
    }

    // If daemon is connected and UUID is provided, wait for the PTY list
    // to arrive before deciding whether to reattach or spawn fresh.
    if (uuid && this._daemonClient?.connected) {
      Logger.info(`[daemon] Waiting for daemon list before deciding (uuid=${uuid} tabId=${tabId} livePtys=${this._liveDaemonPtys.size})`);
      this._daemonListReady.then(() => {
        Logger.info(`[daemon] List ready: livePtys=[${[...this._liveDaemonPtys].join(",")}] looking for uuid=${uuid}`);
        // Re-check guard — another call may have resolved first
        if (this._ptyProcesses.has(tabId) || this._tabPtyIds.has(tabId)) {
          Logger.info(`[daemon] Tab ${tabId} already has a PTY, skipping`);
          return;
        }

        if (this._liveDaemonPtys.has(uuid)) {
          Logger.info(`[daemon] Reattaching to live daemon PTY ${uuid} for tab ${tabId}`);
          this._liveDaemonPtys.delete(uuid);
          this._terminalTypes.set(tabId, terminalType);
          this.reattachDaemonPty(tabId, uuid);
        } else {
          Logger.info(`[daemon] UUID ${uuid} not in daemon, spawning fresh for tab ${tabId}`);
          this._createPtyProcessInner(tabId, terminalType, launchCommand, cols, rows, cwd, shellPath, uuid);
        }
      });
      return;
    }

    this._createPtyProcessInner(tabId, terminalType, launchCommand, cols, rows, cwd, shellPath, uuid);
  }

  private _createPtyProcessInner(
    tabId: number,
    terminalType: string,
    launchCommand?: string,
    cols?: number,
    rows?: number,
    cwd?: string,
    shellPath?: string,
    uuid?: string,
  ): void {
    // Store terminal type for this tab
    this._terminalTypes.set(tabId, terminalType);

    // Determine what command/shell to spawn based on terminal type
    const userShell = shellPath || this._getDefaultShell();
    const command = userShell;
    let args: string[];

    const isWindowsPowerShell = process.platform === "win32" &&
      (userShell.toLowerCase().includes("powershell") || userShell.toLowerCase().includes("pwsh"));
    const isWindowsCmd = process.platform === "win32" && !isWindowsPowerShell;

    // Expand template variables ({workspace}, {env.VAR}, etc.) at launch time
    const expandedCommand = launchCommand && this._expandCommand
      ? this._expandCommand(launchCommand) : launchCommand;

    // Interactive/login base args per shell family (this matrix was repeated
    // three times across the terminal-type branches). A "command" terminal just
    // appends the run-a-command flag + the command on top of the base.
    const baseArgs = isWindowsPowerShell ? ["-NoLogo"] : isWindowsCmd ? [] : ["-l", "-i"];
    if (terminalType === "command" && expandedCommand) {
      args = isWindowsPowerShell
        ? [...baseArgs, "-Command", expandedCommand]
        : isWindowsCmd
          ? ["/c", expandedCommand]
          : [...baseArgs, "-c", expandedCommand];
    } else {
      args = baseArgs;
    }

    const resolvedCwd =
      cwd ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
      process.env.HOME ||
      process.env.USERPROFILE ||
      process.cwd();

    // Build clean environment — strip VS Code-injected vars so our shells don't
    // masquerade as the integrated terminal. Shared predicate with the diagnostic
    // ("what's leaking?") path; see envSanitizer.
    const cleanEnv = sanitizeSpawnEnv(process.env);

    // Set up shell integration for CWD reporting via OSC 7
    const shellIntEnv: Record<string, string> = {};
    const shellBase = path.basename(command).toLowerCase();
    let hasShellIntegration = false;

    if (this._extensionPath && terminalType !== "command") {
      if (shellBase === "zsh" || shellBase.startsWith("zsh")) {
        const zshInit = path.join(this._extensionPath, "shell-integration", "zsh-init.zsh");
        shellIntEnv.ALTERMINAL_SHELL_INIT = zshInit;
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

    // Identity + shell-integration vars below (TERM, COLORTERM, TERM_PROGRAM,
    // TERM_PROGRAM_VERSION, ALTERMINAL_SHELL_INIT via shellIntEnv) must stay in
    // sync with ALTERMINAL_FORWARD_ENV_KEYS — daemon mode forwards exactly that
    // set, so a var added here but not there silently won't reach daemon shells.
    const fullEnv = {
      ...cleanEnv,
      ...shellIntEnv,
      TERM: TERMINAL_DEFAULTS.TERM_TYPE,
      COLORTERM: TERMINAL_DEFAULTS.COLOR_TERM,
      TERM_PROGRAM: "alterminal",
      TERM_PROGRAM_VERSION: this._extensionVersion,
      PATH: process.env.PATH || "",
      SHELL: userShell,
    };

    // --- Daemon mode: route through persistent daemon process ---
    if (this._daemonClient?.connected && uuid) {
      this._tabPtyIds.set(tabId, uuid);
      this._ptyIdToTab.set(uuid, tabId);

      this._daemonClient.spawn(
        uuid,
        command,
        args,
        resolvedCwd,
        fullEnv,
        cols || TERMINAL_DEFAULTS.PTY_COLS,
        rows || TERMINAL_DEFAULTS.PTY_ROWS,
      ).then(() => {
        // Spawn succeeded — nothing else to do
      }).catch((err) => {
        Logger.error(`Daemon spawn failed for tab ${tabId}, falling back to direct: ${(err as Error)?.message || err}`);
        // Clean up daemon mappings and fall back to direct mode
        this._tabPtyIds.delete(tabId);
        this._ptyIdToTab.delete(uuid);
        this._spawnDirectPty(tabId, command, args, resolvedCwd, fullEnv, cols, rows);
      });

      if (resolvedCwd) {
        this._handleCwdChange(tabId, resolvedCwd);
      }
      return;
    }

    // --- Direct mode: spawn PTY in extension host ---
    this._spawnDirectPty(tabId, command, args, resolvedCwd, fullEnv, cols, rows, shellIntEnv);
  }

  /** Spawn a PTY directly in the extension host process. */
  private _spawnDirectPty(
    tabId: number,
    command: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    cols?: number,
    rows?: number,
    shellIntEnv?: Record<string, string>,
  ): void {
    const ptyProcess = pty.spawn(command, args, {
      name: TERMINAL_DEFAULTS.TERM_TYPE,
      cols: cols || TERMINAL_DEFAULTS.PTY_COLS,
      rows: rows || TERMINAL_DEFAULTS.PTY_ROWS,
      cwd,
      env,
    });

    if (shellIntEnv?.ALTERMINAL_SHELL_INIT) {
      // Suppress kernel TTY echo so the stuffed command is invisible.
      // Open the slave PTY device and run stty -echo on it before writing,
      // then re-enable echo after.
      const slavePty = (ptyProcess as any)._pty as string | undefined;
      if (slavePty) {
        try {
          const fd = fs.openSync(slavePty, fs.constants.O_RDWR | fs.constants.O_NOCTTY);
          try { execFileSync("stty", ["-echo"], { stdio: [fd, "pipe", "pipe"] }); } finally { fs.closeSync(fd); }
        } catch { /* stty failed — echo will be visible but init still works */ }
      }
      ptyProcess.write(` source "$ALTERMINAL_SHELL_INIT" 2>/dev/null; unset ALTERMINAL_SHELL_INIT\r`);
      if (slavePty) {
        try {
          const fd = fs.openSync(slavePty, fs.constants.O_RDWR | fs.constants.O_NOCTTY);
          try { execFileSync("stty", ["echo"], { stdio: [fd, "pipe", "pipe"] }); } finally { fs.closeSync(fd); }
        } catch { /* ignore */ }
      }
    }

    ptyProcess.onData((data) => {
      this._handlePtyData(tabId, data);
    });

    ptyProcess.onExit(() => {
      this._cleanupProcess(tabId);
    });

    this._ptyProcesses.set(tabId, ptyProcess);

    if (cwd) {
      this._handleCwdChange(tabId, cwd);
    }

    this._startProcessMonitoring(tabId);
  }

  public writeToPty(data: string, tabId: number): void {
    // Daemon mode — chunking happens in the daemon process
    const ptyId = this._tabPtyIds.get(tabId);
    if (ptyId && this._daemonClient?.connected) {
      this._daemonClient.write(ptyId, data);
      return;
    }
    // Direct mode
    const proc = this._ptyProcesses.get(tabId);
    if (!proc) return;
    proc.write(data);
  }

  public resizePty(cols: number, rows: number, tabId: number): void {
    this._tabDims.set(tabId, { cols, rows });
    // Daemon mode
    const ptyId = this._tabPtyIds.get(tabId);
    if (ptyId && this._daemonClient?.connected) {
      this._daemonClient.resize(ptyId, cols, rows);
      return;
    }
    // Direct mode
    this._ptyProcesses.get(tabId)?.resize(cols, rows);
  }

  public sendFilePath(filePath: string, tabId: number): void {
    // shellEscape: quote+escape only when needed; trailing space lets the user
    // keep typing. Shared with the daemon-spawn escaping (one quoting rule).
    const text = `${shellEscape(filePath)} `;
    // Daemon mode
    const ptyId = this._tabPtyIds.get(tabId);
    if (ptyId && this._daemonClient?.connected) {
      this._daemonClient.write(ptyId, text);
      return;
    }
    // Direct mode
    this._ptyProcesses.get(tabId)?.write(text);
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

    // Kill PTY process (direct mode)
    const ptyProcess = this._ptyProcesses.get(tabId);
    if (ptyProcess) {
      ptyProcess.kill();
      this._ptyProcesses.delete(tabId);
    }

    // Kill PTY process (daemon mode)
    const ptyId = this._tabPtyIds.get(tabId);
    if (ptyId) {
      if (this._daemonClient?.connected) {
        this._daemonClient.kill(ptyId);
      }
      this._tabPtyIds.delete(tabId);
      this._ptyIdToTab.delete(ptyId);
    }

    // Clean up state
    this._currentProcessNames.delete(tabId);
    this._terminalTypes.delete(tabId);
    this._currentWorkingDirs.delete(tabId);
    this._userVars.delete(tabId);
    this._shellIntegrationTabs.delete(tabId);
    this._bellDetector.delete(tabId);
    this._tabDims.delete(tabId);
    this._clearOnNextData.delete(tabId);
    Debouncer.cancel(`process-check-${tabId}`);

    // Clear output buffer for this tab
    this._outputBuffer.delete(tabId);
  }

  /**
   * Write dropped file bytes to a temp file and schedule a 60s cleanup.
   * Returns the absolute path. Used by file-drop flows that need to hand
   * a real path to the running program (Claude Code's image-attach,
   * shell consumers of binary files, etc.).
   */
  public async writeDroppedFileToTemp(
    fileData: string,
    fileName: string,
  ): Promise<string> {
    const tempDir = os.tmpdir();
    const safeName = path.basename(fileName).replace(/[/\\]/g, "_");
    // Random component (not Date.now): unpredictable name closes the temp-file
    // pre-creation/symlink race, and is collision-free for multiple drops within
    // the same millisecond.
    const tempFileName = `alterminal-${crypto.randomBytes(8).toString("hex")}-${safeName}`;
    const tempFilePath = path.join(tempDir, tempFileName);

    let buffer: Buffer;
    if (fileData.startsWith("data:")) {
      const base64Data = fileData.split(",")[1];
      buffer = Buffer.from(base64Data, "base64");
    } else {
      buffer = Buffer.from(fileData, "utf8");
    }

    // wx: fail rather than clobber/follow a pre-existing path; 0o600: owner-only
    // (the consuming program runs as the same user).
    await fs.promises.writeFile(tempFilePath, buffer, { flag: "wx", mode: 0o600 });
    setTimeout(() => fs.promises.unlink(tempFilePath).catch(() => {}), 60_000);
    return tempFilePath;
  }

  public async sendFileData(
    fileData: string,
    fileName: string,
    _fileType: string,
    tabId: number,
  ): Promise<void> {
    try {
      const tempFilePath = await this.writeDroppedFileToTemp(fileData, fileName);
      // Escaped path for shell consumers; trailing space lets the user keep typing.
      this.writeToPty(`${shellEscape(tempFilePath)} `, tabId);
    } catch (error) {
      Logger.error("Error writing file to temp:", error);
      this.writeToPty(`${shellEscape(fileName)} `, tabId);
    }
  }

  public dispose(): void {
    // Clean up direct-mode PTY processes only
    const directTabIds = Array.from(this._ptyProcesses.keys());
    for (const tabId of directTabIds) {
      this._cleanupProcess(tabId);
    }

    // Disconnect from daemon WITHOUT killing daemon PTYs.
    // The daemon keeps PTYs alive for reattach on next activation.
    if (this._daemonClient) {
      this._daemonClient.removeAllListeners();
      // Don't call kill() on daemon PTYs — just clear local mappings
      this._daemonClient = null;
    }
    this._tabPtyIds.clear();
    this._ptyIdToTab.clear();
    this._liveDaemonPtys.clear();

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
    return this._ptyProcesses.size > 0 || this._tabPtyIds.size > 0;
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
    for (const [tabId] of this._ptyProcesses.entries()) {
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
      } satisfies ExtToWebviewMessage);
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
   * Check for child processes of a PTY's shell and respond to the webview.
   * Used for close-tab protection: warns user if processes are still running.
   * Enumerates ALL children (foreground + background), matching Terminal.app behavior.
   * Filters out processes that are the same as the root shell (e.g., zsh forking
   * for job control) — only warns about genuinely different programs.
   */
  private _checkChildProcesses(tabId: number): void {
    // Get shell PID — direct mode or daemon mode.
    // Use the ORIGINAL shell name (from SHELL env or spawn command),
    // not ptyProcess.process which returns the current foreground process.
    const ptyProcess = this._ptyProcesses.get(tabId);
    const pid = ptyProcess?.pid;
    const shellName = process.env.SHELL ? path.basename(process.env.SHELL) : undefined;
    Logger.info(`[close-guard] tabId=${tabId} pid=${pid ?? "none"} shell=${shellName ?? "?"} hasPty=${!!ptyProcess} daemonPtyId=${this._tabPtyIds.get(tabId) ?? "none"}`);

    if (!pid) {
      // Daemon mode: query the daemon for PID
      const ptyId = this._tabPtyIds.get(tabId);
      if (ptyId && this._daemonClient?.connected) {
        this._daemonClient.list().then((ptys) => {
          const entry = ptys.find(p => p.ptyId === ptyId);
          if (entry?.pid) {
            const daemonShellName = path.basename(entry.processName || "");
            this._getChildProcesses(entry.pid, daemonShellName, (procs) => {
              this._sendCheckProcessesResponse(tabId, procs);
            });
          } else {
            this._sendCheckProcessesResponse(tabId, []);
          }
        }).catch(() => {
          this._sendCheckProcessesResponse(tabId, []);
        });
        return;
      }
      // No PID available — allow close
      this._sendCheckProcessesResponse(tabId, []);
      return;
    }

    this._getChildProcesses(pid, shellName, (procs) => {
      this._sendCheckProcessesResponse(tabId, procs);
    });
  }

  /**
   * Get all child processes of a given PID.
   * Uses pgrep on Unix (lists ALL children, including background jobs).
   * Filters out processes matching the root shell name (shell forks for job control).
   */
  private _getChildProcesses(
    pid: number,
    shellName: string | undefined,
    callback: (procs: Array<{ pid: number; name: string }>) => void,
  ): void {
    if (process.platform === "win32") {
      // Windows: use wmic or tasklist — punt for now
      callback([]);
      return;
    }

    // pgrep -P <pid> lists direct child PIDs
    execFile("pgrep", ["-P", String(pid)], { encoding: "utf8", timeout: 2000 }, (err, stdout) => {
      Logger.info(`[close-guard] pgrep -P ${pid}: err=${err?.message ?? "none"} stdout="${stdout?.trim() ?? ""}"`);
      if (err || !stdout.trim()) {
        callback([]);
        return;
      }

      const childPids = stdout.trim().split("\n").map(Number).filter(Boolean);
      if (childPids.length === 0) {
        callback([]);
        return;
      }

      // Get process names for each child PID via ps
      execFile("ps", ["-o", "pid=,comm=", "-p", childPids.join(",")], {
        encoding: "utf8",
        timeout: 2000,
      }, (psErr, psStdout) => {
        if (psErr || !psStdout.trim()) {
          // Have PIDs but can't get names — report as unknown
          callback(childPids.map(p => ({ pid: p, name: "unknown" })));
          return;
        }

        const procs = psStdout.trim().split("\n").map(line => {
          const trimmed = line.trim();
          const spaceIdx = trimmed.indexOf(" ");
          if (spaceIdx === -1) return null;
          const cpid = parseInt(trimmed.substring(0, spaceIdx), 10);
          const comm = path.basename(trimmed.substring(spaceIdx + 1).trim());
          return cpid && comm ? { pid: cpid, name: comm } : null;
        }).filter(Boolean) as Array<{ pid: number; name: string }>;

        // Filter out child processes that match the root shell — these are
        // shell forks for job control, not user-launched programs.
        const shellBase = shellName ? path.basename(shellName) : "";
        const nonShell = shellBase
          ? procs.filter(p => p.name !== shellBase)
          : procs;

        Logger.info(`[close-guard] children: ${JSON.stringify(procs)} shell="${shellBase}" → nonShell: ${JSON.stringify(nonShell)}`);
        callback(nonShell);
      });
    });
  }

  private _sendCheckProcessesResponse(
    tabId: number,
    processes: Array<{ pid: number; name: string }>,
  ): void {
    this._alterminal?.webview.postMessage({
      command: "checkProcessesResponse",
      tabId,
      processes,
    } satisfies ExtToWebviewMessage);
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
    timer.unref();

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
