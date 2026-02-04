import * as vscode from "vscode";
import { PtyManager } from "../terminal/ptyManager";
import { CommandLauncher } from "./commandLauncher";
import { FileOperationHandler } from "./fileOperationHandler";
import { TabContextMenuHandler } from "./tabContextMenuHandler";
import { StateManager } from "./stateManager";
import { NotificationManager } from "./notificationManager";
import { Logger } from "../utils/logger";

/**
 * MessageDispatcher
 *
 * Responsibility: Route messages from webview to appropriate handlers
 *
 * SOLID Principles:
 * - Single Responsibility: Only routes messages, doesn't handle them
 * - Open/Closed: Can add new routes without changing existing
 * - Dependency Inversion: Depends on handler abstractions
 */
export class MessageDispatcher {
  constructor(
    private readonly ptyManager: PtyManager,
    private readonly commandLauncher: CommandLauncher,
    private readonly fileOperationHandler: FileOperationHandler,
    private readonly tabContextMenuHandler: TabContextMenuHandler,
    private readonly stateManager: StateManager,
    private readonly notificationManager: NotificationManager,
    private readonly onFormatTabTitle: (msg: any) => void,
    private readonly onWebviewReady: () => void,
    private readonly serializerHandleMessage?: (msg: any) => void,
  ) {}

  /**
   * Set up message routing for webview
   */
  public setupMessageRouter(webviewView: vscode.WebviewView): void {
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
      stateUpdate: (msg: any) => {
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
        Logger.debug("📨 Received webviewReady message");
        this.onWebviewReady();
      },
      switchTab: () => {}, // No-op - handled in webview
      playBellSound: (msg: any) =>
        this.notificationManager.playBellSound(msg.tabId, msg.tabLabel),
      setDebugFilter: () => {}, // Handled in webview
      debugLog: () => {}, // Disabled
      setDeveloperMode: () => {}, // Handled in webview
      performanceReport: (msg: any) =>
        this.notificationManager.showPerformanceReport(msg.data),
      saveCommand: (msg: any) =>
        this.commandLauncher.handleSaveCommand(
          msg.tabId,
          msg.launchCommand,
          msg.tabLabel,
        ),
      checkCommandSaved: (msg: any) =>
        this.commandLauncher.handleCheckCommandSaved(
          msg.launchCommand,
          webviewView.webview,
        ),
      formatTabTitle: (msg: any) => this.onFormatTabTitle(msg),
      bufferContent: (msg: any) =>
        this.tabContextMenuHandler.handleBufferContentResponse(
          msg.tabId,
          msg.buffer,
        ),
    };

    webviewView.webview.onDidReceiveMessage(
      (message) => {
        try {
          // First, check if provider can handle the message directly
          const providerHandler =
            providerHandlers[message.command as keyof typeof providerHandlers];
          if (providerHandler) {
            providerHandler(message);
            return;
          }

          // Delegate to appropriate manager based on message type
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
}
