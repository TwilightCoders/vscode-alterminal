import * as vscode from 'vscode';
import { PtyManager } from './terminal/ptyManager';
import { TemplateUtils } from './utils/templateUtils';
import { Logger } from './utils/logger';

export class ClaudeCodeProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'claudePilotView';
    private static _instance?: ClaudeCodeProvider;
    private _view?: vscode.WebviewView;
    private _ptyManager: PtyManager;
    private _terminalInitialized = false;
    private _context: vscode.ExtensionContext;

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

        this._terminalInitialized = true;

        // Initial state restoration after webview loads
        setTimeout(() => {
            this.restoreWebviewState();
        }, 100);

        // Monitor webview visibility changes and lifecycle
        this.setupWebviewLifecycle(webviewView);

        // Set up message router with component delegation
        this.setupMessageRouter(webviewView);
    }

    /**
     * Set up webview lifecycle event handlers
     */
    private setupWebviewLifecycle(webviewView: vscode.WebviewView) {
        Logger.debug('⚠️ Setting up webview lifecycle handlers');
        
        // Monitor visibility changes
        webviewView.onDidChangeVisibility(() => {
            Logger.debug('👁️ Webview visibility changed:', webviewView.visible ? 'VISIBLE' : 'HIDDEN');
            if (webviewView.visible) {
                this.restoreWebviewState();
            }
            // Note: We no longer save state on visibility change since webview handles it synchronously
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
            webviewReady: () => this.restoreWebviewState(),
            switchTab: () => {}, // No-op - handled in webview
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

    public refresh() {
        if (this._view) {
            this._view.webview.postMessage({ command: 'refresh' });
        }
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
            const uri = vscode.Uri.file(filePath);
            await vscode.window.showTextDocument(uri);
        } catch (error) {
            console.error('Failed to open file:', error);
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
            
            if (backupState && backupState.terminals && backupState.terminals.length > 0) {
                Logger.debug('📤 Sending restore command with backup state:', backupState.terminals.length, 'terminals');
                this._view.webview.postMessage({ 
                    command: 'restoreState', 
                    state: backupState 
                });
            } else {
                Logger.debug('📤 No backup state - sending initialize command');
                this._view.webview.postMessage({ 
                    command: 'initializeEmpty'
                });
            }
        } catch (error) {
            Logger.error('❌ Failed to restore webview state:', error);
        }
    }


    public dispose() {
        Logger.debug('⚠️ Disposing ClaudeCodeProvider');
        // Note: State is already saved synchronously by webview, no need for async save here
        this._ptyManager.dispose();
    }

}