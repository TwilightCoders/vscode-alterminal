import * as vscode from "vscode";
import { PtyManager } from "./terminal/ptyManager";
import { TemplateUtils } from "./utils/templateUtils";
import { Logger } from "./utils/logger";
import { CommandManager } from "./utils/commandManager";
import { Debouncer } from "./utils/debouncer";
import { TabTitleProvider } from "./providers/tabTitleProvider";

export class AlterminalProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "alterminalView";
  private static _instance?: AlterminalProvider;
  private _view?: vscode.WebviewView;
  private _ptyManager: PtyManager;
  private _context: vscode.ExtensionContext;
  private _fileWatcher?: vscode.FileSystemWatcher;
  private _workspaceFiles = new Set<string>();
  private _isColdBoot = true; // determined once at construction/activation
  private _commandManager: CommandManager;
  private _restoreTriggered = false; // guard to avoid missing restore due to race
  private _serializer?: any;
  private _tabTitleProvider = new TabTitleProvider();

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
    // Initialize CommandManager asynchronously to avoid blocking extension startup
    this._commandManager = new CommandManager(
      {
        getConfiguration: (section: string) =>
          vscode.workspace.getConfiguration(section),
        window: vscode.window,
        commands: vscode.commands,
      },
      (command: string) => this.createNewTabWithCommand(command),
    );
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    // Serializer will handle webview lifecycle
    if (this._serializer && this._serializer.setWebviewView) {
      this._serializer.setWebviewView(webviewView);
    }

    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: [this._extensionUri],
    };

  // Set up message router BEFORE loading HTML so we don't miss early messages (e.g., webviewReady)
  this.setupMessageRouter(webviewView);

    // Get configuration
    const config = vscode.workspace.getConfiguration("alterminal");
    const scrollback = config.get<number>("terminal.scrollback", 1000);

    // Set up components with the webview
    this._ptyManager.setWebviewView(webviewView);
    this._ptyManager.setScrollback(scrollback);

  // Always include a unique timestamp to force webview refresh (from PostgreSQL extension pattern)
    const timeNow = new Date().getTime();
    try {
      webviewView.webview.html = TemplateUtils.getHtmlTemplate(
        this._extensionUri,
        webviewView.webview,
        timeNow,
      );
    } catch (error) {
      Logger.error("Failed to generate webview HTML template:", error);
      webviewView.webview.html = `
                <html><body>
                <h1>Error Loading Alterminal</h1>
                <p>Failed to generate webview template: ${error.message}</p>
                <p>Check the extension logs for more details.</p>
                </body></html>
            `;
    }

    // State restoration will happen when webview emits 'webviewReady' event

    // Monitor webview visibility changes and lifecycle
    this.setupWebviewLifecycle(webviewView);

    // Initialize workspace file cache
    this.initializeWorkspaceFileCache();
  }

  /**
   * Set up webview lifecycle event handlers
   */
  private setupWebviewLifecycle(webviewView: vscode.WebviewView) {
    Logger.debug("⚠️ Setting up webview lifecycle handlers");

    // Monitor visibility changes (no restoration here - purely event-driven via webviewReady)
    webviewView.onDidChangeVisibility(() => {
      Logger.debug(
        "👁️ Webview visibility changed:",
        webviewView.visible ? "VISIBLE" : "HIDDEN",
      );
      if (webviewView.visible) {
        // Just refresh active state, restoration happens via webviewReady event
        this._view?.webview.postMessage({ command: "refreshActive" });
      }
    });

    // Monitor disposal
    webviewView.onDidDispose(() => {
      Logger.debug("🗑️ Webview disposed");
      // Note: State is already saved synchronously by webview, no need for async save here
    });
  }

  /**
   * Set up message router with clean handler delegation
   */
  private setupMessageRouter(webviewView: vscode.WebviewView) {
    // Provider-specific message handlers
    const providerHandlers = {
      fileDrop: (msg: any) =>
        this._handleDroppedFile(
          msg.fileName,
          msg.fileType,
          msg.fileSize,
          msg.fileData,
          msg.tabId,
        ),
      openFile: (msg: any) => this._handleOpenFile(msg.filePath),
      openUrl: (msg: any) => this._handleOpenUrl(msg.url),
      stateUpdate: (msg: any) => {
        this._handleBackupStateUpdate(msg.state);
        if (this._serializer?.handleMessage) this._serializer.handleMessage(msg);
      },
      stateResponse: (msg: any) => {
        this._handleBackupStateUpdate(msg.state);
        if (this._serializer?.handleMessage) this._serializer.handleMessage(msg);
      },
      webviewReady: () => {
  this._restoreTriggered = true;
  this.restoreWebviewState();
        // Check for developer mode
        this._checkDeveloperMode();
        // Send saved commands list so webview can hide Save Command where appropriate
        try {
          const saved = this._commandManager
            .getSavedCommands()
            .map((c) => c.launchCommand);
          this._view?.webview.postMessage({
            command: "savedCommandsList",
            commands: saved,
          });
        } catch (e) {
          Logger.warn("Failed sending savedCommandsList", e);
        }
      },
      switchTab: () => {}, // No-op - handled in webview
      playBellSound: (msg: any) => this._playBellSound(msg.tabId, msg.tabLabel),
      testLinks: () => this._handleTestLinks(),
      requestFileCache: () => this._sendWorkspaceFileCache(),
      checkFileExists: (msg: any) => this._handleCheckFileExists(msg.filePath),
      setDebugFilter: (msg: any) => {}, // Handled in webview
  debugLog: (msg: any) => console.log(msg.message), // Log to VS Code debug console
      setDeveloperMode: (msg: any) => {}, // Handled in webview
      performanceReport: (msg: any) => this._showPerformanceReport(msg.data),
      saveCommand: (msg: any) => this._handleSaveCommand(msg),
      checkCommandSaved: (msg: any) => this._handleCheckCommandSaved(msg),
  formatTabTitle: (msg: any) => this._handleFormatTabTitle(msg),
    };

    webviewView.webview.onDidReceiveMessage(
      (message) => {
        try {
          // First, check if provider can handle the message directly
          const providerHandler =
            providerHandlers[message.command as keyof typeof providerHandlers];
          if (providerHandler) {
            providerHandler(message);
            return;
          }

          // Delegate to appropriate manager based on message type
          if (this._ptyManager?.canHandle(message.command)) {
            this._ptyManager.handleMessage(message);
          } else {
            Logger.warn(`Unhandled message command: ${message.command}`);
          }
        } catch (error) {
          Logger.error(`Error handling message ${message.command}:`, error);
        }
      },
      undefined,
      [],
    );
  }

  private _handleFormatTabTitle(msg: any) {
    try {
      const template = this._tabTitleProvider.getTemplate();
      
      // Debug logging to see what we're working with
      Logger.debug(`Tab title formatting for ${msg.tabId}:`, {
        template,
        tabName: msg.tabName,
        baseTabName: msg.baseTabName,
        processName: msg.processName,
      });
      
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
      
      Logger.debug(`Formatted title result: "${title}"`);
      this._view?.webview.postMessage({
        command: "formatTabTitleResponse",
        tabId: msg.tabId,
        title,
      });
    } catch (e) {
      Logger.warn("Failed to format tab title", e);
    }
  }

  public async requestPerformanceReport() {
    if (!this._view) return;
    this._view.webview.postMessage({ command: "collectPerformance" });
  }

  private _showPerformanceReport(data: any) {
    if (!data) return;
    const summary = `Terminals: ${data.count}\nAvg Init: ${data.avgInit.toFixed(1)}ms\nAvg Open->Active: ${data.avgOpenToActive.toFixed(1)}ms`;
    vscode.window.showInformationMessage("Performance Report", {
      modal: true,
      detail: summary,
    });
    Logger.debug("📊 Performance detail:", data.samples);
  }

  public async refresh() {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Restarting Alterminal...",
        cancellable: false,
      },
      async (progress) => {
        try {
          progress.report({ increment: 0, message: "Disposing terminals..." });

          // Kill all PTY processes
          this._ptyManager.dispose();

          progress.report({ increment: 25, message: "Clearing caches..." });

          // Clear workspace file cache
          this._workspaceFiles.clear();

          // Clear extension state (optional - might want to preserve some settings)
          // await this._context.workspaceState.clear();

          progress.report({ increment: 50, message: "Disposing webview..." });

          // Dispose file watcher
          if (this._fileWatcher) {
            this._fileWatcher.dispose();
            this._fileWatcher = undefined;
          }

          progress.report({ increment: 75, message: "Reinitializing..." });

          // Reset webview HTML to force complete reload
          if (this._view) {
            const timeNow = new Date().getTime();
            this._view.webview.html = TemplateUtils.getHtmlTemplate(
              this._extensionUri,
              this._view.webview,
              timeNow,
            );
          }

          // Reinitialize file system watcher
          this._setupFileSystemWatcher();

          // Send fresh workspace file cache
          this._sendWorkspaceFileCache();

          progress.report({ increment: 100, message: "Complete!" });

          vscode.window.showInformationMessage(
            "Alterminal restarted successfully!",
          );
        } catch (error) {
          Logger.error("Error during refresh:", error);
          vscode.window.showErrorMessage(
            `Failed to restart Alterminal: ${error}`,
          );
        }
      },
    );
  }

  public triggerResize() {
    if (this._view) {
      this._view.webview.postMessage({ command: "triggerResize" });
    }
  }

  public createNewTab(type?: string) {
    if (this._view) {
      this._view.webview.postMessage({
        command: "createNewTab",
        terminalType: type,
      });
    }
  }

  public createNewTabWithCommand(cmd: string) {
    if (this._view) {
      this._view.webview.postMessage({
        command: "createNewTab",
        terminalType: "command",
        launchCommand: cmd,
      });
    }
  }

  public testLinks() {
    this._handleTestLinks();
  }

  public async openTerminal() {
    // Just focus the view, don't force show it
    await vscode.commands.executeCommand("alterminalView.focus");
  }

  public sendFilePath(filePath: string, tabId: number) {
    this._ptyManager.sendFilePath(filePath, tabId);
  }

  private async _handleDroppedFile(
    fileName: string,
    fileType: string,
    fileSize: number,
    fileData: string,
    tabId: number,
  ) {
    // Route file operations to PtyManager
    if (fileData) {
      await this._ptyManager.sendFileData(fileData, fileName, fileType, tabId);
    } else {
      this._ptyManager.writeToPty(`Failed to read file: ${fileName}\n`, tabId);
    }
  }

  private async _handleOpenFile(filePath: string) {
    try {
      let resolvedPath = filePath;

      // Handle relative paths
      if (filePath.startsWith("./") || filePath.startsWith("../")) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          resolvedPath = vscode.Uri.joinPath(
            workspaceFolder.uri,
            filePath,
          ).fsPath;
        }
      }

      // Handle tilde paths
      if (filePath.startsWith("~/")) {
        const homeDir = require("os").homedir();
        resolvedPath = filePath.replace("~", homeDir);
      }

      // Workspace containment guard (only allow outside workspace with confirmation)
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceRoot) {
        const path = require("path");
        const relative = path.relative(workspaceRoot, resolvedPath);
        const isOutside =
          relative.startsWith("..") ||
          (path.isAbsolute(relative) &&
            !resolvedPath.startsWith(workspaceRoot));
        if (isOutside) {
          const choice = await vscode.window.showWarningMessage(
            `Open external file outside workspace?\n${resolvedPath}`,
            {
              modal: true,
              detail:
                "Links are limited to workspace files for safety. Proceed only if you trust the source.",
            },
            "Open",
            "Cancel",
          );
          if (choice !== "Open") {
            Logger.debug(
              "Open file cancelled (outside workspace):",
              resolvedPath,
            );
            return;
          }
        }
      }

      const uri = vscode.Uri.file(resolvedPath);
      Logger.debug(`Opening file: ${filePath} -> ${resolvedPath}`);
      await vscode.window.showTextDocument(uri);
    } catch (error) {
      Logger.error("Failed to open file:", error);
      vscode.window.showErrorMessage(`Failed to open file: ${filePath}`);
    }
  }

  private async _handleOpenUrl(url: string) {
    try {
      const uri = vscode.Uri.parse(url);
      await vscode.env.openExternal(uri);
    } catch (error) {
      console.error("Failed to open URL:", error);
    }
  }

  private _playBellSound(tabId: number, tabLabel: string) {
    try {
      // Show clickable notification with action to go to the tab
      vscode.window
        .showInformationMessage(
          `Terminal Bell: ${tabLabel || `Tab ${tabId}`}`,
          "Go to Terminal",
        )
        .then((selection) => {
          if (selection === "Go to Terminal") {
            // Focus the Alterminal view and switch to the specific tab
            this.openTerminal().then(() => {
              // Send message to switch to the specific tab
              if (this._view) {
                this._view.webview.postMessage({
                  command: "switchToTab",
                  tabId: tabId,
                });
              }
            });
          }
        });

      // Also try to focus the VS Code window (OS-level attention getting)
      vscode.commands
        .executeCommand("workbench.action.focusActiveEditorGroup")
        .then(
          () => {},
          () => {
            // Fallback if focus command fails
            Logger.debug("Could not focus editor group");
          },
        );
    } catch (error) {
      Logger.error("Failed to play bell sound:", error);
    }
  }

  private _handleTestLinks() {
    if (!this._view) return;

    // Send test links to the active terminal for easy testing
    const testLinks = [
      "\r\n\x1b[36m=== Testing WebLinksAddon ===\x1b[0m\r\n",
      "\r\nFile paths to test:\r\n",
  // Example absolute path (adjusted to current project naming)
  "/Users/volte/Workspace/TwilightCoders/alterminal/package.json\r\n",
      "./src/extension.ts\r\n",
      "../README.md\r\n",
      "~/Desktop\r\n",
      "\r\nURLs to test:\r\n",
      "https://github.com/microsoft/vscode\r\n",
      "http://example.com\r\n",
      "https://code.visualstudio.com\r\n",
      "\r\nYou can also test by typing these commands:\r\n",
      'echo "Check out https://github.com"\r\n',
      "ls -la ./src/extension.ts\r\n",
      "cat ~/Desktop\r\n",
      "\r\nClick on any of the above links to test the WebLinksAddon!\r\n",
      "\x1b[36m=========================\x1b[0m\r\n\r\n",
    ];

    // Send each test link with a small delay
    testLinks.forEach((link, index) => {
      setTimeout(() => {
        this._view?.webview.postMessage({
          command: "data",
          data: link,
        });
      }, index * 100);
    });
  }

  private async _handleBackupStateUpdate(state: any) {
    try {
      // Save backup state to extension workspace (non-critical)
      if (state) {
        await this._context.workspaceState.update("alterminal.webviewState", {
          terminals: state.terminals || [],
          activeTabId: state.activeTabId || 1,
          timestamp: Date.now(),
        });
        Logger.debug("💾 Saved backup state to extension workspace");
      }
    } catch (error) {
      Logger.warn("⚠️ Failed to save backup state (non-critical):", error);
    }
  }

  private async restoreWebviewState() {
    if (!this._view) return;

    try {
  this._restoreTriggered = true;
      // Get saved backup state from extension context (webview handles primary state itself)
      const backupState = this._context.workspaceState.get(
        "alterminal.webviewState",
      ) as any;

  Logger.debug("📤 Restoring webview state:", {
        isColdBoot: this._isColdBoot,
        hasBackupState: !!(
          backupState &&
          backupState.terminals &&
          backupState.terminals.length > 0
        ),
      });
      if (
        backupState &&
        backupState.terminals &&
        backupState.terminals.length > 0
      ) {
        Logger.debug(
          "📤 Sending restoreState (cold=" + this._isColdBoot + ") with",
          backupState.terminals.length,
          "terminals",
        );
        this._view.webview.postMessage({
          command: "restoreState",
          state: backupState,
          cold: this._isColdBoot,
        });
      } else {
        Logger.debug(
          "📤 No backup state - sending initialize (cold=" +
            this._isColdBoot +
            ")",
        );
        this._view.webview.postMessage({
          command: "initializeEmpty",
          cold: this._isColdBoot,
        });
      }
    } catch (error) {
      Logger.error("❌ Failed to restore webview state:", error);
    } finally {
      this._isColdBoot = false;
    }
  }

  /**
   * Initialize workspace file cache with file system watcher
   */
  private async initializeWorkspaceFileCache() {
    try {
      // Load cached files from workspace state
      const cachedFiles = this._context.workspaceState.get<string[]>(
        "alterminal.workspaceFiles",
        [],
      );
      this._workspaceFiles = new Set(cachedFiles);

      // Send initial cache to webview
      this._sendWorkspaceFileCache();

      // Update cache with current workspace files
      await this._updateWorkspaceFileCache();

      // Set up file system watcher
      this._setupFileSystemWatcher();
    } catch (error) {
      Logger.error("Failed to initialize workspace file cache:", error);
    }
  }

  /**
   * Update workspace file cache by scanning filesystem
   */
  private async _updateWorkspaceFileCache() {
    Logger.debug("🔄 Updating workspace file cache");

    try {
      const files = await vscode.workspace.findFiles(
        "**/*",
        "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**}",
      );

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        Logger.warn("No workspace folder found");
        return;
      }

      // Convert to relative paths for better matching with terminal output
      const relativePaths = files.map((f) => {
        const relativePath = vscode.workspace.asRelativePath(f);
        return relativePath;
      });

      // Also add common relative path variations
      const allPaths = new Set(relativePaths);
      relativePaths.forEach((path) => {
        // Add ./ prefix version for relative paths that don't start with ../
        if (!path.startsWith("../")) {
          allPaths.add("./" + path);
        }
      });

        // Fallback: if webviewReady is missed for any reason, trigger restore after a short delay
        setTimeout(() => {
          if (!this._restoreTriggered) {
            Logger.debug("⏱️ Fallback restoreWebviewState triggered (missed webviewReady)");
            this.restoreWebviewState();
          }
        }, 500);
      const filePathsArray = Array.from(allPaths);
      this._workspaceFiles = new Set(filePathsArray);

      // Store in workspace state
      await this._context.workspaceState.update(
        "alterminal.workspaceFiles",
        filePathsArray,
      );

      // Send to webview
      this._sendWorkspaceFileCache();
    } catch (error) {
      Logger.error("Failed to update workspace file cache:", error);
    }
  }

  /**
   * Check for developer mode using VS Code extension development mode
   */
  private async _checkDeveloperMode() {
    const isDeveloper =
      this._context.extensionMode === vscode.ExtensionMode.Development;

    // Send developer status to webview
    if (this._view) {
      this._view.webview.postMessage({
        command: "setDeveloperMode",
        enabled: isDeveloper,
      });
      Logger.debug("Developer mode", isDeveloper ? "enabled" : "disabled");
    }
  }

  /**
   * Set up file system watcher for cache updates
   */
  private _setupFileSystemWatcher() {
    // Dispose existing watcher
    if (this._fileWatcher) {
      this._fileWatcher.dispose();
    }

    // Create new watcher
    this._fileWatcher = vscode.workspace.createFileSystemWatcher(
      "**/*",
      false, // Don't ignore creates
      true, // Ignore changes (we only care about file existence)
      false, // Don't ignore deletes
    );

    // Handle file creation
    this._fileWatcher.onDidCreate((uri) => {
      const relativePath = vscode.workspace.asRelativePath(uri);
      this._workspaceFiles.add(relativePath);
      // Also add ./ prefix version if it doesn't start with ../
      if (!relativePath.startsWith("../")) {
        this._workspaceFiles.add("./" + relativePath);
      }
      this._updateWorkspaceStateCache();
    });

    // Handle file deletion
    this._fileWatcher.onDidDelete((uri) => {
      const relativePath = vscode.workspace.asRelativePath(uri);
      this._workspaceFiles.delete(relativePath);
      this._workspaceFiles.delete("./" + relativePath);
      this._updateWorkspaceStateCache();
    });

    Logger.debug("👁️ File system watcher set up");
  }

  /**
   * Update workspace state with current file cache (debounced via shared Debouncer)
   */
  private _updateWorkspaceStateCache = () => {
    Debouncer.debounce("workspace-files", 500, () => {
      const filePaths = Array.from(this._workspaceFiles);
      this._context.workspaceState.update(
        "alterminal.workspaceFiles",
        filePaths,
      );
      this._sendWorkspaceFileCache();
    });
  };

  /**
   * Send workspace file cache to webview
   */
  private _sendWorkspaceFileCache() {
    if (!this._view) return;
    const filePaths = Array.from(this._workspaceFiles);
    this._view.webview.postMessage({
      command: "updateFileCache",
      files: filePaths,
    });
    Logger.debug(`📤 Sent ${filePaths.length} files to webview cache`);
  }

  /**
   * Handle individual file existence check
   */
  private _handleCheckFileExists(filePath: string) {
    const exists = this._workspaceFiles.has(filePath);

    if (this._view) {
      this._view.webview.postMessage({
        command: "fileExistsResponse",
        filePath: filePath,
        exists: exists,
      });
    }

    Logger.debug(`🔍 File existence check: ${filePath} -> ${exists}`);
  }

  // Removed legacy _debounce helper in favor of shared Debouncer

  public setDebugFilter(filter: string[] | null) {
    if (this._view) {
      this._view.webview.postMessage({
        command: "setDebugFilter",
        filter,
      });
    }
  }

  public async showSavedCommands() {
    await this._commandManager.showSavedCommandsPicker();
  }

  public async saveCurrentCommand() {
    await this._commandManager.showSaveCommandDialog();
  }

  /**
   * Unified launcher: pick a saved command or type a new one inline.
   * - Filters saved commands as user types
   * - Enter with no selection launches typed command (unsaved)
   * - Selecting saved command increments usage & launches
   */
  public async launchCommandPicker() {
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
          description: c.launchCommand,
          detail: `Used ${c.usageCount} • Last ${new Date(c.lastUsed).toLocaleDateString()}`,
          launchCommand: c.launchCommand,
          saved: true,
        }));
        const trimmed = value.trim();
        if (trimmed && !saved.some((c) => c.launchCommand === trimmed)) {
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
          // Auto-select exact match if exists
          const exact = saved.find((c) => c.launchCommand === val.trim());
          if (exact) {
            const pick = qp.items.find(
              (i) => i.launchCommand === exact.launchCommand,
            );
            if (pick) qp.selectedItems = [pick];
          }
        }),
        qp.onDidAccept(async () => {
          const sel = qp.selectedItems[0];
          const value = sel ? sel.launchCommand : qp.value.trim();
          if (!value) {
            return;
          }
          qp.busy = true;
          try {
            if (saved.some((c) => c.launchCommand === value)) {
              await this._commandManager.launchSavedCommand(value);
            } else {
              this.createNewTabWithCommand(value);
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

  private async _handleSaveCommand(msg: any) {
    try {
      if (!msg.launchCommand) {
        Logger.warn("Cannot save command: no launch command provided");
        return;
      }

      // Use CommandManager to save the command
      await this._commandManager.saveCommand(msg.launchCommand);

      // Show success message
      vscode.window.showInformationMessage(
        `Command "${msg.launchCommand}" saved to quick launch menu!`,
      );

      Logger.info(`Command saved from tab ${msg.tabId}: ${msg.launchCommand}`);
    } catch (error) {
      Logger.error("Failed to save command:", error);
      vscode.window.showErrorMessage(
        "Failed to save command. Please try again.",
      );
    }
  }

  private _handleCheckCommandSaved(msg: any) {
    try {
      if (!msg.launchCommand) {
        Logger.warn(
          "Cannot check command saved status: no launch command provided",
        );
        return;
      }

      // Check if command exists in saved commands
      const savedCommands = this._commandManager.getSavedCommands();
      const isSaved = savedCommands.some(
        (cmd) => cmd.launchCommand === msg.launchCommand,
      );

      // Send response back to webview
      if (this._view) {
        this._view.webview.postMessage({
          command: "commandSavedResponse",
          launchCommand: msg.launchCommand,
          isSaved: isSaved,
        });
      }

      Logger.debug(
        `Command saved status check: ${msg.launchCommand} = ${isSaved}`,
      );
    } catch (error) {
      Logger.error("Failed to check command saved status:", error);
    }
  }

  /**
   * Handle context menu commands from VS Code
   */
  public handleContextMenuCommand(command: string, args: any) {
    Logger.debug(`Context menu command: ${command}`, args);

    switch (command) {
      case "saveTabCommand":
        this._handleContextMenuSaveCommand(args);
        break;
      case "renameTab":
        this._handleContextMenuRenameTab(args);
        break;
      case "closeTab":
        this._handleContextMenuCloseTab(args);
        break;
      default:
        Logger.warn(`Unknown context menu command: ${command}`);
    }
  }

  private async _handleContextMenuSaveCommand(args: any) {
    try {
      const tabId = args?.tabId;
      const launchCommand = args?.launchCommand;

      if (!launchCommand) {
        Logger.warn(
          "Cannot save command: no launchCommand provided in context",
        );
        vscode.window.showErrorMessage("No command to save");
        return;
      }

      await this._commandManager.saveCommand(launchCommand);
      vscode.window.showInformationMessage(
        `Command "${launchCommand}" saved to quick launch menu!`,
      );
      Logger.info(
        `Context menu - Command saved from tab ${tabId}: ${launchCommand}`,
      );
    } catch (error) {
      Logger.error("Failed to save command from context menu:", error);
      vscode.window.showErrorMessage(
        "Failed to save command. Please try again.",
      );
    }
  }

  private async _handleContextMenuRenameTab(args: any) {
    try {
      const tabId = args?.tabId;

      if (!tabId) {
        Logger.warn("Cannot rename tab: no tab ID provided");
        vscode.window.showErrorMessage("No tab selected");
        return;
      }

      if (this._view) {
        // Send rename command to webview to start inline editing
        this._view.webview.postMessage({
          command: "renameTab",
          tabId: parseInt(tabId),
        });

        Logger.info(`Context menu - Starting inline rename for tab ${tabId}`);
      }
    } catch (error) {
      Logger.error("Failed to start tab rename from context menu:", error);
      vscode.window.showErrorMessage(
        "Failed to start tab rename. Please try again.",
      );
    }
  }

  private _handleContextMenuCloseTab(args: any) {
    try {
      const tabId = args?.tabId;

      if (!tabId) {
        Logger.warn("Cannot close tab: no tab ID provided");
        vscode.window.showErrorMessage("No tab selected");
        return;
      }

      if (this._view) {
        // Send close command to webview
        this._view.webview.postMessage({
          command: "closeTab",
          tabId: parseInt(tabId),
        });

        Logger.info(`Context menu - Closed tab ${tabId}`);
      }
    } catch (error) {
      Logger.error("Failed to close tab from context menu:", error);
      vscode.window.showErrorMessage("Failed to close tab. Please try again.");
    }
  }

  // Debug reset methods
  public resetActiveColors() {
    if (this._view) {
      this._view.webview.postMessage({ command: "resetActiveColors" });
    }
  }

  public resetActiveCursor() {
    if (this._view) {
      this._view.webview.postMessage({ command: "resetActiveCursor" });
    }
  }

  public resetActiveMouse() {
    if (this._view) {
      this._view.webview.postMessage({ command: "resetActiveMouse" });
    }
  }

  public resetActiveScreen() {
    if (this._view) {
      this._view.webview.postMessage({ command: "resetActiveScreen" });
    }
  }

  public resetActiveTerminal() {
    if (this._view) {
      this._view.webview.postMessage({ command: "resetActiveTerminal" });
    }
  }

  public fixGhostCursor() {
    if (this._view) {
      this._view.webview.postMessage({ command: "fixGhostCursor" });
    }
  }

  public dispose() {
    Logger.debug("⚠️ Disposing AlterminalProvider");

    // Dispose file watcher
    if (this._fileWatcher) {
      this._fileWatcher.dispose();
    }

    // Note: State is already saved synchronously by webview, no need for async save here
    this._ptyManager.dispose();
  }
}
