import * as vscode from "vscode";
import { Logger } from "../utils/logger";
import { getInheritedSetting } from "../utils/settings";

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
   * Start watching for configuration changes
   */
  public startWatching(): void {
    // Watch for configuration changes — both our own namespace and
    // VS Code's terminal.integrated (which we inherit from).
    const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("alterminal") ||
        e.affectsConfiguration("terminal.integrated")
      ) {
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
   * Get current configuration.
   *
   * Settings that map onto VS Code's built-in terminal.integrated.* use
   * getInheritedSetting so users' existing terminal config flows through
   * by default. alterminal.* overrides when explicitly set.
   */
  public getConfiguration(): AlterminalConfig {
    const config = vscode.workspace.getConfiguration("alterminal");

    return {
      // Alterminal-specific (no VS Code counterpart)
      alwaysShowTabs: config.get<boolean>("alwaysShowTabs", false),
      clearSelectionOnCopy: config.get<boolean>("clearSelectionOnCopy", true),
      tabLayout: config.get<string>("tabLayout", "auto"),
      tabTitleTemplate: config.get<string>("tabTitle.template", "{base}{p? • {p}}"),
      tabTitleMaxLength: config.get<number>("tabTitle.maxLength", 50),
      tabTitleTruncateMode: config.get<string>("tabTitle.truncateMode", "end"),

      // Inherited from terminal.integrated.* unless explicitly overridden
      scrollback: getInheritedSetting("terminal.scrollback", "scrollback", 1000),
      fontFamily: getInheritedSetting("fontFamily", "fontFamily", ""),
      fontSize: getInheritedSetting("fontSize", "fontSize", 13),
      fontWeight: getInheritedSetting("fontWeight", "fontWeight", "normal"),
      fontWeightBold: getInheritedSetting("fontWeightBold", "fontWeightBold", "bold"),
      lineHeight: getInheritedSetting("lineHeight", "lineHeight", 1.0),
      letterSpacing: getInheritedSetting("letterSpacing", "letterSpacing", 0),
      cursorStyle: getInheritedSetting("cursorStyle", "cursorStyle", "block"),
      cursorBlinking: getInheritedSetting("cursorBlinking", "cursorBlinking", false),
      copyOnSelection: getInheritedSetting("copyOnSelection", "copyOnSelection", false),
      smoothScrolling: getInheritedSetting("smoothScrolling", "smoothScrolling", false),
      minimumContrastRatio: getInheritedSetting("minimumContrastRatio", "minimumContrastRatio", 4.5),
      wordSeparators: getInheritedSetting("wordSeparators", "wordSeparators", " ()[]{}',\"`─‘’"),
    };
  }

  /**
   * Check if developer mode is enabled
   */
  public checkDeveloperMode(): boolean {
    const isDevelopment =
      this.context.extensionMode === vscode.ExtensionMode.Development;

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
  // Alterminal-specific
  alwaysShowTabs: boolean;
  clearSelectionOnCopy: boolean;
  tabLayout: string;
  tabTitleTemplate: string;
  tabTitleMaxLength: number;
  tabTitleTruncateMode: string;

  // Inherited from VS Code's terminal.integrated unless overridden
  scrollback: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  fontWeightBold: string;
  lineHeight: number;
  letterSpacing: number;
  cursorStyle: string;
  cursorBlinking: boolean;
  copyOnSelection: boolean;
  smoothScrolling: boolean;
  minimumContrastRatio: number;
  wordSeparators: string;
}
