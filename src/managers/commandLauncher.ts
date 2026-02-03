import * as vscode from "vscode";
import { CommandManager } from "../utils/commandManager";
import { Logger } from "../utils/logger";

/**
 * CommandLauncher
 *
 * Responsibility: Manage command launching and quick-pick UI
 *
 * SOLID Principles:
 * - Single Responsibility: Only handles command selection and launching
 * - Open/Closed: Can extend with new command sources without changing core
 * - Dependency Inversion: Depends on CommandManager abstraction
 */
export class CommandLauncher {
  constructor(
    private readonly commandManager: CommandManager,
    private readonly onCommandSelected: (command: string) => void,
  ) {}

  /**
   * Show saved commands picker
   */
  public async showSavedCommands(): Promise<void> {
    await this.launchCommandPicker();
  }

  /**
   * Save the current command
   */
  public async saveCurrentCommand(webview: vscode.Webview): Promise<void> {
    webview.postMessage({ command: "saveCurrentCommand" });
  }

  /**
   * Launch command picker UI
   */
  public async launchCommandPicker(): Promise<void> {
    try {
      const commands = this.commandManager.getSavedCommands();

      if (commands.length === 0) {
        vscode.window.showInformationMessage(
          "No saved commands yet. Right-click a command tab to save it.",
        );
        return;
      }

      const items: CommandQuickPickItem[] = commands.map((cmd) => ({
        label: `$(terminal) ${cmd.label}`,
        description: cmd.command,
        detail: cmd.lastUsed
          ? `Last used: ${new Date(cmd.lastUsed).toLocaleString()}, Used ${cmd.count || 1} time(s)`
          : `Used ${cmd.count || 1} time(s)`,
        command: cmd.command,
        fullCommand: cmd,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a command to run in a new terminal",
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (selected) {
        // Launch the command (this also records usage)
        await this.commandManager.launchSavedCommand(selected.command);

        // Notify callback to create terminal with command
        this.onCommandSelected(selected.command);

        Logger.info(`Launching saved command: ${selected.command}`);
      }
    } catch (error) {
      Logger.error("Failed to launch command picker:", error);
      vscode.window.showErrorMessage("Failed to show saved commands");
    }
  }

  /**
   * Handle save command request from webview
   */
  public async handleSaveCommand(
    tabId: number,
    launchCommand: string,
    tabLabel: string,
    webview: vscode.Webview,
  ): Promise<void> {
    try {
      await this.commandManager.saveCommand(launchCommand, tabLabel);

      // Notify webview that command was saved
      webview.postMessage({
        command: "commandSavedResponse",
        launchCommand: launchCommand,
        isSaved: true,
      });

      Logger.info(`Command saved: ${launchCommand}`);
    } catch (error) {
      Logger.error("Failed to save command:", error);
      vscode.window.showErrorMessage("Failed to save command");
    }
  }

  /**
   * Check if a command is already saved
   */
  public async handleCheckCommandSaved(
    launchCommand: string,
    webview: vscode.Webview,
  ): Promise<void> {
    try {
      const commands = this.commandManager.getSavedCommands();
      const isSaved = commands.some((cmd) => cmd.command === launchCommand);

      // Send saved commands list to webview
      webview.postMessage({
        command: "savedCommandsList",
        commands: commands.map((cmd) => cmd.command),
      });

      // Send specific command saved status
      webview.postMessage({
        command: "commandSavedResponse",
        launchCommand: launchCommand,
        isSaved: isSaved,
      });
    } catch (error) {
      Logger.error("Failed to check command saved status:", error);
    }
  }
}

interface CommandQuickPickItem extends vscode.QuickPickItem {
  command: string;
  fullCommand: any;
}
