import * as vscode from 'vscode';
import { PtyManager } from './terminal/ptyManager';
import { TemplateUtils } from './utils/templateUtils';
import { Logger } from './utils/logger';

export class ClaudeCodeProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'claudePilotView';
    private static _instance?: ClaudeCodeProvider;
    private _view?: vscode.WebviewView;
    private _ptyManager: PtyManager;
    private _context: vscode.ExtensionContext;
    private _fileWatcher?: vscode.FileSystemWatcher;
    private _workspaceFiles = new Set<string>();
    private _isColdBoot = true; // determined once at construction/activation

    constructor(private readonly _extensionUri: vscode.Uri, context: vscode.ExtensionContext, ptyManager: PtyManager) {
        ClaudeCodeProvider._instance = this;
        this._context = context;
        this._ptyManager = ptyManager;
    }


    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        
        // Serializer will handle webview lifecycle

        webviewView.webview.options = {
            enableScripts: true,
            enableForms: true,
            enableCommandUris: true,
            localResourceRoots: [this._extensionUri]
        };

        // Get configuration
        const config = vscode.workspace.getConfiguration('claudePilot');
        const scrollback = config.get<number>('terminal.scrollback', 1000);

        // Set up components with the webview
        this._ptyManager.setWebviewView(webviewView);
        this._ptyManager.setScrollback(scrollback);
        
        // Always include a unique timestamp to force webview refresh (from PostgreSQL extension pattern)
        const timeNow = new Date().getTime();
        webviewView.webview.html = TemplateUtils.getHtmlTemplate(this._extensionUri, webviewView.webview, timeNow);


        // State restoration will happen when webview emits 'webviewReady' event

        // Monitor webview visibility changes and lifecycle
        this.setupWebviewLifecycle(webviewView);

        // Set up message router with component delegation
        this.setupMessageRouter(webviewView);
        
        // Initialize workspace file cache
        this.initializeWorkspaceFileCache();
    }

    /**
     * Set up webview lifecycle event handlers
     */
    private setupWebviewLifecycle(webviewView: vscode.WebviewView) {
        Logger.debug('⚠️ Setting up webview lifecycle handlers');
        
        // Monitor visibility changes (no restoration here - purely event-driven via webviewReady)
        webviewView.onDidChangeVisibility(() => {
            Logger.debug('👁️ Webview visibility changed:', webviewView.visible ? 'VISIBLE' : 'HIDDEN');
            if (webviewView.visible) {
                // Just refresh active state, restoration happens via webviewReady event
                this._view?.webview.postMessage({ command: 'refreshActive' });
            }
        });
        
        // Monitor disposal
        webviewView.onDidDispose(() => {
            Logger.debug('🗑️ Webview disposed');
            // Note: State is already saved synchronously by webview, no need for async save here
        });
    }

    /**
     * Set up message router with clean handler delegation
     */
    private setupMessageRouter(webviewView: vscode.WebviewView) {
        // Provider-specific message handlers
        const providerHandlers = {
            fileDrop: (msg: any) => this._handleDroppedFile(msg.fileName, msg.fileType, msg.fileSize, msg.fileData, msg.tabId),
            openFile: (msg: any) => this._handleOpenFile(msg.filePath),
            openUrl: (msg: any) => this._handleOpenUrl(msg.url),
            stateUpdate: (msg: any) => this._handleBackupStateUpdate(msg.state),
            stateResponse: (msg: any) => this._handleBackupStateUpdate(msg.state),
            webviewReady: () => {
                this.restoreWebviewState();
                // Check GitHub authentication after webview is ready
                this._checkGitHubAuthentication();
            },
            switchTab: () => {}, // No-op - handled in webview
            playBellSound: (msg: any) => this._playBellSound(msg.tabId, msg.tabLabel),
            testLinks: () => this._handleTestLinks(),
            requestFileCache: () => this._sendWorkspaceFileCache(),
            checkFileExists: (msg: any) => this._handleCheckFileExists(msg.filePath),
            setDebugFilter: (msg: any) => {}, // Handled in webview
            debugLog: (msg: any) => console.log(msg.message), // Log to VS Code debug console
            setDeveloperMode: (msg: any) => {}, // Handled in webview
            performanceReport: (msg: any) => this._showPerformanceReport(msg.data)
        };

        webviewView.webview.onDidReceiveMessage(
            message => {
                try {
                    // First, check if provider can handle the message directly
                    const providerHandler = providerHandlers[message.command as keyof typeof providerHandlers];
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
            []
        );
    }

    public async requestPerformanceReport() {
        if (!this._view) return;
        this._view.webview.postMessage({ command: 'collectPerformance' });
    }

    private _showPerformanceReport(data: any) {
        if (!data) return;
        const summary = `Terminals: ${data.count}\nAvg Init: ${data.avgInit.toFixed(1)}ms\nAvg Open->Active: ${data.avgOpenToActive.toFixed(1)}ms`;
        vscode.window.showInformationMessage('Performance Report', { modal: true, detail: summary });
        Logger.debug('📊 Performance detail:', data.samples);
    }

    public async refresh() {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Restarting Claude Pilot...",
            cancellable: false
        }, async (progress) => {
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
                    this._view.webview.html = TemplateUtils.getHtmlTemplate(this._extensionUri, this._view.webview, timeNow);
                }
                
                // Reinitialize file system watcher
                this._setupFileSystemWatcher();
                
                // Send fresh workspace file cache
                this._sendWorkspaceFileCache();
                
                progress.report({ increment: 100, message: "Complete!" });
                
                vscode.window.showInformationMessage('Claude Pilot restarted successfully!');
                
            } catch (error) {
                console.error('Error during refresh:', error);
                vscode.window.showErrorMessage(`Failed to restart Claude Pilot: ${error}`);
            }
        });
    }


    public triggerResize() {
        if (this._view) {
            this._view.webview.postMessage({ command: 'triggerResize' });
        }
    }

    public createNewTab(type?: string) {
        if (this._view) {
            this._view.webview.postMessage({ 
                command: 'createNewTab',
                terminalType: type 
            });
        }
    }

    public testLinks() {
        this._handleTestLinks();
    }

    public async openTerminal() {
        if (this._view) {
            this._view.show?.(true);
        } else {
            await vscode.commands.executeCommand('workbench.view.extension.claudePilotContainer');
        }
    }

    public sendFilePath(filePath: string, tabId: number) {
        this._ptyManager.sendFilePath(filePath, tabId);
    }

    private async _handleDroppedFile(fileName: string, fileType: string, fileSize: number, fileData: string, tabId: number) {
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
            if (filePath.startsWith('./') || filePath.startsWith('../')) {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (workspaceFolder) {
                    resolvedPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath).fsPath;
                }
            }
            
            // Handle tilde paths
            if (filePath.startsWith('~/')) {
                const homeDir = require('os').homedir();
                resolvedPath = filePath.replace('~', homeDir);
            }
            
            // Workspace containment guard (only allow outside workspace with confirmation)
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (workspaceRoot) {
                const path = require('path');
                const relative = path.relative(workspaceRoot, resolvedPath);
                const isOutside = relative.startsWith('..') || path.isAbsolute(relative) && !resolvedPath.startsWith(workspaceRoot);
                if (isOutside) {
                    const choice = await vscode.window.showWarningMessage(
                        `Open external file outside workspace?\n${resolvedPath}`,
                        { modal: true, detail: 'Links are limited to workspace files for safety. Proceed only if you trust the source.' },
                        'Open',
                        'Cancel'
                    );
                    if (choice !== 'Open') {
                        Logger.debug('Open file cancelled (outside workspace):', resolvedPath);
                        return;
                    }
                }
            }
            
            const uri = vscode.Uri.file(resolvedPath);
            Logger.debug(`Opening file: ${filePath} -> ${resolvedPath}`);
            await vscode.window.showTextDocument(uri);
        } catch (error) {
            Logger.error('Failed to open file:', error);
            vscode.window.showErrorMessage(`Failed to open file: ${filePath}`);
        }
    }

    private async _handleOpenUrl(url: string) {
        try {
            const uri = vscode.Uri.parse(url);
            await vscode.env.openExternal(uri);
        } catch (error) {
            console.error('Failed to open URL:', error);
        }
    }

    private _playBellSound(tabId: number, tabLabel: string) {
        try {
            // Show clickable notification with action to go to the tab
            vscode.window.showInformationMessage(
                `Terminal Bell: ${tabLabel || `Tab ${tabId}`}`,
                'Go to Terminal'
            ).then(selection => {
                if (selection === 'Go to Terminal') {
                    // Focus the Claude Pilot view and switch to the specific tab
                    this.openTerminal().then(() => {
                        // Send message to switch to the specific tab
                        if (this._view) {
                            this._view.webview.postMessage({
                                command: 'switchToTab',
                                tabId: tabId
                            });
                        }
                    });
                }
            });
            
            // Also try to focus the VS Code window (OS-level attention getting)
            vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup').then(() => {}, () => {
                // Fallback if focus command fails
                Logger.debug('Could not focus editor group');
            });
            
        } catch (error) {
            Logger.error('Failed to play bell sound:', error);  
        }
    }

    private _handleTestLinks() {
        if (!this._view) return;
        
        // Send test links to the active terminal for easy testing
        const testLinks = [
            '\r\n\x1b[36m=== Testing WebLinksAddon ===\x1b[0m\r\n',
            '\r\nFile paths to test:\r\n',
            '/Users/volte/Workspace/TwilightCoders/claudepilot/package.json\r\n',
            './src/extension.ts\r\n',
            '../README.md\r\n',
            '~/Desktop\r\n',
            '\r\nURLs to test:\r\n',
            'https://github.com/microsoft/vscode\r\n',
            'http://example.com\r\n',
            'https://code.visualstudio.com\r\n',
            '\r\nYou can also test by typing these commands:\r\n',
            'echo "Check out https://github.com"\r\n',
            'ls -la ./src/extension.ts\r\n', 
            'cat ~/Desktop\r\n',
            '\r\nClick on any of the above links to test the WebLinksAddon!\r\n',
            '\x1b[36m=========================\x1b[0m\r\n\r\n'
        ];
        
        // Send each test link with a small delay
        testLinks.forEach((link, index) => {
            setTimeout(() => {
                this._view?.webview.postMessage({
                    command: 'data',
                    data: link
                });
            }, index * 100);
        });
    }

    private async _handleBackupStateUpdate(state: any) {
        try {
            // Save backup state to extension workspace (non-critical)
            if (state) {
                await this._context.workspaceState.update('claudePilot.webviewState', {
                    terminals: state.terminals || [],
                    activeTabId: state.activeTabId || 1,
                    timestamp: Date.now()
                });
                Logger.debug('💾 Saved backup state to extension workspace');
            }
        } catch (error) {
            Logger.warn('⚠️ Failed to save backup state (non-critical):', error);
        }
    }

    private async restoreWebviewState() {
        if (!this._view) return;
        
        try {
            // Get saved backup state from extension context (webview handles primary state itself)
            const backupState = this._context.workspaceState.get('claudePilot.webviewState') as any;
            
            console.log('📤 Restoring webview state:', {
                isColdBoot: this._isColdBoot,
                hasBackupState: !!(backupState && backupState.terminals && backupState.terminals.length > 0)
            });
            if (backupState && backupState.terminals && backupState.terminals.length > 0) {
                Logger.debug('📤 Sending restoreState (cold=' + this._isColdBoot + ') with', backupState.terminals.length, 'terminals');
                this._view.webview.postMessage({ 
                    command: 'restoreState', 
                    state: backupState,
                    cold: this._isColdBoot
                });
            } else {
                Logger.debug('📤 No backup state - sending initialize (cold=' + this._isColdBoot + ')');
                this._view.webview.postMessage({ 
                    command: 'initializeEmpty',
                    cold: this._isColdBoot
                });
            }
            
        } catch (error) {
            Logger.error('❌ Failed to restore webview state:', error);
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
            const cachedFiles = this._context.workspaceState.get<string[]>('workspaceFiles', []);
            this._workspaceFiles = new Set(cachedFiles);
            
            // Send initial cache to webview
            this._sendWorkspaceFileCache();
            
            // Update cache with current workspace files
            await this._updateWorkspaceFileCache();
            
            // Set up file system watcher
            this._setupFileSystemWatcher();
        } catch (error) {
            Logger.error('Failed to initialize workspace file cache:', error);
        }
    }
    
    /**
     * Update workspace file cache by scanning filesystem
     */
    private async _updateWorkspaceFileCache() {
        Logger.debug('🔄 Updating workspace file cache');
        
        try {
            const files = await vscode.workspace.findFiles(
                '**/*',
                '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**}'
            );
            
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                Logger.warn('No workspace folder found');
                return;
            }
            
            // Convert to relative paths for better matching with terminal output
            const relativePaths = files.map(f => {
                const relativePath = vscode.workspace.asRelativePath(f);
                return relativePath;
            });
            
            // Also add common relative path variations
            const allPaths = new Set(relativePaths);
            relativePaths.forEach(path => {
                // Add ./ prefix version for relative paths that don't start with ../
                if (!path.startsWith('../')) {
                    allPaths.add('./' + path);
                }
            });
            
            const filePathsArray = Array.from(allPaths);
            this._workspaceFiles = new Set(filePathsArray);
            
            // Store in workspace state
            await this._context.workspaceState.update('workspaceFiles', filePathsArray);
            
            // Send to webview
            this._sendWorkspaceFileCache();
            
        } catch (error) {
            Logger.error('Failed to update workspace file cache:', error);
        }
    }
    
    /**
     * Check GitHub authentication and log user ID for developer detection
     */
    private async _checkGitHubAuthentication() {
        try {
            console.log('Attempting GitHub authentication check...');
            
            // Check available GitHub accounts (this works!)
            const authProviders = await vscode.authentication.getAccounts('github');
            console.log('Available GitHub accounts:', authProviders);
            
            // Check if developer (you) is signed in
            console.log('=== DEVELOPER DETECTION DEBUG ===');
            const isDeveloper = authProviders.some(account => 
                account.id === '1700514'
            );
            console.log('=== DEVELOPER DETECTION ===');
            console.log('Is Developer (volte):', isDeveloper);
            console.log('==========================');
            
            // Send developer status to webview
            if (this._view) {
                this._view.webview.postMessage({
                    command: 'setDeveloperMode',
                    enabled: isDeveloper
                });
                console.log('Developer mode', isDeveloper ? 'enabled' : 'disabled', 'for webview');
            }
            
        } catch (error) {
            console.log('GitHub authentication check failed:', error);
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
            '**/*',
            false, // Don't ignore creates
            true,  // Ignore changes (we only care about file existence)
            false  // Don't ignore deletes
        );
        
        // Handle file creation
        this._fileWatcher.onDidCreate(uri => {
            const relativePath = vscode.workspace.asRelativePath(uri);
            this._workspaceFiles.add(relativePath);
            // Also add ./ prefix version if it doesn't start with ../
            if (!relativePath.startsWith('../')) {
                this._workspaceFiles.add('./' + relativePath);
            }
            this._updateWorkspaceStateCache();
        });
        
        // Handle file deletion
        this._fileWatcher.onDidDelete(uri => {
            const relativePath = vscode.workspace.asRelativePath(uri);
            this._workspaceFiles.delete(relativePath);
            this._workspaceFiles.delete('./' + relativePath);
            this._updateWorkspaceStateCache();
        });
        
        Logger.debug('👁️ File system watcher set up');
    }
    
    /**
     * Update workspace state with current file cache (debounced)
     */
    private _updateWorkspaceStateCache = this._debounce(() => {
        const filePaths = Array.from(this._workspaceFiles);
        this._context.workspaceState.update('workspaceFiles', filePaths);
        this._sendWorkspaceFileCache();
    }, 500);
    
    /**
     * Send workspace file cache to webview
     */
    private _sendWorkspaceFileCache() {
        if (!this._view) return;
        
        const filePaths = Array.from(this._workspaceFiles);
        this._view.webview.postMessage({
            command: 'updateFileCache',
            files: filePaths
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
                command: 'fileExistsResponse',
                filePath: filePath,
                exists: exists
            });
        }
        
        Logger.debug(`🔍 File existence check: ${filePath} -> ${exists}`);
    }
    
    /**
     * Simple debounce utility
     */
    private _debounce<T extends (...args: any[]) => any>(func: T, wait: number): T {
        let timeout: NodeJS.Timeout;
        return ((...args: any[]) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        }) as T;
    }

    public setDebugFilter(filter: string[] | null) {
        if (this._view) {
            this._view.webview.postMessage({ 
                command: 'setDebugFilter', 
                filter: filter 
            });
        }
    }

    public dispose() {
        Logger.debug('⚠️ Disposing ClaudeCodeProvider');
        
        // Dispose file watcher
        if (this._fileWatcher) {
            this._fileWatcher.dispose();
        }
        
        // Note: State is already saved synchronously by webview, no need for async save here
        this._ptyManager.dispose();
    }

}
