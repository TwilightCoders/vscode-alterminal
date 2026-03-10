import * as vscode from "vscode";
import { PtyManager } from "../terminal/ptyManager";
import { CommandLauncher } from "./commandLauncher";
import { FileOperationHandler } from "./fileOperationHandler";
import { TabContextMenuHandler } from "./tabContextMenuHandler";
import { StateManager } from "./stateManager";
import { Logger } from "../utils/logger";

export interface PerformanceData {
  count: number;
  avgInit: number;
  avgOpenToActive: number;
  samples: any[];
}

/**
 * MessageDispatcher
 *
 * Responsibility: Route messages from webview to appropriate handlers
 */
export class MessageDispatcher {
  private _bellDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingBells: Map<number, string> = new Map();
  private _unreadBellTabs: Set<number> = new Set();
  private _lastBellTime: number = 0;
  private _clearBellTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-tab timestamp of last notification — suppresses repeated alerts. */
  private _bellNotifiedAt: Map<number, number> = new Map();
  private static readonly BELL_DEBOUNCE_MS = 3000;
  private static readonly BELL_CLEAR_GRACE_MS = 2000;
  /** After notifying for a tab, suppress further notifications for this long. */
  private static readonly BELL_COOLDOWN_MS = 30_000;
  private static readonly TITLE_CONTEXT_KEY = "alterminal:bellIndicator";

  constructor(
    private readonly ptyManager: PtyManager,
    private readonly commandLauncher: CommandLauncher,
    private readonly fileOperationHandler: FileOperationHandler,
    private readonly tabContextMenuHandler: TabContextMenuHandler,
    private readonly stateManager: StateManager,
    private readonly getWebview: () => vscode.Webview | undefined,
    private readonly openTerminal: () => Promise<void>,
    private readonly onFormatTabTitle: (msg: any) => void,
    private readonly onWebviewReady: () => void,
    private readonly serializerHandleMessage?: (msg: any) => void,
    private readonly onInteraction?: () => void,
  ) {}

  /**
   * Set up message routing for webview
   */
  public setupMessageRouter(alterminal: vscode.WebviewView): void {
    // Provider-specific message handlers
    const providerHandlers = {
      fileDrop: (msg: any) =>
        this.fileOperationHandler.handleDroppedFile(
          msg.tabId,
          msg.fileName,
          msg.fileType,
          msg.fileSize,
          msg.fileData,
        ),
      openFile: (msg: any) =>
        this.fileOperationHandler.handleOpenFile(msg.filePath, msg.terminalId),
      openUrl: (msg: any) =>
        this.fileOperationHandler.handleOpenUrl(msg.url),
      metadataUpdate: (msg: any) => {
        this.stateManager.saveMetadata(msg.state);
      },
      bufferUpdate: (msg: any) => {
        this.stateManager.saveBuffers(msg.buffers);
      },
      bufferDelete: (msg: any) => {
        this.stateManager.deleteBuffer(msg.uuid);
      },
      stateUpdate: (msg: any) => {
        // Legacy fallback: full state with buffers embedded
        this.stateManager.saveState(msg.state);
        if (this.serializerHandleMessage) {
          this.serializerHandleMessage(msg);
        }
      },
      stateResponse: (msg: any) => {
        this.stateManager.saveState(msg.state);
        if (this.serializerHandleMessage) {
          this.serializerHandleMessage(msg);
        }
      },
      webviewReady: () => {
        Logger.debug("Received webviewReady message");
        this.onWebviewReady();
      },
      switchTab: () => {}, // No-op - handled in webview
      bellDiagnostic: (msg: any) =>
        Logger.warn(`🔔 Webview bell [tab ${msg.tabId}] source: ${msg.source}`),
      playBellSound: (msg: any) => this.handleBellSound(msg.tabId, msg.tabLabel),
      panelFocused: () => this.clearBellIndicator(),
      setDebugFilter: () => {}, // Handled in webview
      debugLog: () => {}, // Disabled
      setDeveloperMode: () => {}, // Handled in webview
      performanceReport: (msg: any) => this._handlePerformanceReport(msg.data),
      saveCommand: (msg: any) =>
        this.commandLauncher.handleSaveCommand(
          msg.tabId,
          msg.launchCommand,
          msg.tabLabel,
        ),
      checkCommandSaved: (msg: any) =>
        this.commandLauncher.handleCheckCommandSaved(
          msg.launchCommand,
          alterminal.webview,
        ),
      formatTabTitle: (msg: any) => this.onFormatTabTitle(msg),
      bufferContent: (msg: any) =>
        this.tabContextMenuHandler.handleBufferContentResponse(
          msg.tabId,
          msg.buffer,
        ),
      clipboardCopy: (msg: any) =>
        vscode.env.clipboard.writeText(msg.text),
      openSettings: () =>
        vscode.commands.executeCommand("workbench.action.openSettings", "alterminal"),
      // PTY input — hottest message, handled inline for direct dispatch
      data: (msg: any) => {
        const d = typeof msg.data === "string" ? msg.data : "";
        this.ptyManager.writeToPty(d, msg.tabId);
      },
    };

    alterminal.webview.onDidReceiveMessage(
      (message) => {
        try {
          // Record user interaction for focus guard
          this.onInteraction?.();

          // Direct O(1) lookup for both provider and hot-path messages
          const handler =
            providerHandlers[message.command as keyof typeof providerHandlers];
          if (handler) {
            handler(message);
            return;
          }

          // Delegate remaining PTY commands
          if (this.ptyManager?.canHandle(message.command)) {
            this.ptyManager.handleMessage(message);
          } else {
            Logger.warn(`Unhandled message command: ${message.command}`);
          }
        } catch (error) {
          Logger.error(`Error handling message ${message.command}:`, error);
        }
      },
      undefined,
      [],
    );
  }

