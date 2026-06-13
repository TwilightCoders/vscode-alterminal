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
import type { ExtToWebviewMessage } from "../shared/messages";

export interface SerializedTerminal {
  uuid: string;
  id: number;
  label: string;
  buffer: string; // Serialized terminal content (stored separately in workspaceState)
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
  private static readonly STORAGE_KEY = "alterminal.state";
  private _alterminal?: vscode.WebviewView;
  private _context: vscode.ExtensionContext;
  private _didInitialViewRestore = false;
  // Disposables for the current webview's lifecycle listeners. setAlterminal()
  // runs per resolveWebviewView, so these must be torn down before re-registering
  // or each reload stacks another visibility/dispose listener on a dead webview.
  private _lifecycleDisposables: vscode.Disposable[] = [];

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
  }

  public setAlterminal(alterminal: vscode.WebviewView) {
    this._alterminal = alterminal;
    // Reset flag when a new webview is set - this happens on resolveWebviewView
    this._didInitialViewRestore = false;
    this.setupWebviewLifecycle();
  }

  /**
   * Mark that initial restore has been completed
   * Called by StateManager after it sends restore command
   */
  public markInitialRestoreComplete(): void {
    this._didInitialViewRestore = true;
  }

  /**
   * Set up webview lifecycle event handlers
   */
  private setupWebviewLifecycle() {
    if (!this._alterminal) {
      return;
    }
    // Tear down any prior webview's listeners before re-registering (setAlterminal
    // runs on every resolveWebviewView).
    this._lifecycleDisposables.forEach((d) => d.dispose());
    this._lifecycleDisposables = [];
    // Monitor visibility changes for SUBSEQUENT visibility toggles (after initial restore)
    // Initial restore is handled by webviewReady message -> StateManager.restoreWebviewState
    this._lifecycleDisposables.push(this._alterminal.onDidChangeVisibility(() => {
      if (this._alterminal?.visible) {
        // Only send focus/restore for subsequent visibility changes
        // Initial restore is handled by webviewReady -> StateManager
        if (this._didInitialViewRestore) {
          // Already restored once, just focus
          this._alterminal.webview.postMessage({ command: "focus" } satisfies ExtToWebviewMessage);
        }
        // Note: if _didInitialViewRestore is false, StateManager will handle it via webviewReady
      } else {
        this.saveState();
      }
    }));

    // Monitor disposal
    this._lifecycleDisposables.push(this._alterminal.onDidDispose(() => {
      this.saveState();
    }));
  }

  /**
   * Request state from webview and save it
   */
  public async saveState(): Promise<void> {
    if (!this._alterminal) {
      return;
    }

    this._alterminal.webview.postMessage({ command: "requestState" } satisfies ExtToWebviewMessage);
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
   * Handle state response from webview.
   * Storage is delegated to StateManager (single source of truth for alterminal.state).
   * This method is kept for lifecycle coordination only.
   */
  public async handleStateResponse(state: any): Promise<void> {
    if (!state) {
      return;
    }

    const terminalCount = state.terminals?.length ?? 0;

    // DEFENSIVE: Never save empty state - we always have at least 1 tab
    if (terminalCount === 0) {
      Logger.warn("🛡️ Serializer refusing to save empty state");
      return;
    }

    // Note: StateManager.saveState/saveMetadata handles persistence.
    // We no longer write to the same key here to avoid dual-write races.
  }

  /**
   * Load state and send it to webview for restoration
   */
  public sendSavedStateToWebview(): void {
    if (!this._alterminal) {
      return;
    }

    const savedState = this.loadFromExtensionStorage(this._context);

    if (savedState && savedState.terminals && savedState.terminals.length > 0) {
      this._alterminal.webview.postMessage({
        command: "restoreState",
        state: savedState,
      } satisfies ExtToWebviewMessage);
    } else {
      this._alterminal.webview.postMessage({
        command: "initializeEmpty",
      } satisfies ExtToWebviewMessage);
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
      Logger.error("Failed to load state from extension storage:", error);
      return null;
    }
  }

}
