import * as vscode from "vscode";
import { Logger } from "../utils/logger";
import { PtyManager } from "../terminal/ptyManager";
import { TemplateUtils } from "../utils/templateUtils";

/**
 * TerminalController
 *
 * Responsibility: High-level terminal operations and control
 *
 * SOLID Principles:
 * - Single Responsibility: Only handles terminal control operations
 * - Open/Closed: Can add new operations without changing existing
 * - Dependency Inversion: Depends on abstractions (webview, ptyManager)
 */
export class TerminalController {
  constructor(
    private readonly getWebview: () => vscode.Webview | undefined,
    private readonly ptyManager: PtyManager,
    private readonly extensionUri: vscode.Uri,
  ) {}

  /**
   * Create a new terminal tab
   */
  public createNewTab(type?: string): void {
    const webview = this.getWebview();
    if (webview) {
      webview.postMessage({
        command: "createNewTab",
        terminalType: type,
      });
    }
  }

  /**
   * Create a new terminal tab with a command
   */
  public createNewTabWithCommand(cmd: string): void {
    const webview = this.getWebview();
    if (webview) {
      webview.postMessage({
        command: "createNewTab",
        terminalType: "command",
        launchCommand: cmd,
      });
    }
  }

  /**
   * Focus the terminal view
   */
  public async openTerminal(): Promise<void> {
    await vscode.commands.executeCommand("alterminalView.focus");
  }

  /**
   * Trigger terminal resize
   */
  public triggerResize(): void {
    const webview = this.getWebview();
    if (webview) {
      webview.postMessage({ command: "triggerResize" });
    }
  }

  /**
   * Request performance report from terminals
   */
  public async requestPerformanceReport(): Promise<void> {
    const webview = this.getWebview();
    if (webview) {
      webview.postMessage({ command: "collectPerformance" });
    }
  }

  /**
   * Set debug filter for developer mode
   */
  public setDebugFilter(filter: string[] | null): void {
    const webview = this.getWebview();
    if (webview) {
      webview.postMessage({ command: "setDebugFilter", filter });
      Logger.info(`Debug filter ${filter ? "set" : "cleared"}:`, filter);
    }
  }

  /**
   * Refresh/restart all terminals
   */
  public async refresh(getWebviewView: () => vscode.WebviewView | undefined): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Restarting Alterminal...",
        cancellable: false,
      },
      async (progress) => {
        try {
          progress.report({ increment: 0, message: "Disposing terminals..." });

          // Kill all PTY processes
          Logger.debug("🔄 Refresh: Disposing PTY processes...");
          this.ptyManager.dispose();

          progress.report({ increment: 50, message: "Disposing webview..." });

          progress.report({ increment: 75, message: "Reinitializing..." });

          // Reset webview HTML to force complete reload
          const view = getWebviewView();
          if (view) {
            Logger.debug("🔄 Refresh: Resetting webview HTML...");
            const timeNow = new Date().getTime();
            view.webview.html = TemplateUtils.getHtmlTemplate(
              this.extensionUri,
              view.webview,
              timeNow,
            );
            Logger.debug("🔄 Refresh: HTML reset complete, waiting for webviewReady...");
          } else {
            Logger.warn("🔄 Refresh: No webview view available!");
          }

          progress.report({ increment: 100, message: "Complete!" });

          vscode.window.showInformationMessage(
            "Alterminal restarted successfully!",
          );
        } catch (error) {
          Logger.error("Error during refresh:", error);
          vscode.window.showErrorMessage(
            `Failed to restart Alterminal: ${error}`,
          );
        }
      },
    );
  }
}
