import * as vscode from "vscode";
import { Debouncer } from "../utils/debouncer";
import { Logger } from "../utils/logger";
import { DEBOUNCE_TIMINGS } from "../constants";

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
   * Restore webview state from extension context
   */
  public async restoreWebviewState(
    webview: vscode.Webview,
    onStateRestored?: () => void,
  ): Promise<void> {
    try {
      if (this._restoreTriggered) {
        Logger.debug("⏭️ Restore already triggered, skipping duplicate restore");
        return;
      }

      this._restoreTriggered = true;

      const state = this.context.workspaceState.get("alterminal.webviewState") as any;

      if (state && state.terminals && state.terminals.length > 0) {
        Logger.debug("🔄 Restoring saved state", {
          isColdBoot: this._isColdBoot,
        });
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
   * Save state to workspace state with debouncing
   */
  public saveState(state: any): void {
    Debouncer.debounce(
      "backup-state-save",
      DEBOUNCE_TIMINGS.BACKUP_STATE_SAVE,
      async () => {
        try {
          if (state) {
            await this.context.workspaceState.update("alterminal.webviewState", {
              terminals: state.terminals || [],
              activeTabId: state.activeTabId || 1,
              timestamp: Date.now(),
            });
            Logger.debug("💾 Backup state saved");
          }
        } catch (error) {
          Logger.error("Failed to save backup state:", error);
        }
      },
      { maxWait: DEBOUNCE_TIMINGS.BACKUP_STATE_SAVE_MAX_WAIT },
    );
  }

  /**
   * Clear saved state
   */
  public async clearState(): Promise<void> {
    try {
      await this.context.workspaceState.update("alterminal.webviewState", undefined);
      Logger.debug("🗑️ State cleared");
    } catch (error) {
      Logger.error("Failed to clear state:", error);
    }
  }
}
