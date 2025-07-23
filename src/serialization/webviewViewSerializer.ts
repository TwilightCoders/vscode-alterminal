/**
 * WebviewViewSerializer
 * 
 * Handles all serialization and deserialization logic for the Claude Pilot WebviewView.
 * Since WebviewView doesn't have built-in serialization support like WebviewPanel,
 * this class provides comprehensive state management for terminal sessions.
 * 
 * Responsibilities:
 * - Serialize/deserialize entire TabManager state
 * - Manage extension storage for persistent state
 * - Handle individual terminal content serialization
 * - Restore terminal sessions and their content
 */

import * as vscode from 'vscode';

export interface SerializedTerminal {
    id: number;
    label: string;
    rawContent: string;
    hasContent: boolean;
    terminalType?: string;
}

export interface PersistedState {
    terminals: SerializedTerminal[];
    activeTabId: number;
    timestamp: number;
}

export class WebviewViewSerializer {
    private static readonly STORAGE_KEY = 'claudePilot.webviewState';
    private _webviewView?: vscode.WebviewView;
    private _context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
    }

    public setWebviewView(webviewView: vscode.WebviewView) {
        this._webviewView = webviewView;
        this.setupWebviewLifecycle();
    }

    /**
     * Set up webview lifecycle event handlers
     */
    private setupWebviewLifecycle() {
        if (!this._webviewView) {
            console.log('⚠️ No webview available for state restoration');
            return;
        }
        // Monitor visibility changes
        console.log('⚠️ Setting up WebviewLifecycle');
        this._webviewView.onDidChangeVisibility(() => {
            console.log('👁️ Webview visibility changed:', this._webviewView?.visible ? 'VISIBLE' : 'HIDDEN');
            if (this._webviewView?.visible) {
                // Send initialization commands when webview becomes visible
                this.sendInitializationCommands();
            } else {
                this.saveState();
            }
        });
        
        // Monitor disposal
        this._webviewView.onDidDispose(() => {
            console.log('🗑️ Webview disposed - saving final state');
            this.saveState();
        });
    }

    /**
     * Send initialization commands to webview based on saved state
     */
    private sendInitializationCommands(): void {
        if (!this._webviewView) return;

        const savedState = this.loadFromExtensionStorage(this._context);
        
        if (savedState && savedState.terminals && savedState.terminals.length > 0) {
            console.log('📤 Sending restore commands for', savedState.terminals.length, 'terminals');
            this._webviewView.webview.postMessage({ 
                command: 'restoreState', 
                state: savedState 
            });
        } else {
            console.log('📤 No saved state - sending command to create default terminal');
            this._webviewView.webview.postMessage({ 
                command: 'initializeEmpty'
            });
        }
    }

    /**
     * Request state from webview and save it
     */
    public async saveState(): Promise<void> {
        if (!this._webviewView) {
            console.log('⚠️ No webview available for state request');
            return;
        }
        
        console.log('💾 Requesting state from webview for saving...');
        this._webviewView.webview.postMessage({ command: 'requestState' });
    }

    /**
     * Handle messages intended for the serializer
     */
    public async handleMessage(message: any): Promise<void> {
        switch (message.command) {
            case 'stateResponse':
            case 'stateUpdate':
                await this.handleStateResponse(message.state);
                break;
        }
    }

    /**
     * Handle state response from webview and save it
     */
    public async handleStateResponse(state: any): Promise<void> {
        if (!state) {
            console.log('⚠️ No state received from webview');
            return;
        }
        
        console.log('💾 Received state for saving:', state ? `${state.terminals?.length} terminals` : 'no state');
        await this.saveToExtensionStorage(this._context, state);
    }

    /**
     * Load state and send it to webview for restoration
     */
    public sendSavedStateToWebview(): void {
        if (!this._webviewView) {
            console.log('⚠️ No webview available for state restoration');
            return;
        }

        const savedState = this.loadFromExtensionStorage(this._context);
        
        if (savedState && savedState.terminals && savedState.terminals.length > 0) {
            console.log('📤 Sending saved state to webview:', savedState.terminals.length, 'terminals');
            this._webviewView.webview.postMessage({ 
                command: 'restoreState', 
                state: savedState 
            });
        } else {
            console.log('📤 No saved state found, webview will use empty state');
            this._webviewView.webview.postMessage({ 
                command: 'initializeEmpty'
            });
        }
    }

    /**
     * Serialize the current state from TabManager
     */
    public serialize(tabManager: any): PersistedState {
        const terminals: SerializedTerminal[] = [];
        
        for (const [id, terminal] of tabManager.terminals) {
            terminals.push(this.serializeTerminalContent(terminal));
        }
        
        return {
            terminals,
            activeTabId: tabManager.activeTabId,
            timestamp: Date.now()
        };
    }

    /**
     * Deserialize state back to TabManager (to be implemented in webview context)
     * This method signature is provided for completeness, but the actual deserialization
     * logic will be handled by the TabManager itself using the restored state data.
     */
    public deserialize(state: PersistedState, tabManager: any): void {
        // This method is primarily for interface completeness
        // The actual restoration logic will be handled in the webview context
        // by TabManager using the state data passed through the template
        console.log('WebviewViewSerializer.deserialize called with state:', state);
    }

    /**
     * Save state to VS Code's extension storage
     */
    public async saveToExtensionStorage(context: vscode.ExtensionContext, state: PersistedState): Promise<void> {
        try {
            await context.workspaceState.update(WebviewViewSerializer.STORAGE_KEY, state);
            console.log('💾 Saved workspace state with', state.terminals.length, 'terminals');
        } catch (error) {
            console.error('🚫 Failed to save state to extension storage:', error);
        }
    }

    /**
     * Load state from VS Code's extension storage
     */
    public loadFromExtensionStorage(context: vscode.ExtensionContext): PersistedState | null {
        try {
            const state = context.workspaceState.get<PersistedState>(WebviewViewSerializer.STORAGE_KEY) || null;
            console.log('🔄 Loaded workspace state:', state ? `${state.terminals.length} terminals` : 'no saved state');
            return state;
        } catch (error) {
            console.error('🚫 Failed to load state from extension storage:', error);
            return null;
        }
    }

    /**
     * Serialize individual terminal content and metadata
     */
    private serializeTerminalContent(terminal: any): SerializedTerminal {
        return {
            id: terminal.id,
            label: terminal.label,
            rawContent: terminal.serialize() || '',
            hasContent: terminal.hasContent || false,
            terminalType: terminal.terminalType || 'claude'
        };
    }

    /**
     * Deserialize and restore individual terminal content
     */
    private deserializeTerminalContent(data: SerializedTerminal, terminal: any): void {
        terminal.label = data.label;
        terminal.terminalType = data.terminalType || 'claude';
        
        // Restore content if available
        if (data.rawContent) {
            setTimeout(() => {
                terminal.deserialize(data.rawContent);
            }, 100);
        }
    }
}