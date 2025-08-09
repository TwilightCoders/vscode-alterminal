/**
 * Command Manager
 * 
 * Purpose:
 * - Manage saved/favorite terminal commands for quick re-launching
 * - Provide dynamic menu integration with VS Code command palette
 * - Handle command persistence and usage tracking
 * 
 * Responsibilities:
 * - Store and retrieve saved commands from workspace/user settings
 * - Track command usage frequency and recency
 * - Generate dynamic menu items for quick command access
 * - Provide UI for saving commands from active terminals
 * 
 * Key Features:
 * - Smart labeling of commands (auto-generate or user-defined)
 * - Usage-based sorting (most used + most recent)
 * - Integration with tab save buttons
 * - Clean command deduplication and management
 */

import * as vscode from 'vscode';

interface SavedCommand {
    command: string;
    label: string;
    count: number;
    lastUsed: string;
}

interface VSCodeAPI {
    getConfiguration: (section: string) => vscode.WorkspaceConfiguration;
    window: typeof vscode.window;
    commands: typeof vscode.commands;
}

export class CommandManager {
    private savedCommands: SavedCommand[] = [];

    constructor(
        private vscode: VSCodeAPI,
        private createTab: (command: string) => void
    ) {
        // Load saved commands asynchronously to avoid blocking extension startup
        this.loadSavedCommands().catch(error => {
            console.error('[CommandManager] Failed to initialize:', error);
        });
    }
    
    /**
     * Load saved commands from VS Code settings
     */
    async loadSavedCommands() {
        try {
            // Get from VS Code workspace configuration
            this.savedCommands = this.vscode.getConfiguration('alterminal')
                .get<SavedCommand[]>('savedCommands', []);
            
            console.debug('[CommandManager] Loaded saved commands:', this.savedCommands);
            this.updateDynamicMenus();
        } catch (error) {
            console.error('[CommandManager] Failed to load saved commands:', error);
            this.savedCommands = [];
        }
    }
    
    /**
     * Save commands back to VS Code settings
     */
    async saveSavedCommands() {
        try {
            await this.vscode.getConfiguration('alterminal')
                .update('savedCommands', this.savedCommands, vscode.ConfigurationTarget.Global);
            
            console.debug('[CommandManager] Saved commands updated:', this.savedCommands);
            this.updateDynamicMenus();
        } catch (error) {
            console.error('[CommandManager] Failed to save commands:', error);
        }
    }
    
    /**
     * Add a command to saved commands (or increment usage)
     */
    async saveCommand(command: string, userLabel?: string | null) {
        // Check if command already exists
        const existingIndex = this.savedCommands.findIndex(cmd => cmd.command === command);
        
        if (existingIndex >= 0) {
            // Update existing command
            this.savedCommands[existingIndex].count++;
            this.savedCommands[existingIndex].lastUsed = new Date().toISOString();
            if (userLabel) {
                this.savedCommands[existingIndex].label = userLabel;
            }
        } else {
            // Add new command
            const newCommand: SavedCommand = {
                command,
                label: userLabel || this.generateLabel(command),
                count: 1,
                lastUsed: new Date().toISOString()
            };
            this.savedCommands.push(newCommand);
        }
        
        // Keep only top 10 most used commands
        this.savedCommands.sort((a, b) => b.count - a.count);
        if (this.savedCommands.length > 10) {
            this.savedCommands = this.savedCommands.slice(0, 10);
        }
        
        await this.saveSavedCommands();
        return true;
    }
    
    /**
     * Generate a smart label for a command
     */
    generateLabel(command: string): string {
        // Smart labeling based on common patterns
        const cmd = command.trim();
        
        // Handle common patterns
        if (cmd.startsWith('npm ')) {
            const script = cmd.replace('npm ', '').trim();
            return `NPM: ${script}`;
        }
        if (cmd.startsWith('python ')) {
            const script = cmd.replace('python ', '').replace('-m ', '').trim();
            return `Python: ${script}`;
        }
        if (cmd.startsWith('node ')) {
            const script = cmd.replace('node ', '').trim();
            return `Node: ${script}`;
        }
        if (cmd.includes('server') || cmd.includes('serve')) {
            return 'Server';
        }
        if (cmd.includes('watch') || cmd.includes('dev')) {
            return 'Development';
        }
        if (cmd.includes('test')) {
            return 'Testing';
        }
        if (cmd.includes('build')) {
            return 'Build';
        }
        
        // Default: use first word + "..."
        const firstWord = cmd.split(' ')[0];
        return cmd.length > 20 ? `${firstWord}...` : cmd;
    }
    
    /**
     * Get saved commands sorted by usage and recency
     */
    getSavedCommands(): SavedCommand[] {
        return this.savedCommands.slice().sort((a, b) => {
            // Sort by combination of count and recency
            const aScore = a.count * 10 + (new Date(a.lastUsed).getTime() / 1000000000);
            const bScore = b.count * 10 + (new Date(b.lastUsed).getTime() / 1000000000);
            return bScore - aScore;
        });
    }
    
    /**
     * Launch a saved command
     */
    async launchSavedCommand(command: string) {
        // Update usage stats
        await this.saveCommand(command);
        
        // Create new tab with the command
        if (this.createTab) {
            this.createTab(command);
        }
    }
    
    /**
     * Remove a saved command
     */
    async removeSavedCommand(command: string) {
        this.savedCommands = this.savedCommands.filter(cmd => cmd.command !== command);
        await this.saveSavedCommands();
    }
    
    /**
     * Show dialog to save a new command
     */
    async showSaveCommandDialog() {
        const command = await this.vscode.window.showInputBox({
            prompt: 'Enter the command to save',
            placeHolder: 'e.g., npm run dev, python server.py, etc.',
            validateInput: (value) => {
                return value.trim() ? null : 'Command cannot be empty';
            }
        });
        
        if (command) {
            const label = await this.vscode.window.showInputBox({
                prompt: 'Enter a label for this command (optional)',
                placeHolder: 'Leave empty for auto-generated label'
            });
            
            await this.saveCommand(command.trim(), label?.trim() || null);
            this.vscode.window.showInformationMessage(`Command "${command}" saved successfully!`);
        }
    }

    /**
     * Show quick pick for saved commands
     */
    async showSavedCommandsPicker() {
        const commands = this.getSavedCommands();
        
        if (commands.length === 0) {
            this.vscode.window.showInformationMessage('No saved commands yet. Save commands using the 💾 button on command tabs.');
            return;
        }
        
        const quickPickItems = commands.map(cmd => ({
            label: cmd.label,
            description: cmd.command,
            detail: `Used ${cmd.count} times • ${new Date(cmd.lastUsed).toLocaleDateString()}`,
            command: cmd.command
        }));
        
        const selected = await this.vscode.window.showQuickPick(quickPickItems, {
            placeHolder: 'Select a saved command to launch',
            matchOnDescription: true
        });
        
        if (selected) {
            await this.launchSavedCommand(selected.command);
        }
    }
    
    /**
     * Update dynamic menus (notify VS Code of menu changes)
     */
    updateDynamicMenus() {
        // Set context for showing/hiding the "Launch Saved Command" picker
        this.vscode.commands.executeCommand('setContext', 'alterminal.hasSavedCommands', this.savedCommands.length > 0);
    }
    
}