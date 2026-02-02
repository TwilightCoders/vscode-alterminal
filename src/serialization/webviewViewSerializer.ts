/**
 * WebviewViewSerializer
 *
 * Handles all serialization and deserialization logic for the Alterminal WebviewView.
 * Since WebviewView doesn't have built-in serialization support like WebviewPanel,
 * this class provides comprehensive state management for terminal sessions.
 *
 * Responsibilities:
 * - Serialize/deserialize entire TabManager state
 * - Manage extension storage for persistent state
 * - Handle individual terminal content serialization
 * - Restore terminal sessions and their content
 */

import * as vscode from "vscode";
import { Logger } from "../utils/logger";

export interface SerializedTerminal {
  id: number;
  label: string;
  buffer: string; // New simplified name
  modes?: number; // Terminal modes bitmask
  command?: string; // Launch command
  terminalType?: string;
}

export interface PersistedState {
  terminals: SerializedTerminal[];
  activeTabId: number;
  timestamp: number;
}

export class WebviewViewSerializer {
  private static readonly STORAGE_KEY = "alterminal.webviewState";
  private _webviewView?: vscode.WebviewView;
  private _context: vscode.ExtensionContext;
  private _didInitialViewRestore = false;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
  }

  public setWebviewView(webviewView: vscode.WebviewView) {
    this._webviewView = webviewView;
    this.setupWebviewLifecycle();
  }

  /**
   * Set up webview lifecycle event handlers
   */
  private setupWebviewLifecycle() {
    if (!this._webviewView) {
      return;
    }
    // Monitor visibility changes
    this._webviewView.onDidChangeVisibility(() => {
      if (this._webviewView?.visible) {
        // Send initialization commands when webview becomes visible
        this.sendInitializationCommands();
      } else {
        this.saveState();
      }
    });

    // Monitor disposal
    this._webviewView.onDidDispose(() => {
      this.saveState();
    });
  }

  /**
   * Send initialization commands to webview based on saved state
   */
  private sendInitializationCommands(): void {
    if (!this._webviewView) return;

    const savedState = this.loadFromExtensionStorage(this._context);
    if (!this._didInitialViewRestore) {
      if (
        savedState &&
        savedState.terminals &&
        savedState.terminals.length > 0
      ) {
        this._webviewView.webview.postMessage({
          command: "restoreState",
          state: savedState,
          cold: true,
        });
      } else {
        this._webviewView.webview.postMessage({ command: "initializeEmpty" });
      }
      this._didInitialViewRestore = true;
    } else {
      this._webviewView.webview.postMessage({ command: "focus" });
    }
  }

  /**
   * Request state from webview and save it
   */
  public async saveState(): Promise<void> {
    if (!this._webviewView) {
      return;
    }

    this._webviewView.webview.postMessage({ command: "requestState" });
  }

  /**
   * Handle messages intended for the serializer
   */
  public async handleMessage(message: any): Promise<void> {
    switch (message.command) {
      case "stateResponse":
      case "stateUpdate":
        await this.handleStateResponse(message.state);
        break;
      default:
        // Silently ignore unhandled commands - let caller decide what to do
        break;
    }
  }

  /**
   * Check if this serializer can handle a specific message command
   */
  public canHandle(command: string): boolean {
    const serializerCommands = ["stateResponse", "stateUpdate"];
    return serializerCommands.includes(command);
  }

  /**
   * Handle state response from webview and save it
   */
  public async handleStateResponse(state: any): Promise<void> {
    if (!state) {
      return;
    }

    await this.saveToExtensionStorage(this._context, state);
  }

  /**
   * Load state and send it to webview for restoration
   */
  public sendSavedStateToWebview(): void {
    if (!this._webviewView) {
      return;
    }

    const savedState = this.loadFromExtensionStorage(this._context);

    if (savedState && savedState.terminals && savedState.terminals.length > 0) {
      this._webviewView.webview.postMessage({
        command: "restoreState",
        state: savedState,
      });
    } else {
      this._webviewView.webview.postMessage({
        command: "initializeEmpty",
      });
    }
  }

  /**
   * Serialize the current state from TabManager
   */
  public serialize(tabManager: any): PersistedState {
    const terminals: SerializedTerminal[] = [];

    for (const [id, terminal] of tabManager.terminals) {
      const serializedTerminal = this.serializeTerminalContent(terminal);
      terminals.push(serializedTerminal);
    }

    const state = {
      terminals,
      activeTabId: tabManager.activeTabId,
      timestamp: Date.now(),
    };

    return state;
  }

  /**
   * Deserialize state back to TabManager
   *
   * NOTE: This method is designed for potential future use when we need
   * extension-side deserialization. Currently, deserialization happens
   * in the webview context via TabManager.restoreFromState().
   *
   * The separation is maintained because:
   * - WebviewViewSerializer (extension context) handles storage/retrieval
   * - TabManager (webview context) handles UI restoration and terminal creation
   */
  public deserialize(state: PersistedState, tabManager: any): void {
  }

  /**
   * Save state to VS Code's extension storage
   */
  public async saveToExtensionStorage(
    context: vscode.ExtensionContext,
    state: PersistedState,
  ): Promise<void> {
    try {
      await context.workspaceState.update(
        WebviewViewSerializer.STORAGE_KEY,
        state,
      );
    } catch (error) {
      console.error("🚫 Failed to save state to extension storage:", error);
    }
  }

  /**
   * Load state from VS Code's extension storage
   */
  public loadFromExtensionStorage(
    context: vscode.ExtensionContext,
  ): PersistedState | null {
    try {
      const state =
        context.workspaceState.get<PersistedState>(
          WebviewViewSerializer.STORAGE_KEY,
        ) || null;
      return state;
    } catch (error) {
      console.error("🚫 Failed to load state from extension storage:", error);
      return null;
    }
  }

  /**
   * Serialize individual terminal content and metadata
   */
  private serializeTerminalContent(terminal: any): SerializedTerminal {
    const terminalState = terminal.getState ? terminal.getState() : null;
    return {
      id: terminal.id,
      label: terminal.label,
      buffer: terminal.serialize() || "",
      modes: terminalState?.modes,
      command: terminalState?.command,
    };
  }
}
