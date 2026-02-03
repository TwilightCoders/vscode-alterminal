import * as vscode from "vscode";
import { PtyManager } from "./terminal/ptyManager";
import { Logger } from "./utils/logger";
import { CommandManager } from "./utils/commandManager";
import { TabTitleProvider } from "./providers/tabTitleProvider";
import { StateManager } from "./managers/stateManager";
import { ConfigurationWatcher } from "./managers/configurationWatcher";
import { NotificationManager } from "./managers/notificationManager";
import { CommandLauncher } from "./managers/commandLauncher";
import { FileOperationHandler } from "./managers/fileOperationHandler";
import { TabContextMenuHandler } from "./managers/tabContextMenuHandler";
import { WebViewLifecycleManager } from "./managers/webviewLifecycleManager";
import { MessageDispatcher } from "./managers/messageDispatcher";
import { TerminalController } from "./managers/terminalController";

/**
 * AlterminalProvider
 *
 * Primary responsibility: Orchestrate managers and provide public API
 *
 * SOLID Principles:
 * - Single Responsibility: Facade that coordinates managers
 * - Open/Closed: Extensible through manager composition
 * - Dependency Inversion: Depends on manager abstractions
 */
export class AlterminalProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "alterminalView";
  private static _instance?: AlterminalProvider;
  private _view?: vscode.WebviewView;
  private _ptyManager: PtyManager;
  private _context: vscode.ExtensionContext;
  private _commandManager: CommandManager;
  private _serializer?: any;
  private _tabTitleProvider = new TabTitleProvider();

  // Managers
  private stateManager: StateManager;
  private configurationWatcher: ConfigurationWatcher;
  private notificationManager: NotificationManager;
  private commandLauncher: CommandLauncher;
  private fileOperationHandler: FileOperationHandler;
  private tabContextMenuHandler: TabContextMenuHandler;
  private webviewLifecycleManager: WebViewLifecycleManager;
  private messageDispatcher: MessageDispatcher;
  private terminalController: TerminalController;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    context: vscode.ExtensionContext,
    ptyManager: PtyManager,
    serializer?: any,
  ) {
    AlterminalProvider._instance = this;
    this._context = context;
    this._ptyManager = ptyManager;
    this._serializer = serializer;

    // Initialize CommandManager
    this._commandManager = new CommandManager(
      {
        getConfiguration: (section: string) =>
          vscode.workspace.getConfiguration(section),
        window: vscode.window,
        commands: vscode.commands,
      },
      (command: string) => this.createNewTabWithCommand(command),
    );

    // Initialize managers
    this.stateManager = new StateManager(context);
    this.configurationWatcher = new ConfigurationWatcher(context);
    this.notificationManager = new NotificationManager();
    this.commandLauncher = new CommandLauncher(
      this._commandManager,
      (command: string) => this.createNewTabWithCommand(command),
    );
    this.fileOperationHandler = new FileOperationHandler(this._ptyManager);
    this.tabContextMenuHandler = new TabContextMenuHandler(
      this._commandManager,
      () => this._view?.webview,
    );
    this.terminalController = new TerminalController(
      () => this._view?.webview,
      this._ptyManager,
      this._extensionUri,
    );

    // MessageDispatcher needs to be created after other managers
    this.messageDispatcher = new MessageDispatcher(
      this._ptyManager,
      this.commandLauncher,
      this.fileOperationHandler,
      this.tabContextMenuHandler,
      this.stateManager,
      this.notificationManager,
      (msg: any) => this._handleFormatTabTitle(msg),
      () => this._handleWebviewReady(),
      this._serializer ? (msg: any) => this._serializer.handleMessage(msg) : undefined,
    );

    // WebViewLifecycleManager needs MessageDispatcher
    this.webviewLifecycleManager = new WebViewLifecycleManager(
      this._extensionUri,
      this._ptyManager,
      this.stateManager,
      this.configurationWatcher,
      this.messageDispatcher,
      this._commandManager,
      () => this._checkDeveloperMode(),
    );

    // Listen for configuration changes
    this.configurationWatcher.onConfigChanged((config) => {
      if (this._view) {
        this.webviewLifecycleManager.handleConfigChange(
          this._view.webview,
          config.alwaysShowTabs,
          config.scrollback,
        );
      }
    });

    // Start watching configuration
    this.configurationWatcher.startWatching();
  }

  /**
   * Resolve and initialize webview
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    // Serializer will handle webview lifecycle
    if (this._serializer && this._serializer.setWebviewView) {
      this._serializer.setWebviewView(webviewView);
    }

    // Delegate to lifecycle manager
    this.webviewLifecycleManager.resolveWebviewView(
      webviewView,
      _context,
      _token,
    );
  }

  /**
   * Handle webview ready event
   */
  private async _handleWebviewReady(): Promise<void> {
    if (!this._view) return;

    // Delegate to lifecycle manager (it will handle marking restore as triggered)
    await this.webviewLifecycleManager.handleWebviewReady(this._view.webview);
  }

  /**
   * Handle tab title formatting
   */
  private _handleFormatTabTitle(msg: any): void {
    try {
      const template = this._tabTitleProvider.getTemplate();

      const title = this._tabTitleProvider.render(template, {
        tabId: msg.tabId,
        tabName: msg.tabName || "Terminal",
        baseTabName: msg.baseTabName || "Terminal",
        processName: msg.processName,
        processId: msg.processId,
        fullCommand: msg.fullCommand,
        workingDirectory: msg.workingDirectory,
        lastExitCode: msg.lastExitCode,
        timestamp: new Date(),
      });

      this._view?.webview.postMessage({
        command: "formatTabTitleResponse",
        tabId: msg.tabId,
        title,
      });
    } catch (e) {
      Logger.warn("Failed to format tab title", e);
    }
  }

  /**
   * Check for developer mode
   */
  private async _checkDeveloperMode(): Promise<void> {
    const isDeveloper =
      this._context.extensionMode === vscode.ExtensionMode.Development;

    // Send developer status to webview
    if (this._view) {
      this._view.webview.postMessage({
        command: "setDeveloperMode",
        enabled: isDeveloper,
      });
    }
  }

  // ==================== Public API Methods ====================

  /**
   * Request performance report from terminals
   */
  public async requestPerformanceReport(): Promise<void> {
    await this.terminalController.requestPerformanceReport();
  }

  /**
   * Refresh/restart all terminals
   */
  public async refresh(): Promise<void> {
    await this.terminalController.refresh(() => this._view);
  }

  /**
   * Trigger terminal resize
   */
  public triggerResize(): void {
    this.terminalController.triggerResize();
  }

  /**
   * Create a new terminal tab
   */
  public createNewTab(type?: string): void {
    this.terminalController.createNewTab(type);
  }

  /**
   * Create a new terminal tab with a command
   */
  public createNewTabWithCommand(cmd: string): void {
    this.terminalController.createNewTabWithCommand(cmd);
  }

  /**
   * Focus the terminal view
   */
  public async openTerminal(): Promise<void> {
    await this.terminalController.openTerminal();
  }

  /**
   * Send file path to terminal
   */
  public sendFilePath(filePath: string, tabId: number): void {
    this.fileOperationHandler.sendFilePath(tabId, filePath);
  }

  /**
   * Set debug filter for developer mode
   */
  public setDebugFilter(filter: string[] | null): void {
    this.terminalController.setDebugFilter(filter);
  }

  /**
   * Show saved commands picker
   */
  public async showSavedCommands(): Promise<void> {
    await this.commandLauncher.showSavedCommands();
  }

  /**
   * Save current command dialog
   */
  public async saveCurrentCommand(): Promise<void> {
    if (this._view) {
      await this.commandLauncher.saveCurrentCommand(this._view.webview);
    }
  }

  /**
   * Unified launcher: pick a saved command or type a new one inline.
   * - Filters saved commands as user types
   * - Enter with no selection launches typed command (unsaved)
   * - Selecting saved command increments usage & launches
   */
  public async launchCommandPicker(): Promise<void> {
    try {
      const saved = this._commandManager.getSavedCommands();
      const qp = vscode.window.createQuickPick<{
        label: string;
        description: string;
        detail?: string;
        launchCommand: string;
        saved: boolean;
      }>();
      qp.title = "Launch Command";
      qp.placeholder = "Type a command to run or select a saved one";
      qp.matchOnDescription = true;
      const buildItems = (value: string) => {
        const items = saved.map((c) => ({
          label: c.label,
          description: c.command,
          detail: `Used ${c.count} • Last ${new Date(c.lastUsed).toLocaleDateString()}`,
          launchCommand: c.command,
          saved: true,
        }));
        const trimmed = value.trim();
        if (trimmed && !saved.some((c) => c.command === trimmed)) {
          items.unshift({
            label: `Run: ${trimmed}`,
            description: "(new command)",
            detail: "Press Enter to launch (not yet saved)",
            launchCommand: trimmed,
            saved: false,
          });
        }
        return items;
      };
      qp.items = buildItems("");
      const disposables: vscode.Disposable[] = [];
      disposables.push(
        qp.onDidChangeValue((val) => {
          qp.items = buildItems(val);
        }),
        qp.onDidAccept(async () => {
          const value = qp.value.trim();
          const sel = qp.selectedItems[0];

          // Use what they typed if they typed anything, otherwise use selection
          const commandToRun = value || (sel ? sel.launchCommand : "");

          if (!commandToRun) {
            return;
          }
          qp.busy = true;
          try {
            if (saved.some((c) => c.command === commandToRun)) {
              await this._commandManager.launchSavedCommand(commandToRun);
            } else {
              this.createNewTabWithCommand(commandToRun);
            }
          } finally {
            qp.dispose();
          }
        }),
        qp.onDidHide(() => qp.dispose()),
      );
      qp.show();
    } catch (error) {
      Logger.error("Failed to open launch command picker:", error);
      vscode.window.showErrorMessage("Unable to open command launcher");
    }
  }

  /**
   * Handle context menu commands from VS Code
   */
  public async handleContextMenuCommand(
    command: string,
    args: any,
  ): Promise<void> {
    await this.tabContextMenuHandler.handleContextMenuCommand(command, args);
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): AlterminalProvider | undefined {
    return AlterminalProvider._instance;
  }

  /**
   * Dispose of all resources
   */
  public dispose(): void {
    this._ptyManager.dispose();
    this.configurationWatcher.dispose();
  }
}
