/**
 * Command Manager
 *
 * Purpose:
 * - Manage saved/favorite terminal commands for quick re-launching
 * - Provide dynamic menu integration with VS Code command palette
 * - Handle command persistence and usage tracking
 *
 * Responsibilities:
 * - Store and retrieve saved commands from workspace/user settings
 * - Track command usage frequency and recency
 * - Generate dynamic menu items for quick command access
 * - Provide UI for saving commands from active terminals
 *
 * Key Features:
 * - Smart labeling of commands (auto-generate or user-defined)
 * - Usage-based sorting (most used + most recent)
 * - Integration with tab save buttons
 * - Clean command deduplication and management
 */

import * as vscode from "vscode";
import { LIMITS } from "../constants";

interface SavedCommand {
  command: string;
  label: string;
  count: number;
  lastUsed: string;
}

interface VSCodeAPI {
  getConfiguration: (section: string) => vscode.WorkspaceConfiguration;
  window: typeof vscode.window;
  commands: typeof vscode.commands;
}

export class CommandManager {
  private savedCommands: SavedCommand[] = [];

  constructor(
    private vscode: VSCodeAPI,
    private createTab: (command: string) => void,
  ) {
    // Load saved commands asynchronously to avoid blocking extension startup
    this.loadSavedCommands().catch((error) => {
      console.error("[CommandManager] Failed to initialize:", error);
    });
  }

  /**
   * Load saved commands from VS Code settings
   */
  async loadSavedCommands() {
    try {
      this.savedCommands = this.vscode
        .getConfiguration("alterminal")
        .get<SavedCommand[]>("savedCommands", []);

      console.debug(
        "[CommandManager] Loaded saved commands:",
        this.savedCommands,
      );
      this.updateDynamicMenus();
    } catch (error) {
      console.error("[CommandManager] Failed to load saved commands:", error);
      this.savedCommands = [];
    }
  }

  /**
   * Save commands back to VS Code settings
   */
  async saveSavedCommands() {
    try {
      await this.vscode.getConfiguration("alterminal").update(
        "savedCommands",
        this.savedCommands,
        vscode.ConfigurationTarget.Global,
      );

      console.debug(
        "[CommandManager] Saved commands updated:",
        this.savedCommands,
      );
      this.updateDynamicMenus();
    } catch (error) {
      console.error("[CommandManager] Failed to save commands:", error);
    }
  }

  /**
   * Add a command to saved commands (or increment usage)
   */
  async saveCommand(command: string, userLabel?: string | null) {
    const existing = this.savedCommands.find(
      (c) => c.command === command,
    );
    if (existing) {
      if (userLabel) existing.label = userLabel; // label update only
      // Do NOT increment usage here; usage increments only when launched
    } else {
      this.savedCommands.push({
        command,
        label: userLabel || this.generateLabel(command),
        count: 0,
        lastUsed: new Date().toISOString(),
      });
    }
    // Limit: keep newest additions if overflow
    if (this.savedCommands.length > LIMITS.MAX_SAVED_COMMANDS) {
      // Remove lowest count / oldest lastUsed
      this.savedCommands.sort(
        (a, b) =>
          a.count - b.count ||
          new Date(a.lastUsed).getTime() - new Date(b.lastUsed).getTime(),
      );
      this.savedCommands = this.savedCommands.slice(-LIMITS.MAX_SAVED_COMMANDS);
    }
    await this.saveSavedCommands();
    return true;
  }

  private _recordUsage(command: string) {
    const existing = this.savedCommands.find(
      (c) => c.command === command,
    );
    if (existing) {
      existing.count += 1;
      existing.lastUsed = new Date().toISOString();
    }
  }

