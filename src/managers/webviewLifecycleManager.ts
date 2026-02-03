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
    this.ptyManager.setScrollback(config.scrollback);

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
   */
  public async handleWebviewReady(webview: vscode.Webview): Promise<void> {
    // Restore state
    await this.stateManager.restoreWebviewState(webview);

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
        scrollback: config.scrollback,
      },
    });
  }

  /**
   * Handle configuration changes
   */
  public handleConfigChange(webview: vscode.Webview, alwaysShowTabs: boolean, scrollback: number): void {
    webview.postMessage({
      command: "updateConfig",
      config: {
        alwaysShowTabs,
        scrollback,
      },
    });

    this.ptyManager.setScrollback(scrollback);
  }

  /**
   * Set up visibility change handler
   */
  private setupVisibilityHandler(webviewView: vscode.WebviewView): void {
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        // Reset restore trigger so state can be restored when webview becomes visible again
        this.stateManager.resetRestoreTrigger();
        // Refresh active state
        webviewView.webview.postMessage({ command: "refreshActive" });
      }
    });
  }

  /**
   * Set up disposal handler
   */
  private setupDisposalHandler(webviewView: vscode.WebviewView): void {
    webviewView.onDidDispose(() => {
      // Note: State is already saved synchronously by webview, no need for async save here
    });
  }
}
