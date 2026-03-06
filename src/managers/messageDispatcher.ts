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
      playBellSound: (msg: any) => this._handleBellSound(msg.tabId, msg.tabLabel),
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
          webviewView.webview,
        ),
      formatTabTitle: (msg: any) => this.onFormatTabTitle(msg),
      bufferContent: (msg: any) =>
        this.tabContextMenuHandler.handleBufferContentResponse(
          msg.tabId,
          msg.buffer,
        ),
      clipboardCopy: (msg: any) =>
        vscode.env.clipboard.writeText(msg.text),
      // PTY input — hottest message, handled inline for direct dispatch
      data: (msg: any) => {
        const d = typeof msg.data === "string" ? msg.data : "";
        this.ptyManager.writeToPty(d, msg.tabId);
      },
    };

    webviewView.webview.onDidReceiveMessage(
      (message) => {
        try {
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

  private async _handleBellSound(tabId: number, tabLabel: string): Promise<void> {
    try {
      vscode.window
        .showInformationMessage(
          `Terminal Bell: ${tabLabel || `Tab ${tabId}`}`,
          "Go to Terminal",
        )
        .then((selection) => {
          if (selection === "Go to Terminal") {
            this.openTerminal().then(() => {
              const webview = this.getWebview();
              if (webview) {
                webview.postMessage({
                  command: "switchToTab",
                  tabId: tabId,
                });
              }
            });
          }
        });

      vscode.commands
        .executeCommand("workbench.action.focusActiveEditorGroup")
        .then(
          () => {},
          () => {},
        );
    } catch (error) {
      Logger.error("Failed to play bell sound:", error);
    }
  }
}
