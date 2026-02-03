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
      // Try platform-specific bell first
      const platform = process.platform;
      let bellCommand: string | undefined;

      if (platform === "darwin") {
        // macOS: Use afplay with system beep sound
        bellCommand = 'afplay /System/Library/Sounds/Tink.aiff';
      } else if (platform === "linux") {
        // Linux: Try paplay (PulseAudio) or aplay (ALSA)
        bellCommand = 'paplay /usr/share/sounds/freedesktop/stereo/bell.oga || aplay /usr/share/sounds/freedesktop/stereo/bell.wav';
      } else if (platform === "win32") {
        // Windows: Use PowerShell to play system beep
        bellCommand = 'powershell -c "[console]::beep(800,200)"';
      }

      if (bellCommand) {
        const { exec } = require('child_process');
        exec(bellCommand, (error: Error | null) => {
          if (error) {
            Logger.debug(`Bell sound failed on ${platform}, error:`, error.message);
            // Fallback to visual notification
            this.showBellNotification(tabId, tabLabel);
          }
        });
      } else {
        // Unknown platform, show visual notification
        this.showBellNotification(tabId, tabLabel);
      }
    } catch (error) {
      Logger.error("Failed to play bell sound:", error);
      // Fallback to visual notification
      this.showBellNotification(tabId, tabLabel);
    }
  }

  /**
   * Show visual bell notification
   */
  private showBellNotification(tabId: number, tabLabel: string): void {
    vscode.window.showInformationMessage(
      `🔔 Terminal "${tabLabel}" has output`,
      "Show Terminal"
    ).then(selection => {
      if (selection === "Show Terminal") {
        vscode.commands.executeCommand("alterminal.focus");
      }
    });
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