  /**
   * Generate a smart label for a command
   */
  generateLabel(command: string): string {
    // Smart labeling based on common patterns
    const cmd = command.trim();

    // Handle common patterns
    if (cmd.startsWith("npm ")) {
      const script = cmd.replace("npm ", "").trim();
      return `NPM: ${script}`;
    }
    if (cmd.startsWith("python ")) {
      const script = cmd.replace("python ", "").replace("-m ", "").trim();
      return `Python: ${script}`;
    }
    if (cmd.startsWith("node ")) {
      const script = cmd.replace("node ", "").trim();
      return `Node: ${script}`;
    }
    if (cmd.includes("server") || cmd.includes("serve")) {
      return "Server";
    }
    if (cmd.includes("watch") || cmd.includes("dev")) {
      return "Development";
    }
    if (cmd.includes("test")) {
      return "Testing";
    }
    if (cmd.includes("build")) {
      return "Build";
    }

    // Default: use first word + "..."
    const firstWord = cmd.split(" ")[0];
    return cmd.length > 20 ? `${firstWord}...` : cmd;
  }

  /**
   * Get saved commands sorted by usage and recency
   */
  getSavedCommands(): SavedCommand[] {
    return this.savedCommands.slice().sort((a, b) => {
      // Weighted score: count primary, recency secondary
      const aScore =
        a.count * 1000000000000 + new Date(a.lastUsed).getTime();
      const bScore =
        b.count * 1000000000000 + new Date(b.lastUsed).getTime();
      return bScore - aScore;
    });
  }

  /**
   * Launch a saved command
   */
  async launchSavedCommand(command: string) {
    this._recordUsage(command);
    await this.saveSavedCommands();
    if (this.createTab) {
      this.createTab(command);
    }
  }

  /**
   * Remove a saved command
   */
  async removeSavedCommand(command: string) {
    this.savedCommands = this.savedCommands.filter(
      (cmd) => cmd.command !== command,
    );
    await this.saveSavedCommands();
  }

  /**
   * Show dialog to save a new command
   */
  async showSaveCommandDialog() {
    const command = await this.vscode.window.showInputBox({
      prompt: "Enter the command to save",
      placeHolder: "e.g., npm run dev, python server.py, etc.",
      validateInput: (value) => {
        return value.trim() ? null : "Command cannot be empty";
      },
    });

    if (command) {
      const label = await this.vscode.window.showInputBox({
        prompt: "Enter a label for this command (optional)",
        placeHolder: "Leave empty for auto-generated label",
      });

      await this.saveCommand(command.trim(), label?.trim() || null);
      this.vscode.window.showInformationMessage(
        `Command "${command}" saved successfully!`,
      );
    }
  }

  /**
   * Show quick pick for saved commands
   */
  async showSavedCommandsPicker() {
    const commands = this.getSavedCommands();

    if (commands.length === 0) {
      this.vscode.window.showInformationMessage(
        "No saved commands yet. Save commands using the 💾 button on command tabs.",
      );
      return;
    }

    const quickPickItems = commands.map((cmd) => ({
      label: cmd.label,
      description: cmd.command,
      detail: `Used ${cmd.count} times • Last ${new Date(cmd.lastUsed).toLocaleDateString()}`,
      command: cmd.command,
    }));

    const quickPick = this.vscode.window.createQuickPick();
    quickPick.items = quickPickItems;
    quickPick.placeholder = "Select a saved command or type a custom command to launch";
    quickPick.matchOnDescription = true;

    return new Promise<void>((resolve) => {
      quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems[0];
        const value = quickPick.value.trim();

        quickPick.hide();

        // If they typed something, always use what they typed
        if (value) {
          if (this.createTab) {
            this.createTab(value);
          }
        } else if (selected && "command" in selected) {
          // They didn't type, just selected an item (arrow keys + Enter or click)
          this.launchSavedCommand((selected as any).command);
        }

        resolve();
      });

      quickPick.onDidHide(() => {
        quickPick.dispose();
        resolve();
      });

      quickPick.show();
    });
  }

  /**
   * Update dynamic menus (notify VS Code of menu changes)
   */
  updateDynamicMenus() {
    // Set context for showing/hiding the "Launch Saved Command" picker
    this.vscode.commands.executeCommand(
      "setContext",
      "alterminal.hasSavedCommands",
      this.savedCommands.length > 0,
    );
  }
}
