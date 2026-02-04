import * as vscode from "vscode";
import { Logger } from "../utils/logger";

/**
 * StateManager
 *
 * Responsibility: Handle state persistence and restoration for terminals
 *
 * SOLID Principles:
 * - Single Responsibility: Only manages state save/restore operations
 * - Open/Closed: Can extend save/restore logic without modifying core
 * - Dependency Inversion: Depends on abstractions (vscode interfaces)
 */
export class StateManager {
  private _isColdBoot = true;
  private _restoreTriggered = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
  ) {}

  /**
   * Check if this is a cold boot (first load) vs warm boot (webview re-shown)
   */
  public isColdBoot(): boolean {
    return this._isColdBoot;
  }

  /**
   * Mark that state restoration has been triggered
   */
  public markRestoreTriggered(): void {
    this._restoreTriggered = true;
  }

  /**
   * Check if state restoration has been triggered
   */
  public hasRestoreTriggered(): boolean {
    return this._restoreTriggered;
  }

  /**
   * Reset restore trigger (used when webview HTML is reloaded)
   * This is called when resolveWebviewView is invoked again, indicating
   * the webview was destroyed and recreated (panel was closed/reopened).
   */
  public resetForNewWebview(): void {
    Logger.debug(`🔃 StateManager.resetForNewWebview() called, was _restoreTriggered=${this._restoreTriggered}`);
    this._restoreTriggered = false;
  }

  /**
   * Reset restore trigger (used when webview becomes visible again)
   */
  public resetRestoreTrigger(): void {
    Logger.debug(`🔄 StateManager.resetRestoreTrigger() called, was _restoreTriggered=${this._restoreTriggered}`);
    this._restoreTriggered = false;
  }

  /**
   * Check if saved state exists
   */
  public hasSavedState(): boolean {
    const state = this.context.workspaceState.get("alterminal.state") as any;
    return !!(state && state.terminals && state.terminals.length > 0);
  }

  /**
   * Restore webview state from extension context
   */
  public async restoreWebviewState(
    webview: vscode.Webview,
    onStateRestored?: () => void,
  ): Promise<void> {
    try {
      Logger.debug(`🔄 StateManager.restoreWebviewState() called, _restoreTriggered=${this._restoreTriggered}`);
      if (this._restoreTriggered) {
        Logger.debug("⏭️ Skipping restore - already triggered");
        return;
      }

      this._restoreTriggered = true;

      const state = this.context.workspaceState.get("alterminal.state") as any;

      if (state && state.terminals && state.terminals.length > 0) {
        Logger.debug(`🔄 Restoring ${state.terminals.length} terminal(s)`);
        webview.postMessage({
          command: "restoreState",
          state: state,
          cold: this._isColdBoot,
        });
      } else {
        Logger.debug("🆕 No saved state, initializing empty");
        webview.postMessage({
          command: "initializeEmpty",
          cold: this._isColdBoot,
        });
      }

      // After first restore, subsequent webview re-shows are warm boots
      this._isColdBoot = false;

      if (onStateRestored) {
        onStateRestored();
      }
    } catch (error) {
      Logger.error("Failed to restore webview state:", error);
      // Initialize empty on error
      webview.postMessage({
        command: "initializeEmpty",
        cold: this._isColdBoot,
      });
    }
  }

  /**
   * Save state to workspace state (immediate, no debounce)
   */
  public saveState(state: any): void {
    try {
      if (!state) {
        return;
      }

      const terminalCount = state.terminals?.length ?? 0;

      // DEFENSIVE: Never save empty state - we always have at least 1 tab
      if (terminalCount === 0) {
        Logger.warn("🛡️ Refusing to save empty state");
        return;
      }

      this.context.workspaceState.update("alterminal.state", {
        terminals: state.terminals,
        activeTabId: state.activeTabId || 1,
        timestamp: Date.now(),
      });
    } catch (error) {
      Logger.error("Failed to save state:", error);
    }
  }

  /**
   * Clear saved state
   */
  public async clearState(): Promise<void> {
    try {
      await this.context.workspaceState.update("alterminal.state", undefined);
      Logger.debug("🗑️ State cleared");
    } catch (error) {
      Logger.error("Failed to clear state:", error);
    }
  }
}