  private _handlePerformanceReport(data: PerformanceData): void {
    const message = `Terminal Performance: ${data.count} samples, avg init: ${data.avgInit.toFixed(0)}ms, avg activation: ${data.avgOpenToActive.toFixed(0)}ms`;
    vscode.window.showInformationMessage(message);
    Logger.info("Performance Report:", data);
  }

  public handleBellSound(tabId: number, tabLabel: string): void {
    Logger.info(`Bell received: tabId=${tabId}, label=${tabLabel}`);

    // Suppress notification spam: if we already notified for this tab
    // recently, only update the title indicator (no toast).
    const lastNotified = this._bellNotifiedAt.get(tabId) ?? 0;
    const inCooldown = (Date.now() - lastNotified) < MessageDispatcher.BELL_COOLDOWN_MS;

    if (!inCooldown) {
      this._pendingBells.set(tabId, tabLabel || `Tab ${tabId}`);
    }

    // Update window title bell indicator (Set deduplicates PTY + webview calls)
    this._unreadBellTabs.add(tabId);
    this._lastBellTime = Date.now();
    // Cancel any pending clear so the indicator stays visible
    if (this._clearBellTimer) {
      clearTimeout(this._clearBellTimer);
      this._clearBellTimer = null;
    }
    this._updateTitleIndicator();

    if (this._bellDebounceTimer) {
      clearTimeout(this._bellDebounceTimer);
    }

    this._bellDebounceTimer = setTimeout(() => {
      this._bellDebounceTimer = null;
      this._showBellNotification();
    }, MessageDispatcher.BELL_DEBOUNCE_MS);
  }

  /**
   * Clear the window title bell indicator (called when panel becomes visible).
   * Defers if a bell fired very recently to avoid clearing before the user sees it.
   */
  public clearBellIndicator(): void {
    if (this._unreadBellTabs.size === 0) return;

    const elapsed = Date.now() - this._lastBellTime;
    if (elapsed < MessageDispatcher.BELL_CLEAR_GRACE_MS) {
      // Bell fired very recently — defer the clear so user sees it
      if (this._clearBellTimer) return; // already scheduled
      this._clearBellTimer = setTimeout(() => {
        this._clearBellTimer = null;
        this._unreadBellTabs.clear();
        this._bellNotifiedAt.clear();
        this._updateTitleIndicator();
      }, MessageDispatcher.BELL_CLEAR_GRACE_MS - elapsed);
      return;
    }

    this._unreadBellTabs.clear();
    this._bellNotifiedAt.clear();
    this._updateTitleIndicator();
  }

  /**
   * Clean up bell tracking state for a closed tab.
   */
  public handleTabClosed(tabId: number): void {
    this._pendingBells.delete(tabId);
    this._unreadBellTabs.delete(tabId);
    this._bellNotifiedAt.delete(tabId);
  }

  /**
   * Register the window title variable. Call once at activation.
   */
  public static registerTitleVariable(): void {
    vscode.commands.executeCommand(
      "setContext",
      MessageDispatcher.TITLE_CONTEXT_KEY,
      "",
    );
    vscode.commands.executeCommand(
      "registerWindowTitleVariable",
      "alterminalBell",
      MessageDispatcher.TITLE_CONTEXT_KEY,
    );
  }

  private _updateTitleIndicator(): void {
    const icon = vscode.workspace.getConfiguration("alterminal").get<string>("bellIndicator", "\u{1F514}");
    if (!icon) {
      // Empty string = disabled
      vscode.commands.executeCommand("setContext", MessageDispatcher.TITLE_CONTEXT_KEY, "");
      return;
    }
    const count = this._unreadBellTabs.size;
    const value = count > 0
      ? count === 1 ? icon : `${icon}${count}`
      : "";
    vscode.commands.executeCommand(
      "setContext",
      MessageDispatcher.TITLE_CONTEXT_KEY,
      value,
    );
  }

  private _showBellNotification(): void {
    const bells = new Map(this._pendingBells);
    this._pendingBells.clear();

    if (bells.size === 0) return;

    // Mark all notified tabs with the current timestamp for cooldown
    const now = Date.now();
    for (const tabId of bells.keys()) {
      this._bellNotifiedAt.set(tabId, now);
    }

    const labels = Array.from(bells.values());
    const body = bells.size === 1
      ? labels[0]
      : `${bells.size} terminals: ${labels.join(", ")}`;
    const lastTabId = Array.from(bells.keys()).pop();

    Logger.info(`Bell notification: ${body}`);

    // Local notification — no URI routing to avoid focus stealing.
    // Cross-window visibility is provided by the window title bell indicator.
    vscode.window
      .showInformationMessage(`${body}`, "Go to Terminal")
      .then(async (selection) => {
        if (selection !== "Go to Terminal") return;
        this.clearBellIndicator();
        await this.openTerminal();
        setTimeout(() => {
          const webview = this.getWebview();
          if (webview && lastTabId !== undefined) {
            webview.postMessage({
              command: "switchToTab",
              tabId: Number(lastTabId),
            });
          }
        }, 200);
      });
  }
}
