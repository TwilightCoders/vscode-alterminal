import * as vscode from "vscode";
import { PtyManager } from "../terminal/ptyManager";
import { CommandLauncher } from "./commandLauncher";
import { FileOperationHandler } from "./fileOperationHandler";
import { TabContextMenuHandler } from "./tabContextMenuHandler";
import { StateManager } from "./stateManager";
import { Logger } from "../utils/logger";
import {
  BellNotificationService,
  createBellNotificationHost,
} from "./bellNotificationService";
import type {
  WebviewToExtMessage,
  ExtToWebviewMessage,
  AnyMessage,
  PerformanceData,
  ExtractByCommand,
} from "../shared/messages";

/**
 * Handler map keyed by the command discriminator. Each handler receives the
 * message already narrowed to its variant, so reading a field that does not
 * exist on that command is a compile error.
 */
type WebviewToExtHandlers = {
  [K in WebviewToExtMessage["command"]]?: (
    msg: ExtractByCommand<WebviewToExtMessage, K>,
  ) => void;
};

/**
 * MessageDispatcher
 *
 * Responsibility: Route messages from webview to appropriate handlers
 */
export class MessageDispatcher {
  private readonly bellNotifications: BellNotificationService;
  // Set by the provider once the per-window cross-window-bell coordinator
  // exists. Until then, publishing is a no-op.
  private _crossWindowPublish: (body: string) => void = () => {};

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
  ) {
    this.bellNotifications = new BellNotificationService(
      createBellNotificationHost((body) => this._crossWindowPublish(body)),
    );
  }

  /** Wire the cross-window bell publisher (called by the provider). */
  public setCrossWindowPublish(fn: (body: string) => void): void {
    this._crossWindowPublish = fn;
  }

  /**
   * Set up message routing for webview
   */
  public setupMessageRouter(alterminal: vscode.WebviewView): void {
    // Provider-specific message handlers
    const providerHandlers: WebviewToExtHandlers = {
      fileDrop: (msg) =>
        this.fileOperationHandler.handleDroppedFile(
          msg.tabId,
          msg.fileName,
          msg.fileType,
          msg.fileSize,
          msg.fileData,
        ),
      openFile: (msg) =>
        this.fileOperationHandler.handleOpenFile(msg.filePath, msg.terminalId),
      openUrl: (msg) =>
        this.fileOperationHandler.handleOpenUrl(msg.url),
      metadataUpdate: (msg) => {
        this.stateManager.saveMetadata(msg.state);
      },
      bufferUpdate: (msg) => {
        this.stateManager.saveBuffers(msg.buffers);
      },
      bufferDelete: (msg) => {
        this.stateManager.deleteBuffer(msg.uuid);
      },
      stateUpdate: (msg) => {
        // Legacy fallback: full state with buffers embedded
        this.stateManager.saveState(msg.state);
        if (this.serializerHandleMessage) {
          this.serializerHandleMessage(msg);
        }
      },
      stateResponse: (msg) => {
        this.stateManager.saveState(msg.state);
        if (this.serializerHandleMessage) {
          this.serializerHandleMessage(msg);
        }
      },
      webviewReady: () => {
        Logger.debug("Received webviewReady message");
        this.onWebviewReady();
      },
      switchTab: (msg) => {
        if (msg.tabId !== undefined) {
          this.bellNotifications.clearBellForTab(msg.tabId);
        }
      },
      bellDiagnostic: (msg) =>
        Logger.warn(`🔔 Webview bell [tab ${msg.tabId}] source: ${msg.source}`),
      playBellSound: (msg) =>
        this.bellNotifications.handleBellSound(msg.tabId, msg.tabLabel ?? ""),
      panelFocused: () => this.bellNotifications.clearBellIndicator(),
      setDebugFilter: () => {}, // Handled in webview
      debugLog: () => {}, // Disabled
      setDeveloperMode: () => {}, // Handled in webview
      performanceReport: (msg) => this._handlePerformanceReport(msg.data),
      saveCommand: (msg) =>
        this.commandLauncher.handleSaveCommand(
          msg.tabId,
          msg.launchCommand,
          msg.tabLabel,
        ),
      checkCommandSaved: (msg) =>
        this.commandLauncher.handleCheckCommandSaved(
          msg.launchCommand,
          alterminal.webview,
        ),
      formatTabTitle: (msg) => this.onFormatTabTitle(msg),
      bufferContent: (msg) =>
        this.tabContextMenuHandler.handleBufferContentResponse(
          msg.tabId,
          msg.buffer,
        ),
      clipboardCopy: (msg) =>
        vscode.env.clipboard.writeText(msg.text),
      openSettings: () =>
        vscode.commands.executeCommand("workbench.action.openSettings", "alterminal"),
      // PTY input — hottest message, handled inline for direct dispatch
      data: (msg) => {
        const d = typeof msg.data === "string" ? msg.data : "";
        this.ptyManager.writeToPty(d, msg.tabId);
      },
    };

    alterminal.webview.onDidReceiveMessage(
      (message: AnyMessage) => {
        try {
          // Record user interaction for focus guard
          this.onInteraction?.();

          // Direct O(1) lookup for both provider and hot-path messages.
          // TS can't correlate the indexed-access key with the handler's
          // narrowed parameter, so the lookup is cast; each handler body is
          // still fully typed against its own command variant.
          const handler = providerHandlers[
            message.command as WebviewToExtMessage["command"]
          ] as ((msg: AnyMessage) => void) | undefined;
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
    const message = `Terminal Performance: ${data.count} samples, avg init: ${(data.avgInit ?? 0).toFixed(0)}ms, avg activation: ${(data.avgOpenToActive ?? 0).toFixed(0)}ms`;
    vscode.window.showInformationMessage(message);
    Logger.info("Performance Report:", data);
  }

  public handleBellSound(tabId: number, tabLabel: string): void {
    this.bellNotifications.handleBellSound(tabId, tabLabel);
    // Also notify the webview so the in-tab bell icon shows
    this.getWebview()?.postMessage({ command: "bell", tabId } satisfies ExtToWebviewMessage);
  }

  /**
   * Clear the window title bell indicator (called when panel becomes visible).
   * Defers if a bell fired very recently to avoid clearing before the user sees it.
   */
  public clearBellIndicator(): void {
    this.bellNotifications.clearBellIndicator();
  }

  /** Clear pending bell for a specific tab (e.g. user switched to it). */
  public clearBellForTab(tabId: number): void {
    this.bellNotifications.clearBellForTab(tabId);
  }

  /**
   * Clean up bell tracking state for a closed tab.
   */
  public handleTabClosed(tabId: number): void {
    this.bellNotifications.handleTabClosed(tabId);
  }

  /**
   * Register the `${bell}` window title variable. Call once at activation.
   */
  public static registerTitleVariable(): void {
    BellNotificationService.registerTitleVariable();
  }
}
