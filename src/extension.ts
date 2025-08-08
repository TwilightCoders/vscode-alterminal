import * as vscode from 'vscode';
import { ClaudeCodeProvider } from './claudeCodeProvider';
import { PtyManager } from './terminal/ptyManager';
import { Logger } from './utils/logger';

export function activate(context: vscode.ExtensionContext) {
    
    Logger.info('🚀 Claude Pilot extension is now active!');
    
    // Check if we're in debug/development mode
    const isDebugMode = process.env.NODE_ENV === 'development' || 
                       context.extensionMode === vscode.ExtensionMode.Development;
    
    
    // Set debug mode context for conditional UI
    vscode.commands.executeCommand('setContext', 'claudePilot.debugMode', isDebugMode);
    
    // Force the view container to be visible
    vscode.commands.executeCommand('setContext', 'claudePilotContainer:visible', true);
    
    // Create shared PtyManager - will be used by ClaudeCodeProvider
    const ptyManager = new PtyManager();
    
    const provider = new ClaudeCodeProvider(context.extensionUri, context, ptyManager);
    
    Logger.debug('🔌 Registering WebviewViewProvider...');
    const disposable = vscode.window.registerWebviewViewProvider(ClaudeCodeProvider.viewType, provider);
    Logger.debug('✅ WebviewViewProvider registered');
    
    context.subscriptions.push(disposable);
    
    // Create status bar item
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    statusBarItem.text = "$(robot) Claude";
    statusBarItem.tooltip = "Open Claude Pilot";
    statusBarItem.command = 'claudePilot.openTerminal';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    statusBarItem.show();
    
    context.subscriptions.push(
        statusBarItem,
        vscode.commands.registerCommand('claudePilot.refresh', () => {
            provider.refresh();
        }),
        vscode.commands.registerCommand('claudePilot.clearWorkspaceState', async () => {
            await context.workspaceState.update('claudePilot.webviewState', undefined);
            vscode.window.showInformationMessage('Claude Pilot workspace state cleared');
        }),
        vscode.commands.registerCommand('claudePilot.newTab', () => {
            provider.createNewTab();
        }),
        vscode.commands.registerCommand('claudePilot.newTerminal.claude', () => {
            provider.createNewTab('claude');
        }),
        vscode.commands.registerCommand('claudePilot.newTerminal.shell', () => {
            provider.createNewTab('shell');
        }),
        vscode.commands.registerCommand('claudePilot.newTerminal.continue', () => {
            provider.createNewTab('continue');
        }),
        vscode.commands.registerCommand('claudePilot.openTerminal', async () => {
            await provider.openTerminal();
        }),
        vscode.commands.registerCommand('claudePilot.focus', () => {
            vscode.commands.executeCommand('workbench.view.extension.claudePilotContainer');
        }),
        vscode.commands.registerCommand('claudePilot.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'claudePilot');
        }),
        vscode.commands.registerCommand('claudePilot.debugState', async () => {
            const savedState = context.workspaceState.get('claudePilot.webviewState');
            const message = savedState 
                ? `Saved workspace state: ${JSON.stringify(savedState, null, 2)}`
                : 'No saved workspace state found';
            vscode.window.showInformationMessage('Debug State', { modal: true, detail: message });
        }),
        vscode.commands.registerCommand('claudePilot.testLinks', () => {
            provider.testLinks();
        }),
        vscode.commands.registerCommand('claudePilot.setDebugFilter', async () => {
            const filterOptions = [
                { label: '📁 Files Only', description: 'Show only file cache logs', value: ['📁'] },
                { label: '🔗 Links Only', description: 'Show only link detection logs', value: ['🔗'] },
                { label: '⚡ Terminal Only', description: 'Show only terminal event logs', value: ['⚡'] },
                { label: '🚀 Initialization Only', description: 'Show only startup logs', value: ['🚀'] },
                { label: '📁 🔗 Files + Links', description: 'Show file and link logs', value: ['📁', '🔗'] },
                { label: '🔧 Troubleshoot Mode', description: 'Show force debug logs only', value: ['🔧'] },
                { label: 'Clear Filter', description: 'Show all debug logs', value: null }
            ];
            
            const selected = await vscode.window.showQuickPick(filterOptions, {
                placeHolder: 'Select debug filter',
                matchOnDescription: true
            });
            
            if (selected) {
                provider.setDebugFilter(selected.value);
                const filterText = selected.value ? selected.value.join(' ') : 'cleared';
                vscode.window.showInformationMessage(`Debug filter ${filterText}`);
            }
        }),
        vscode.commands.registerCommand('claudePilot.clearDebugFilter', () => {
            provider.setDebugFilter(null);
            vscode.window.showInformationMessage('Debug filter cleared - showing all logs');
        }),
        vscode.commands.registerCommand('claudePilot.performanceReport', async () => {
            await provider.requestPerformanceReport();
        })
    );
}

export function deactivate() {
    Logger.info('🛑 Claude Pilot extension is being deactivated');
    Logger.debug('🧹 Cleanup complete');
}
