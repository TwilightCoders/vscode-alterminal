import * as vscode from "vscode";
import { Logger } from "../utils/logger";

/**
 * ConfigurationWatcher
 *
 * Responsibility: Monitor configuration changes and notify subscribers
 *
 * SOLID Principles:
 * - Single Responsibility: Only watches and reports config changes
 * - Open/Closed: Can add new config handlers without modifying core
 * - Interface Segregation: Callbacks are focused on specific config changes
 */
export class ConfigurationWatcher {
  private disposables: vscode.Disposable[] = [];
  private onConfigChangedCallback?: (config: AlterminalConfig) => void;
  private onDeveloperModeCallback?: (enabled: boolean) => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
  ) {}

  /**
   * Set callback for when configuration changes
   */
  public onConfigChanged(callback: (config: AlterminalConfig) => void): void {
    this.onConfigChangedCallback = callback;
  }

  /**
   * Set callback for when developer mode changes
   */
  public onDeveloperModeChanged(callback: (enabled: boolean) => void): void {
    this.onDeveloperModeCallback = callback;
  }

  /**
   * Start watching for configuration changes
   */
  public startWatching(): void {
    // Watch for configuration changes
    const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("alterminal")) {
        const config = this.getConfiguration();

        if (this.onConfigChangedCallback) {
          this.onConfigChangedCallback(config);
        }

        Logger.debug("⚙️ Configuration changed", config);
      }
    });

    this.disposables.push(configWatcher);

    // Check developer mode on startup
    this.checkDeveloperMode();
  }

  /**
   * Get current configuration
   */
  public getConfiguration(): AlterminalConfig {
    const config = vscode.workspace.getConfiguration("alterminal");

    return {
      alwaysShowTabs: config.get<boolean>("alwaysShowTabs", false),
      clearSelectionOnCopy: config.get<boolean>("clearSelectionOnCopy", true),
      scrollback: config.get<number>("terminal.scrollback", 1000),
      tabLayout: config.get<string>("tabLayout", "auto"),
      tabTitleTemplate: config.get<string>("tabTitle.template", "{base}{p? • {p}}"),
      tabTitleMaxLength: config.get<number>("tabTitle.maxLength", 50),
      tabTitleTruncateMode: config.get<string>("tabTitle.truncateMode", "end"),
    };
  }

  /**
   * Check if developer mode is enabled
   */
  public checkDeveloperMode(): boolean {
    const isDevelopment =
      this.context.extensionMode === vscode.ExtensionMode.Development;

    if (this.onDeveloperModeCallback) {
      this.onDeveloperModeCallback(isDevelopment);
    }

    return isDevelopment;
  }

  /**
   * Dispose of all watchers
   */
  public dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }
}

export interface AlterminalConfig {
  alwaysShowTabs: boolean;
  clearSelectionOnCopy: boolean;
  scrollback: number;
  tabLayout: string;
  tabTitleTemplate: string;
  tabTitleMaxLength: number;
  tabTitleTruncateMode: string;
}
