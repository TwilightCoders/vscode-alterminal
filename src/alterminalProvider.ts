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
import { FocusGuard } from "./managers/focusGuard";
import { ShellDetector } from "./utils/shellDetector";
import { WebviewViewSerializer } from "./serialization/webviewViewSerializer";

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
  private _serializer?: WebviewViewSerializer;
  private _tabTitleProvider = new TabTitleProvider();
  /** Last rendered title per tab — used to label bell notifications. */
  private _tabTitles = new Map<number, string>();

  // Managers
  private stateManager: StateManager;
  private configurationWatcher: ConfigurationWatcher;
  private commandLauncher: CommandLauncher;
  private fileOperationHandler: FileOperationHandler;
  private tabContextMenuHandler: TabContextMenuHandler;
  private webviewLifecycleManager: WebViewLifecycleManager;
  public messageDispatcher: MessageDispatcher;
  private focusGuard: FocusGuard;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    context: vscode.ExtensionContext,
    ptyManager: PtyManager,
    serializer?: WebviewViewSerializer,
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
      (command: string, cwd?: string) => this.createNewTabWithCommand(command, cwd),
    );

    // Initialize managers
    this.stateManager = new StateManager(context);
    this.configurationWatcher = new ConfigurationWatcher(context);
    this.commandLauncher = new CommandLauncher(
      this._commandManager,
    );
    this._ptyManager.setCommandExpander((cmd) => this._commandManager.expandCommand(cmd));
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
      () => this.focusGuard.recordInteraction(),
    );

    // Wire PTY-side bell detection to notification handler
    this._ptyManager.onBell((tabId) =>
      this.messageDispatcher.handleBellSound(
        tabId,
        this._tabTitles.get(tabId) || `Tab ${tabId}`,
      ),
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

    // Focus guard: reclaim focus when another extension steals it
    this.focusGuard = new FocusGuard();

    // Listen for configuration changes
    this.configurationWatcher.onConfigChanged((config) => {
      if (this._view) {
        this.webviewLifecycleManager.handleConfigChange(this._view.webview, null);
      }
      this._ptyManager.setSuppressFocusStealing(config.suppressFocusStealingSequences);
      // Reload saved commands so manual settings.json edits take effect
      this._commandManager.loadSavedCommands();
    });

    // Apply current config to PtyManager before watcher starts firing
    this._ptyManager.setSuppressFocusStealing(
      this.configurationWatcher.getConfiguration().suppressFocusStealingSequences,
    );

    // Start watching configuration
    this.configurationWatcher.startWatching();
  }

  /**
   * Resolve and initialize webview
   */
  public resolveWebviewView(
    alterminal: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = alterminal;

    // Serializer will handle webview lifecycle
    if (this._serializer && this._serializer.setAlterminal) {
      this._serializer.setAlterminal(alterminal);
    }

    // Start focus guard for this webview
    this.focusGuard.attach(alterminal);

    // Delegate to lifecycle manager
    this.webviewLifecycleManager.resolveWebviewView(
      alterminal,
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
      // Use per-tab template if provided, otherwise fall back to global setting
      const template = msg.template || this._tabTitleProvider.getTemplate();

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
        userVars: msg.userVars,
      });

      if (typeof msg.tabId === "number" && title) {
        this._tabTitles.set(msg.tabId, title);
      }

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
  public createNewTab(type?: string, shellPath?: string): void {
    this._view?.webview.postMessage({
      command: "createNewTab",
      terminalType: type,
      shellPath,
    });
  }

  /**
   * Create a new terminal tab with a command
   */
  public createNewTabWithCommand(cmd: string, cwd?: string): void {
    Logger.info(`[provider] createNewTabWithCommand: cmd="${cmd}" cwd="${cwd ?? "(default)"}" viewReady=${!!this._view?.webview}`);
    this._view?.webview.postMessage({
      command: "createNewTab",
      terminalType: "command",
      launchCommand: cmd,
      cwd: cwd || undefined,
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
   * Get the active webview (if any). DEBUG-only accessor for commands
   * that need to post messages directly to the webview.
   */
  public getWebview(): vscode.Webview | undefined {
    return this._view?.webview;
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
   * Unified launcher: shells + saved commands + ad-hoc command input.
   * - Top section: detected shells (default shell first)
   * - Middle section: user's saved commands
   * - Bottom: template variable help + edit saved commands
   * - Type to filter or enter an ad-hoc command
   * - Enter with no input opens the default shell
   */
  public async launchCommandPicker(): Promise<void> {
    try {
      const shells = ShellDetector.detectShells();
      const saved = this._commandManager.getSavedCommands();

      const qp = vscode.window.createQuickPick<any>();
      qp.title = "New Terminal";
      qp.placeholder = "Select a shell, saved command, or type a command";
      qp.matchOnDescription = true;
      qp.matchOnDetail = true;

      // Sentinel items
      const helpSeparator = { label: "Template Variables", kind: vscode.QuickPickItemKind.Separator } as any;
      const helpItem = {
        label: "$(symbol-variable) {workspace}  {workspacePath}  {user}  {platform}  {env.VAR}",
        description: "",
        detail: "Use these in commands to adapt per-workspace. Supports {key:default} and {key?then:else}.",
        launchCommand: "",
        saved: false,
        isShell: false,
        alwaysShow: true,
      };
      const editItem = {
        label: "$(edit) Edit Saved Commands\u2026",
        description: "",
        detail: "Open settings to add, remove, or modify saved commands",
        launchCommand: "",
        saved: false,
        isShell: false,
        alwaysShow: true,
      };

      // Shell items
      const shellSeparator = { label: "Shells", kind: vscode.QuickPickItemKind.Separator } as any;
      const shellItems = shells.map((s) => ({
        label: `$(terminal) ${s.label}${s.isDefault ? " (default)" : ""}`,
        description: s.path,
        launchCommand: "",
        saved: false,
        isShell: true,
        shellPath: s.path,
      }));

      // Saved command items
      const savedSeparator = saved.length > 0
        ? { label: "Saved Commands", kind: vscode.QuickPickItemKind.Separator } as any
        : null;

      const buildItems = (value: string) => {
        const items: any[] = [];

        // Ad-hoc command if user typed something
        const trimmed = value.trim();
        if (trimmed && !saved.some((c) => c.command === trimmed)) {
          const expanded = this._commandManager.expandCommand(trimmed);
          const preview = expanded !== trimmed ? `\u2192 ${expanded}` : undefined;
          items.push({
            label: `Run: ${trimmed}`,
            description: "(new command)",
            detail: preview || "Press Enter to launch",
            launchCommand: trimmed,
            saved: false,
            isShell: false,
          });
        }

        // Shells
        items.push(shellSeparator, ...shellItems);

        // Saved commands
        if (savedSeparator) {
          items.push(savedSeparator);
          for (const c of saved) {
            const expanded = this._commandManager.expandCommand(c.command);
            const preview = expanded !== c.command ? `\u2192 ${expanded}` : undefined;
            const cwdHint = c.cwd ? `  \u2022  cwd: ${c.cwd}` : "";
            items.push({
              label: c.label,
              description: c.command,
              detail: preview
                ? `${preview}${cwdHint}  \u2022  Used ${c.count} \u2022 Last ${new Date(c.lastUsed).toLocaleDateString()}`
                : `Used ${c.count} \u2022 Last ${new Date(c.lastUsed).toLocaleDateString()}${cwdHint}`,
              launchCommand: c.command,
              saved: true,
              isShell: false,
            });
          }
        }

        items.push(helpSeparator, helpItem, editItem);
        return items;
      };

      qp.items = buildItems("");

      const disposables: vscode.Disposable[] = [];
      disposables.push(
        qp.onDidChangeValue((val: string) => {
          qp.items = buildItems(val);
        }),
        qp.onDidAccept(async () => {
          const value = qp.value.trim();
          const sel = qp.selectedItems[0];

          // Handle sentinel items
          if (sel === editItem && !value) {
            qp.dispose();
            // Seed template entries if the setting is empty so users can see the format
            const config = vscode.workspace.getConfiguration("alterminal");
            const existing = config.get<unknown[]>("savedCommands", []);
            if (existing.length === 0) {
              await config.update("savedCommands", [
                { label: "Hello World", command: "echo hello" },
                { label: "Dev Server", command: "npm run dev", cwd: "{workspacePath}" },
              ], vscode.ConfigurationTarget.Global);
            }
            vscode.commands.executeCommand("workbench.action.openSettings", "alterminal.savedCommands");
            return;
          }
          if (sel === helpItem && !value) return;

          // Shell selected
          if (!value && sel?.isShell) {
            qp.dispose();
            this.createNewTab("default", sel.shellPath);
            return;
          }

          // Command (typed or selected saved command)
          const commandToRun = value || (sel && !sel.isShell && sel !== helpItem && sel !== editItem ? sel.launchCommand : "");
          const savedLabel = (!value && sel) ? sel.label : undefined;

          if (!commandToRun) {
            // No input, no selection change — open default shell
            qp.dispose();
            this.createNewTab();
            return;
          }

          qp.busy = true;
          try {
            if (saved.some((c) => c.command === commandToRun)) {
              await this._commandManager.launchSavedCommand(commandToRun, savedLabel);
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
   * Apply edited metadata and push state live to the webview.
   * Used by debugState command after the user saves the temp file.
   */
  public applyEditedMetadata(metadata: any): void {
    this.stateManager.saveMetadata(metadata);
    if (this._view) {
      this.stateManager.pushStateToWebview(this._view.webview);
    }
  }

  /**
   * Get the state manager (for read-only access from commands).
   */
  public getStateManager(): StateManager {
    return this.stateManager;
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
    this.focusGuard.detach();
    this._ptyManager.dispose();
    this.configurationWatcher.dispose();
  }
}
