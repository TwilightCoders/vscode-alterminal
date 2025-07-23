import * as vscode from 'vscode';
import { PtyManager } from './terminal/ptyManager';
import { TemplateUtils } from './utils/templateUtils';
import { WebviewViewSerializer, PersistedState } from './serialization/webviewViewSerializer';
import { Logger } from './utils/logger';

export class ClaudeCodeProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'claudePilotView';
    private static _instance?: ClaudeCodeProvider;
    private _view?: vscode.WebviewView;
    private _ptyManager: PtyManager;
    private _terminalInitialized = false;
    private _context: vscode.ExtensionContext;
    private _serializer: WebviewViewSerializer;

    constructor(private readonly _extensionUri: vscode.Uri, context: vscode.ExtensionContext, ptyManager: PtyManager) {
        ClaudeCodeProvider._instance = this;
        this._context = context;
        this._serializer = new WebviewViewSerializer(context);
        this._ptyManager = ptyManager;
    }

    public static getInstance(): ClaudeCodeProvider | undefined {
        return ClaudeCodeProvider._instance;
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
        this._serializer.setWebviewView(webviewView);
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

        // Monitor webview visibility changes for state management
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.restoreWebviewState();
            } else {
                this.saveWebviewState();
            }
        });
        
        // Monitor disposal
        webviewView.onDidDispose(() => {
            // WebviewView disposed - cleanup event
        });

        // Set up message router with component delegation
        this.setupMessageRouter(webviewView);
    }

    /**
     * Set up message router with clean handler delegation
     */
    private setupMessageRouter(webviewView: vscode.WebviewView) {
        const messageHandlers = {
            createPty: (msg: any) => this._ptyManager?.createPtyProcess(msg.tabId, msg.terminalType),
            disposePty: (msg: any) => this._ptyManager?.disposePtyProcess(msg.tabId),
            data: (msg: any) => this._ptyManager?.writeToPty(msg.data, msg.tabId),
            resize: (msg: any) => this._ptyManager?.resizePty(msg.cols, msg.rows, msg.tabId),
            sendFilePath: (msg: any) => this._ptyManager?.sendFilePath(msg.filePath, msg.tabId),
            sendFileData: (msg: any) => this._ptyManager?.sendFileData(msg.fileData, msg.fileName, msg.fileType, msg.tabId),
            newTab: (msg: any) => this._ptyManager?.createPtyProcess(msg.tabId),
            closeTab: (msg: any) => this._ptyManager?.disposePtyProcess(msg.tabId),
            fileDrop: (msg: any) => this._handleDroppedFile(msg.fileName, msg.fileType, msg.fileSize, msg.fileData, msg.tabId),
            openFile: (msg: any) => this._handleOpenFile(msg.filePath),
            openUrl: (msg: any) => this._handleOpenUrl(msg.url),
            stateResponse: (msg: any) => this._handleStateResponse(msg.state),
            stateUpdate: (msg: any) => this._handleStateResponse(msg.state),
            webviewReady: () => this.restoreWebviewState(),
            switchTab: () => {}, // No-op - handled in webview
        };

        webviewView.webview.onDidReceiveMessage(
            message => {
                try {
                    const handler = messageHandlers[message.command as keyof typeof messageHandlers];
                    handler ? handler(message) : Logger.warn(`Unhandled message command: ${message.command}`);
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

    private async saveWebviewState() {
        if (!this._view) return;
        
        try {
            // Request current state from the webview
            this._view.webview.postMessage({ command: 'requestState' });
        } catch (error) {
            Logger.error('❌ Failed to save webview state:', error);
        }
    }
    
    private async restoreWebviewState() {
        if (!this._view) return;
        
        try {
            // Get saved state from extension context
            let savedState = this._context.workspaceState.get('claudePilot.webviewState') as any;
            
            // Always send restoration command - if no state, webview will manufacture default
            this._view.webview.postMessage({ 
                command: 'restoreState', 
                state: savedState || null
            });
        } catch (error) {
            Logger.error('❌ Failed to restore webview state:', error);
        }
    }

    private async _handleStateResponse(state: any) {
        try {
            // Create persisted state structure
            const persistedState = {
                terminals: state.terminals || [],
                activeTabId: state.activeTabId || 1,
                timestamp: Date.now()
            };
            
            // Save to extension context
            await this._context.workspaceState.update('claudePilot.webviewState', persistedState);
            
        } catch (error) {
            Logger.error('❌ Failed to handle state response:', error);
        }
    }

    public dispose() {
        // Save state on disposal
        this._serializer.saveState();
        this._ptyManager.dispose();
    }

}