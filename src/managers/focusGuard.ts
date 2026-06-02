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

  /** How recently the user must have interacted for us to reclaim focus. */
  static readonly INTERACTION_WINDOW_MS = 2000;

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

    // Reclaim immediately on the event — no timer. show(false) re-focuses our
    // panel view; the webview's window 'focus' handler then lands keyboard
    // focus on the xterm textarea. VS Code's own webview re-focus (an internal
    // ~50ms Delayer inside WebviewElement) re-fires that focus handler AFTER
    // the terminal's setTimeout(0) focus grab, so we win the last exchange
    // without any timer of our own.
    this._view.show(false);

    return true;
  }
}
