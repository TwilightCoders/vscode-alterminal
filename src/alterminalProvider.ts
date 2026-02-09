import * as vscode from "vscode";
import { PtyManager } from "./terminal/ptyManager";
import { Logger } from "./utils/logger";
import { CommandManager } from "./utils/commandManager";
import { TabTitleProvider } from "./providers/tabTitleProvider";
import { TemplateUtils } from "./utils/templateUtils";
import { StateManager } from "./managers/stateManager";
import { ConfigurationWatcher } from "./managers/configurationWatcher";
import { CommandLauncher } from "./managers/commandLauncher";
import { FileOperationHandler } from "./managers/fileOperationHandler";
import { TabContextMenuHandler } from "./managers/tabContextMenuHandler";
import { WebViewLifecycleManager } from "./managers/webviewLifecycleManager";
import { MessageDispatcher } from "./managers/messageDispatcher";

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
  private commandLauncher: CommandLauncher;
  private fileOperationHandler: FileOperationHandler;
  private tabContextMenuHandler: TabContextMenuHandler;
  private webviewLifecycleManager: WebViewLifecycleManager;
  private messageDispatcher: MessageDispatcher;

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
    this.commandLauncher = new CommandLauncher(
      this._commandManager,
      (command: string) => this.createNewTabWithCommand(command),
    );
    this.fileOperationHandler = new FileOperationHandler(this._ptyManager);
    this.tabContextMenuHandler = new TabContextMenuHandler(
      this._commandManager,
      () => this._view?.webview,
    );

    // MessageDispatcher needs to be created after other managers
    this.messageDispatcher = new MessageDispatcher(
      this._ptyManager,
      this.commandLauncher,
      this.fileOperationHandler,
      this.tabContextMenuHandler,
      this.stateManager,
      () => this._view?.webview,
      () => this.openTerminal(),
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

    // Notify serializer that initial restore is complete
    if (this._serializer) {
      this._serializer.markInitialRestoreComplete();
    }
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
        oscTitle: msg.oscTitle,
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
    this._view?.webview.postMessage({ command: "collectPerformance" });
  }

  /**
   * Refresh/restart all terminals
   */
  public async refresh(): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Restarting Alterminal...",
        cancellable: false,
      },
      async (progress) => {
        try {
          progress.report({ increment: 0, message: "Disposing terminals..." });
          this._ptyManager.dispose();

          progress.report({ increment: 50, message: "Disposing webview..." });
          progress.report({ increment: 75, message: "Reinitializing..." });

          if (this._view) {
            const timeNow = new Date().getTime();
            this._view.webview.html = TemplateUtils.getHtmlTemplate(
              this._extensionUri,
              this._view.webview,
              timeNow,
            );
          }

          progress.report({ increment: 100, message: "Complete!" });
          vscode.window.showInformationMessage("Alterminal restarted successfully!");
        } catch (error) {
          Logger.error("Error during refresh:", error);
          vscode.window.showErrorMessage(`Failed to restart Alterminal: ${error}`);
        }
      },
    );
  }

  /**
   * Trigger terminal resize
   */
  public triggerResize(): void {
    this._view?.webview.postMessage({ command: "triggerResize" });
  }

  /**
   * Create a new terminal tab
   */
  public createNewTab(type?: string): void {
    this._view?.webview.postMessage({
      command: "createNewTab",
      terminalType: type,
    });
  }

  /**
   * Create a new terminal tab with a command
   */
  public createNewTabWithCommand(cmd: string): void {
    const expanded = this._commandManager.expandCommand(cmd);
    this._view?.webview.postMessage({
      command: "createNewTab",
      terminalType: "command",
      launchCommand: expanded,
    });
  }

  /**
   * Focus the terminal view
   */
  public async openTerminal(): Promise<void> {
    await vscode.commands.executeCommand("alterminalView.focus");
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
    const webview = this._view?.webview;
    if (webview) {
      webview.postMessage({ command: "setDebugFilter", filter });
      Logger.info(`Debug filter ${filter ? "set" : "cleared"}:`, filter);
    }
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
      qp.placeholder = "Type a command or use variables: {workspace}, {user}, {env.VAR}";
      qp.matchOnDescription = true;
      qp.matchOnDetail = true;

      // Separator + help item shown at the bottom of every list
      const helpSeparator = { label: "Template Variables", kind: vscode.QuickPickItemKind.Separator } as any;
      const helpItem = {
        label: "$(symbol-variable) {workspace}  {workspacePath}  {user}  {platform}  {env.VAR}",
        description: "",
        detail: "Use these in commands to adapt per-workspace. Supports {key:default} and {key?then:else}.",
        launchCommand: "",
        saved: false,
        alwaysShow: true,
      };

      const buildItems = (value: string) => {
        const items: any[] = saved.map((c) => {
          const expanded = this._commandManager.expandCommand(c.command);
          const preview = expanded !== c.command ? `\u2192 ${expanded}` : undefined;
          return {
            label: c.label,
            description: c.command,
            detail: preview
              ? `${preview}  \u2022  Used ${c.count} \u2022 Last ${new Date(c.lastUsed).toLocaleDateString()}`
              : `Used ${c.count} \u2022 Last ${new Date(c.lastUsed).toLocaleDateString()}`,
            launchCommand: c.command,
            saved: true,
          };
        });
        const trimmed = value.trim();
        if (trimmed && !saved.some((c) => c.command === trimmed)) {
          const expanded = this._commandManager.expandCommand(trimmed);
          const preview = expanded !== trimmed ? `\u2192 ${expanded}` : undefined;
          items.unshift({
            label: `Run: ${trimmed}`,
            description: "(new command)",
            detail: preview || "Press Enter to launch (not yet saved)",
            launchCommand: trimmed,
            saved: false,
          });
        }
        items.push(helpSeparator, helpItem);
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

          // Ignore selection of the help item
          if (sel === helpItem && !value) {
            return;
          }

          // Use what they typed if they typed anything, otherwise use selection
          const commandToRun = value || (sel && sel !== helpItem ? sel.launchCommand : "");

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
