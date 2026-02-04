import * as vscode from "vscode";
import { Logger } from "../utils/logger";

/**
 * NotificationManager
 *
 * Responsibility: Handle user-facing notifications and alerts
 *
 * SOLID Principles:
 * - Single Responsibility: Only manages UI notifications and feedback
 * - Open/Closed: Can add new notification types without changing existing
 * - Dependency Inversion: Depends on vscode window abstraction
 */
export class NotificationManager {
  constructor(
    private readonly getWebview: () => vscode.Webview | undefined,
    private readonly openTerminal: () => Promise<void>,
  ) {}

  /**
   * Show performance report to user
   */
  public showPerformanceReport(data: PerformanceData): void {
    const message = `Terminal Performance: ${data.count} samples, avg init: ${data.avgInit.toFixed(0)}ms, avg activation: ${data.avgOpenToActive.toFixed(0)}ms`;
    vscode.window.showInformationMessage(message);
    Logger.info("📊 Performance Report:", data);
  }

  /**
   * Play bell sound for terminal alert
   */
  public async playBellSound(tabId: number, tabLabel: string): Promise<void> {
    try {
      // Show clickable notification with action to go to the tab
      vscode.window
        .showInformationMessage(
          `Terminal Bell: ${tabLabel || `Tab ${tabId}`}`,
          "Go to Terminal",
        )
        .then((selection) => {
          if (selection === "Go to Terminal") {
            // Focus the Alterminal view and switch to the specific tab
            this.openTerminal().then(() => {
              // Send message to switch to the specific tab
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

      // Also try to focus the VS Code window (OS-level attention getting)
      vscode.commands
        .executeCommand("workbench.action.focusActiveEditorGroup")
        .then(
          () => {},
          () => {
            // Fallback if focus command fails
          },
        );
    } catch (error) {
      Logger.error("Failed to play bell sound:", error);
    }
  }

  /**
   * Show error notification
   */
  public showError(message: string, error?: any): void {
    vscode.window.showErrorMessage(`Alterminal: ${message}`);
    if (error) {
      Logger.error(message, error);
    }
  }

  /**
   * Show warning notification
   */
  public showWarning(message: string): void {
    vscode.window.showWarningMessage(`Alterminal: ${message}`);
    Logger.warn(message);
  }

  /**
   * Show info notification
   */
  public showInfo(message: string): void {
    vscode.window.showInformationMessage(message);
    Logger.info(message);
  }
}

export interface PerformanceData {
  count: number;
  avgInit: number;
  avgOpenToActive: number;
  samples: any[];
}
