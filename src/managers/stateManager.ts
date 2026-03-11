import * as vscode from "vscode";
import * as crypto from "crypto";
import { Logger } from "../utils/logger";

const METADATA_KEY = "alterminal.state";
const BUFFER_KEY_PREFIX = "alterminal.buffer.";

/**
 * StateManager
 *
 * Responsibility: Handle state persistence and restoration for terminals
 *
 * Storage layout:
 *   alterminal.state           → Tab metadata (no buffers) — clean, small JSON
 *   alterminal.buffer.<uuid>   → Serialized terminal buffer for one tab
 */
export class StateManager {
  private _isColdBoot = true;
  private _restoreTriggered = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
  ) {}

  public isColdBoot(): boolean {
    return this._isColdBoot;
  }

  public markRestoreTriggered(): void {
    this._restoreTriggered = true;
  }

  public hasRestoreTriggered(): boolean {
    return this._restoreTriggered;
  }

  public resetForNewWebview(): void {
    Logger.debug(`🔃 StateManager.resetForNewWebview() called, was _restoreTriggered=${this._restoreTriggered}`);
    this._restoreTriggered = false;
  }

  public resetRestoreTrigger(): void {
    Logger.debug(`🔄 StateManager.resetRestoreTrigger() called, was _restoreTriggered=${this._restoreTriggered}`);
    this._restoreTriggered = false;
  }

  public hasSavedState(): boolean {
    const state = this.context.workspaceState.get(METADATA_KEY) as any;
    return !!(state && state.terminals && state.terminals.length > 0);
  }

  // ── Read ──────────────────────────────────────────────────────

  /**
   * Read metadata from storage, run migration if needed, assemble
   * buffers from separate keys, and return the full state object.
   * Returns null if no saved state exists.
   */
  /**
   * Set of UUIDs whose buffers should be skipped during restore
   * (e.g. daemon has live PTYs that will replay their own output).
   */
  public skipBufferUuids = new Set<string>();

  public getFullState(): any | null {
    let state = this.context.workspaceState.get(METADATA_KEY) as any;
    if (!state?.terminals?.length) return null;

    state = this._migrateIfNeeded(state);

    const terminals = state.terminals.map((t: any) => {
      const skip = t.uuid && this.skipBufferUuids.has(t.uuid);
      const buffer = (!skip && t.uuid)
        ? (this.context.workspaceState.get(`${BUFFER_KEY_PREFIX}${t.uuid}`) as string) || ""
        : "";
      return { ...t, buffer };
    });

    return { ...state, terminals };
  }

  /**
   * Read metadata only (no buffers). This is what "Show Saved State" displays.
   */
  public getMetadata(): any | null {
    return this.context.workspaceState.get(METADATA_KEY) as any ?? null;
  }

  // ── Write ─────────────────────────────────────────────────────

  /**
   * Save metadata (no buffers) to workspace state.
   */
  public saveMetadata(state: any): void {
    try {
      if (!state?.terminals?.length) {
        Logger.warn("🛡️ Refusing to save empty metadata");
        return;
      }

      this.context.workspaceState.update(METADATA_KEY, {
        terminals: state.terminals,
        activeTabId: state.activeTabId || 1,
        timestamp: Date.now(),
      });
    } catch (error) {
      Logger.error("Failed to save metadata:", error);
    }
  }

  /**
   * Save buffers to workspace state, each under its own key.
   */
  public saveBuffers(buffers: Record<string, string>): void {
    try {
      for (const [uuid, content] of Object.entries(buffers)) {
        this.context.workspaceState.update(`${BUFFER_KEY_PREFIX}${uuid}`, content);
      }
    } catch (error) {
      Logger.error("Failed to save buffers:", error);
    }
  }

  /**
   * Delete a single buffer key (used when a tab is closed).
   */
  public deleteBuffer(uuid: string): void {
    try {
      this.context.workspaceState.update(`${BUFFER_KEY_PREFIX}${uuid}`, undefined);
      Logger.debug(`🗑️ Buffer deleted for ${uuid}`);
    } catch (error) {
      Logger.error("Failed to delete buffer:", error);
    }
  }

  /**
   * Legacy saveState — accepts full state with embedded buffers,
   * splits into metadata + buffers, and saves both.
   */
  public saveState(state: any): void {
    if (!state?.terminals?.length) {
      Logger.warn("🛡️ Refusing to save empty state");
      return;
    }

    try {
      // Strip buffers, ensure UUIDs
      const buffers: Record<string, string> = {};
      const metaTerminals = state.terminals.map((t: any) => {
        const { buffer, ...meta } = t;
        if (!meta.uuid) meta.uuid = crypto.randomUUID();
        if (buffer) buffers[meta.uuid] = buffer;
        return meta;
      });

      this.saveMetadata({ ...state, terminals: metaTerminals });
      this.saveBuffers(buffers);
    } catch (error) {
      Logger.error("Failed to save state:", error);
    }
  }

  // ── Restore (send to webview) ─────────────────────────────────

  /**
   * Restore webview state from storage and send to webview.
   * Guarded by _restoreTriggered to prevent duplicate initial restores.
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
      this._sendStateToWebview(webview);

      // After first restore, subsequent webview re-shows are warm boots
      this._isColdBoot = false;

      if (onStateRestored) onStateRestored();
    } catch (error) {
      Logger.error("Failed to restore webview state:", error);
      webview.postMessage({ command: "initializeEmpty", cold: this._isColdBoot });
    }
  }

  /**
   * Push current persisted state to the webview (no guard).
   * Used after external edits (e.g. debugState save-back).
   */
  public pushStateToWebview(webview: vscode.Webview): void {
    this._sendStateToWebview(webview);
  }

  private _sendStateToWebview(webview: vscode.Webview): void {
    const fullState = this.getFullState();
    if (fullState) {
      Logger.debug(`🔄 Sending ${fullState.terminals.length} terminal(s) to webview`);
      webview.postMessage({
        command: "restoreState",
        state: fullState,
        cold: this._isColdBoot,
        liveDaemonUuids: this.skipBufferUuids.size > 0 ? [...this.skipBufferUuids] : undefined,
      });
    } else {
      Logger.debug("🆕 No saved state, initializing empty");
      webview.postMessage({ command: "initializeEmpty", cold: this._isColdBoot });
    }
  }

  // ── Clear ─────────────────────────────────────────────────────

  public async clearState(): Promise<void> {
    try {
      for (const key of this.context.workspaceState.keys()) {
        if (key.startsWith(BUFFER_KEY_PREFIX)) {
          await this.context.workspaceState.update(key, undefined);
        }
      }
      await this.context.workspaceState.update(METADATA_KEY, undefined);
      Logger.debug("🗑️ State cleared (metadata + all buffers)");
    } catch (error) {
      Logger.error("Failed to clear state:", error);
    }
  }

  // ── Migration ─────────────────────────────────────────────────

  private _migrateIfNeeded(state: any): any {
    const needsMigration = state.terminals.some((t: any) => t.buffer !== undefined && !t.uuid);
    if (!needsMigration) return state;

    Logger.info("🔄 Migrating legacy state: splitting buffers into separate keys");

    const migratedTerminals = state.terminals.map((t: any) => {
      const uuid = t.uuid || crypto.randomUUID();
      if (t.buffer) {
        this.context.workspaceState.update(`${BUFFER_KEY_PREFIX}${uuid}`, t.buffer);
      }
      const { buffer, ...meta } = t;
      return { ...meta, uuid };
    });

    const migratedState = { ...state, terminals: migratedTerminals };
    this.context.workspaceState.update(METADATA_KEY, migratedState);
    Logger.info(`🔄 Migration complete: ${migratedTerminals.length} terminal(s) migrated`);
    return migratedState;
  }
}
