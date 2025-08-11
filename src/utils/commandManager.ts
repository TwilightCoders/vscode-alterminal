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
    launchCommand: string;        // canonical launch command text
    label: string;                // user label or generated
    usageCount: number;           // times actually launched (not times saved)
    lastUsed: string;             // ISO timestamp of last launch
    firstSaved: string;           // ISO timestamp when initially saved
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
            const raw = this.vscode.getConfiguration('alterminal')
                .get<any[]>('savedCommands', []);

            // Migration: legacy entries may use { command, count } instead of { launchCommand, usageCount }
            this.savedCommands = raw.map((entry) => {
                if (!entry) return null;
                const migrated: SavedCommand = {
                    launchCommand: entry.launchCommand || entry.command || '',
                    label: entry.label || (entry.command || entry.launchCommand || 'Unnamed'),
                    usageCount: typeof entry.usageCount === 'number' ? entry.usageCount : (typeof entry.count === 'number' ? entry.count : 0),
                    lastUsed: entry.lastUsed || new Date().toISOString(),
                    firstSaved: entry.firstSaved || entry.lastUsed || new Date().toISOString()
                };
                return migrated.launchCommand ? migrated : null;
            }).filter(Boolean) as SavedCommand[];

            console.debug('[CommandManager] Loaded & migrated saved commands:', this.savedCommands);
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
            // Persist only new schema fields
            await this.vscode.getConfiguration('alterminal')
                .update('savedCommands', this.savedCommands.map(c => ({
                    launchCommand: c.launchCommand,
                    label: c.label,
                    usageCount: c.usageCount,
                    lastUsed: c.lastUsed,
                    firstSaved: c.firstSaved
                })), vscode.ConfigurationTarget.Global);
            
            console.debug('[CommandManager] Saved commands updated:', this.savedCommands);
            this.updateDynamicMenus();
        } catch (error) {
            console.error('[CommandManager] Failed to save commands:', error);
        }
    }
    
    /**
     * Add a command to saved commands (or increment usage)
     */
    async saveCommand(launchCommand: string, userLabel?: string | null) {
        const existing = this.savedCommands.find(c => c.launchCommand === launchCommand);
        if (existing) {
            if (userLabel) existing.label = userLabel; // label update only
            // Do NOT increment usage here; usage increments only when launched
        } else {
            this.savedCommands.push({
                launchCommand,
                label: userLabel || this.generateLabel(launchCommand),
                usageCount: 0,
                lastUsed: new Date().toISOString(),
                firstSaved: new Date().toISOString()
            });
        }
        // Limit: keep newest additions if overflow (>25 for flexibility)
        if (this.savedCommands.length > 25) {
            // Remove lowest usageCount / oldest firstSaved
            this.savedCommands.sort((a,b) => a.usageCount - b.usageCount || new Date(a.firstSaved).getTime() - new Date(b.firstSaved).getTime());
            this.savedCommands = this.savedCommands.slice(-25);
        }
        await this.saveSavedCommands();
        return true;
    }

    private _recordUsage(launchCommand: string) {
        const existing = this.savedCommands.find(c => c.launchCommand === launchCommand);
        if (existing) {
            existing.usageCount += 1;
            existing.lastUsed = new Date().toISOString();
        }
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
            // Weighted score: usageCount primary, recency secondary
            const aScore = a.usageCount * 1000000000000 + new Date(a.lastUsed).getTime();
            const bScore = b.usageCount * 1000000000000 + new Date(b.lastUsed).getTime();
            return bScore - aScore;
        });
    }
    
    /**
     * Launch a saved command
     */
    async launchSavedCommand(launchCommand: string) {
        this._recordUsage(launchCommand);
        await this.saveSavedCommands();
        if (this.createTab) {
            this.createTab(launchCommand);
        }
    }
    
    /**
     * Remove a saved command
     */
    async removeSavedCommand(launchCommand: string) {
        this.savedCommands = this.savedCommands.filter(cmd => cmd.launchCommand !== launchCommand);
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
            description: cmd.launchCommand,
            detail: `Used ${cmd.usageCount} times • Last ${new Date(cmd.lastUsed).toLocaleDateString()}`,
            launchCommand: cmd.launchCommand
        }));
        
        const selected = await this.vscode.window.showQuickPick(quickPickItems, {
            placeHolder: 'Select a saved command to launch',
            matchOnDescription: true
        });
        
        if (selected) {
            await this.launchSavedCommand(selected.launchCommand);
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
