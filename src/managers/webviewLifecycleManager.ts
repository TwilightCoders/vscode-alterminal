import * as vscode from "vscode";
import { PtyManager } from "../terminal/ptyManager";
import { StateManager } from "./stateManager";
import { ConfigurationWatcher } from "./configurationWatcher";
import { MessageDispatcher } from "./messageDispatcher";
import { TemplateUtils } from "../utils/templateUtils";
import { Logger } from "../utils/logger";
import { CommandManager } from "../utils/commandManager";

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
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    Logger.debug("🚀 resolveWebviewView() called - VS Code is creating/recreating the webview");
    
    // Reset state manager for new webview instance
    // This is critical for proper restoration when panel is closed and reopened
    this.stateManager.resetForNewWebview();
    this._webviewInitialized = false;

    // Configure webview options
    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: [this.extensionUri],
    };

    // Set up message router BEFORE loading HTML so we don't miss early messages (e.g., webviewReady)
    this.messageDispatcher.setupMessageRouter(webviewView);

    // Get configuration
    const config = this.configurationWatcher.getConfiguration();

    // Set up components with the webview
    this.ptyManager.setWebviewView(webviewView);

    // Always include a unique timestamp to force webview refresh (from PostgreSQL extension pattern)
    const timeNow = new Date().getTime();
    try {
      webviewView.webview.html = TemplateUtils.getHtmlTemplate(
        this.extensionUri,
        webviewView.webview,
        timeNow,
      );
    } catch (error) {
      Logger.error("Failed to generate webview HTML template:", error);
      webviewView.webview.html = `
        <html><body>
        <h1>Error Loading Alterminal</h1>
        <p>Failed to generate webview template: ${(error as Error).message}</p>
        <p>Check the extension logs for more details.</p>
        </body></html>
      `;
    }

    // State restoration will happen when webview emits 'webviewReady' event

    // Setup visibility change handler
    this.setupVisibilityHandler(webviewView);

    // Setup disposal handler
    this.setupDisposalHandler(webviewView);
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

    // Send saved commands list so webview can hide Save Command where appropriate
    try {
      const saved = this.commandManager
        .getSavedCommands()
        .map((c) => c.command);
      webview.postMessage({
        command: "savedCommandsList",
        commands: saved,
      });
    } catch (e) {
      Logger.warn("Failed sending savedCommandsList", e);
    }

    // Send configuration to webview
    const config = this.configurationWatcher.getConfiguration();
    webview.postMessage({
      command: "updateConfig",
      config: {
        alwaysShowTabs: config.alwaysShowTabs,
        clearSelectionOnCopy: config.clearSelectionOnCopy,
        scrollback: config.scrollback,
      },
    });
  }

  /**
   * Handle configuration changes
   */
  public handleConfigChange(webview: vscode.Webview, config: { alwaysShowTabs: boolean; clearSelectionOnCopy: boolean; scrollback: number }): void {
    webview.postMessage({
      command: "updateConfig",
      config,
    });

  }

  /**
   * Set up visibility change handler
   * Note: The serializer handles restoration on visibility changes.
   * This handler only manages the _webviewInitialized flag.
   */
  private setupVisibilityHandler(webviewView: vscode.WebviewView): void {
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        Logger.info("🔍 [FOCUS DEBUG] Extension host: Webview became visible");
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
  private setupDisposalHandler(webviewView: vscode.WebviewView): void {
    webviewView.onDidDispose(() => {
      this._webviewInitialized = false;
    });
  }
}
