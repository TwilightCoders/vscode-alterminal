import * as vscode from "vscode";
import { Logger } from "../utils/logger";

/**
 * FocusGuard
 *
 * Prevents programmatic focus stealing by other extensions.
 *
 * When the user is actively interacting with Alterminal (recent webview
 * messages) and VS Code's built-in terminal suddenly activates, the guard
 * reclaims focus after a short delay. User-initiated focus changes are
 * allowed through because they happen when Alterminal hasn't been active
 * recently.
 */
export class FocusGuard {
  private _lastInteraction = 0;
  private _view?: vscode.WebviewView;
  private _disposables: vscode.Disposable[] = [];
  private _reclaimTimer?: ReturnType<typeof setTimeout>;

  /** How recently the user must have interacted for us to reclaim focus. */
  static readonly INTERACTION_WINDOW_MS = 2000;
  /** Delay before reclaiming to let VS Code settle. */
  static readonly RECLAIM_DELAY_MS = 150;

  /**
   * Record a user interaction with Alterminal (call on every webview message
   * that implies the user is actively using the terminal).
   */
  public recordInteraction(): void {
    this._lastInteraction = Date.now();
  }

  /** Expose last interaction time for testing. */
  public get lastInteraction(): number {
    return this._lastInteraction;
  }

  /**
   * Start guarding focus. Call once after resolveWebviewView.
   */
  public attach(alterminal: vscode.WebviewView): void {
    this.detach();
    this._view = alterminal;

    // When the built-in terminal panel activates, check if it's a steal
    this._disposables.push(
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        Logger.info(
          `Focus guard: onDidChangeActiveTerminal fired — ` +
          `terminal=${terminal ? terminal.name : 'null'}, ` +
          `elapsed=${Date.now() - this._lastInteraction}ms`,
        );
        if (!terminal) return;
        this._onTerminalActivated();
      }),
    );

    // When our webview becomes visible (user clicked on it), update interaction
    this._disposables.push(
      alterminal.onDidChangeVisibility(() => {
        if (alterminal.visible) {
          this._lastInteraction = Date.now();
        }
      }),
    );
  }

  /**
   * Stop guarding and clean up.
   */
  public detach(): void {
    if (this._reclaimTimer) {
      clearTimeout(this._reclaimTimer);
      this._reclaimTimer = undefined;
    }
    for (const d of this._disposables) d.dispose();
    this._disposables = [];
    this._view = undefined;
  }

  /**
   * Core reclaim logic — public for testability.
   * Returns true if focus will be reclaimed, false if allowed through.
   */
  public onTerminalActivated(): boolean {
    return this._onTerminalActivated();
  }

  private _onTerminalActivated(): boolean {
    if (!this._view) return false;

    const elapsed = Date.now() - this._lastInteraction;
    if (elapsed > FocusGuard.INTERACTION_WINDOW_MS) {
      // User hasn't been in Alterminal recently — this is probably
      // a deliberate focus change. Allow it.
      return false;
    }

    Logger.info(
      `Focus guard: built-in terminal activated ${elapsed}ms after last ` +
      `Alterminal interaction — reclaiming focus`,
    );

    // Small delay so VS Code finishes its focus transition before we override
    if (this._reclaimTimer) clearTimeout(this._reclaimTimer);
    this._reclaimTimer = setTimeout(() => {
      this._reclaimTimer = undefined;
      this._view?.show(false);
    }, FocusGuard.RECLAIM_DELAY_MS);

    return true;
  }
}
