import * as vscode from "vscode";
import type { ExtToWebviewMessage } from "../shared/messages";
import { PtyManager } from "../terminal/ptyManager";
import { StateManager } from "./stateManager";
import { ConfigurationWatcher } from "./configurationWatcher";
import { MessageDispatcher } from "./messageDispatcher";
import { TemplateUtils } from "../utils/templateUtils";
import { Logger } from "../utils/logger";
import { CommandManager } from "../utils/commandManager";
import { ShellDetector } from "../utils/shellDetector";
import type { LaunchMenuData } from "../shared/messages";

/**
 * WebViewLifecycleManager
 *
 * Responsibility: Handle webview lifecycle events
 *
 * SOLID Principles:
 * - Single Responsibility: Only manages webview lifecycle
 * - Open/Closed: Can extend lifecycle handling without changing core
 * - Dependency Inversion: Depends on manager abstractions
 */
export class WebViewLifecycleManager {
  private _webviewInitialized = false;
  // Per-webview lifecycle listeners; disposed before re-registering since
  // resolveWebviewView (→ these setups) runs on every webview (re)creation.
  private _visibilityDisposable?: vscode.Disposable;
  private _disposalDisposable?: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly ptyManager: PtyManager,
    private readonly stateManager: StateManager,
    private readonly configurationWatcher: ConfigurationWatcher,
    private readonly messageDispatcher: MessageDispatcher,
    private readonly commandManager: CommandManager,
    private readonly onDeveloperModeCheck: () => void,
  ) {}

  /**
   * Resolve and initialize webview
   */
  public resolveWebviewView(
    alterminal: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    Logger.debug("resolveWebviewView() called - VS Code is creating/recreating the webview");

    // Reset state manager for new webview instance
    // This is critical for proper restoration when panel is closed and reopened
    this.stateManager.resetForNewWebview();
    this._webviewInitialized = false;

    // Configure webview options
    alterminal.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: [this.extensionUri],
    };

    // Set up message router BEFORE loading HTML so we don't miss early messages (e.g., webviewReady)
    this.messageDispatcher.setupMessageRouter(alterminal);

    // Get configuration
    const config = this.configurationWatcher.getConfiguration();

    // Set up components with the webview
    this.ptyManager.setAlterminal(alterminal);

    // Always include a unique timestamp to force webview refresh (from PostgreSQL extension pattern)
    const timeNow = new Date().getTime();
    try {
      alterminal.webview.html = TemplateUtils.getHtmlTemplate(
        this.extensionUri,
        alterminal.webview,
        timeNow,
      );
    } catch (error) {
      Logger.error("Failed to generate webview HTML template:", error);
      const safeMsg = (error as Error).message.replace(/[&<>"']/g, c =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
      alterminal.webview.html = `
        <html><body>
        <h1>Error Loading Alterminal</h1>
        <p>Failed to generate webview template: ${safeMsg}</p>
        <p>Check the extension logs for more details.</p>
        </body></html>
      `;
    }

    // State restoration will happen when webview emits 'webviewReady' event

    // Setup visibility change handler
    this.setupVisibilityHandler(alterminal);

    // Setup disposal handler
    this.setupDisposalHandler(alterminal);
  }

  /**
   * Handle webview ready event
   * 
   * This is called every time the webview sends 'webviewReady', which happens:
   * 1. When the webview is first created (resolveWebviewView)
   * 2. When the webview iframe is reloaded (panel closed/reopened with retainContextWhenHidden)
   * 
   * With retainContextWhenHidden:true, VS Code may recreate the iframe without
   * calling resolveWebviewView again, so we must reset state here.
   */
  public async handleWebviewReady(webview: vscode.Webview): Promise<void> {
    // Reset the restore flag - webviewReady means the iframe was (re)loaded
    // and needs fresh initialization, even if resolveWebviewView wasn't called
    this.stateManager.resetForNewWebview();
    
    // Restore state - no delay needed because the webview sent us this message,
    // which proves its message handler is ready to receive our response
    await this.stateManager.restoreWebviewState(webview);

    // Mark webview as properly initialized
    this._webviewInitialized = true;

    // Check for developer mode
    this.onDeveloperModeCheck();

    this.pushCommandData(webview);

    // Send configuration to webview
    webview.postMessage({
      command: "updateConfig",
      config: this._buildWebviewConfig(),
    } satisfies ExtToWebviewMessage);
  }

  /**
   * Handle configuration changes
   */
  public handleConfigChange(webview: vscode.Webview, _config: unknown): void {
    webview.postMessage({
      command: "updateConfig",
      config: this._buildWebviewConfig(),
    } satisfies ExtToWebviewMessage);
  }

  /**
   * Send the current shell and saved-command launch data to the webview.
   * This keeps the launch menu and save-button state in sync after saves,
   * launches, and initial ready/restore.
   */
  public pushCommandData(webview: vscode.Webview): void {
    try {
      const launchMenuData = this._buildLaunchMenuData();
      webview.postMessage({
        command: "savedCommandsList",
        commands: launchMenuData.savedCommands.map((cmd) => cmd.command),
      } satisfies ExtToWebviewMessage);
      webview.postMessage({
        command: "launchMenuData",
        data: launchMenuData,
      } satisfies ExtToWebviewMessage);
    } catch (e) {
      Logger.warn("Failed sending launch menu data", e);
    }
  }

  private _buildWebviewConfig() {
    const c = this.configurationWatcher.getConfiguration();
    return {
      alwaysShowTabs: c.alwaysShowTabs,
      clearSelectionOnCopy: c.clearSelectionOnCopy,
      scrollback: c.scrollback,
      bellAwareTimeoutMinutes: c.bellAwareTimeoutMinutes,
      terminalAppearance: {
        fontFamily: c.fontFamily,
        fontSize: c.fontSize,
        fontWeight: c.fontWeight,
        fontWeightBold: c.fontWeightBold,
        lineHeight: c.lineHeight,
        letterSpacing: c.letterSpacing,
        lineSpacing: c.lineSpacing,
        cursorStyle: c.cursorStyle,
        cursorBlinking: c.cursorBlinking,
        copyOnSelection: c.copyOnSelection,
        smoothScrolling: c.smoothScrolling,
        minimumContrastRatio: c.minimumContrastRatio,
        wordSeparators: c.wordSeparators,
      },
    };
  }

  private _buildLaunchMenuData(): LaunchMenuData {
    return {
      shells: ShellDetector.detectShells(),
      savedCommands: this.commandManager.getSavedCommands().map((cmd) => ({
        command: cmd.command,
        label: cmd.label,
        count: cmd.count,
        lastUsed: cmd.lastUsed,
        cwd: cmd.cwd,
      })),
    };
  }

  /**
   * Set up visibility change handler
   * Note: The serializer handles restoration on visibility changes.
   * This handler only manages the _webviewInitialized flag.
   */
  private setupVisibilityHandler(alterminal: vscode.WebviewView): void {
    // Dispose any prior webview's listener — this runs per resolveWebviewView.
    this._visibilityDisposable?.dispose();
    this._visibilityDisposable = alterminal.onDidChangeVisibility(() => {
      if (alterminal.visible) {
        Logger.info("🔍 [FOCUS DEBUG] Extension host: Webview became visible");
        this.messageDispatcher.clearBellIndicator();
      } else {
        Logger.info("🔍 [FOCUS DEBUG] Extension host: Webview became hidden");
        // Webview hidden - mark as not initialized so next show triggers restore
        this._webviewInitialized = false;
      }
    });
  }

  /**
   * Set up disposal handler
   */
  private setupDisposalHandler(alterminal: vscode.WebviewView): void {
    this._disposalDisposable?.dispose();
    this._disposalDisposable = alterminal.onDidDispose(() => {
      this._webviewInitialized = false;
    });
  }
}
