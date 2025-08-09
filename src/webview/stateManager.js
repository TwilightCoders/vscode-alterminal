/**
 * State Manager
 * 
 * Purpose:
 * - Handle all terminal state serialization and deserialization
 * - Manage terminal snapshots and state persistence
 * - Clean separation between state logic and terminal display
 * 
 * Responsibilities:
 * - Serialize terminal content for persistence
 * - Deserialize and restore terminal state
 * - Handle state snapshots and debounced saves
 * - Manage launch command vs content restoration logic
 * - Coordinate with mode tracking for complete state
 * 
 * Key Features:
 * - Smart content vs launch command restoration
 * - Debounced state saving for performance
 * - Clean state interfaces for serialization
 * - Integration with terminal modes and indicators
 */

// Logger for webview context
const Logger = {
    debug: (...args) => console.debug('[StateManager]', ...args),
    error: (...args) => console.error('[StateManager]', ...args)
};

export class StateManager {
    constructor(terminalId, terminal, serializeAddon, modeTracker, indicatorManager, saveCallback) {
        this.terminalId = terminalId;
        this.terminal = terminal;
        this.serializeAddon = serializeAddon;
        this.modeTracker = modeTracker;
        this.indicatorManager = indicatorManager;
        this.saveCallback = saveCallback;
        
        // State management
        this._pendingStableSnapshot = null;
        this._lastNormalScreenSnapshot = '';
        this._saveDebounceTimer = null;
        
        // Terminal properties that need to be persisted
        this.label = '';
        this.launchCommand = null;
    }
    
    /**
     * Serialize terminal content for persistence
     */
    serialize() {
        if (!this.serializeAddon) return null;
        
        try {
            const serialized = this.serializeAddon.serialize({
                scrollback: this.terminal.scrollback || 1000
            });
            
            if (!serialized) return null;
            
            // Skip serialization if we detect incomplete escape sequences
            if (/\x1b$/.test(serialized) || /\x1b\[[0-9;?]*$/.test(serialized)) {
                Logger.debug(`Skip snapshot t${this.terminalId}: trailing incomplete escape`);
                return this._pendingStableSnapshot || null;
            }
            
            // Strip terminal mode sequences for clean storage (but keep content)
            const cleanSerialized = this.stripModeSequences(serialized);
            
            const lines = cleanSerialized ? cleanSerialized.split('\n').length : 0;
            const lastLine = cleanSerialized ? cleanSerialized.split('\n').slice(-2)[0] : 'none';
            Logger.debug(`Serialized terminal ${this.terminalId}: ${lines} lines, last line: "${lastLine}"`);
            
            this._pendingStableSnapshot = cleanSerialized;
            this._lastNormalScreenSnapshot = cleanSerialized; // update last normal snapshot
            return cleanSerialized;
        } catch (error) {
            Logger.error(`Failed to serialize terminal ${this.terminalId}:`, error);
            return this._pendingStableSnapshot || null;
        }
    }
    
    /**
     * Strip terminal mode sequences from data (for clean storage)
     */
    stripModeSequences(data) {
        // Remove the mode sequences we're tracking separately
        return data.replace(/\x1b\[\?(1004|1000|1002|1003|1006|1049|2004)[hl]/g, '');
    }
    
    /**
     * Deserialize and restore terminal content
     */
    deserialize(serializedContent) {
        if (!this.terminal || !serializedContent) {
            return;
        }
        
        try {
            // Debug: Log deserialization info
            const lines = serializedContent.split('\n').length;
            const lastLine = serializedContent.split('\n').slice(-2)[0]; // -2 because last is usually empty
            Logger.debug(`Deserializing terminal ${this.terminalId}: ${lines} lines, last line: "${lastLine}"`);
            
            // Write content (don't trigger state save during restoration)
            this.terminal.write(serializedContent);
            
            // Restore terminal modes after content with slight delay to ensure terminal is ready
            setTimeout(() => {
                this.modeTracker.restoreTerminalModes();
            }, 100);
            
            window.dispatchEvent(new Event('resize'));
            // Establish baseline snapshot so early saves can preserve history even if boot gating suppresses live serialization
            try {
                this._pendingStableSnapshot = serializedContent;
            } catch (_) {}
        } catch (error) {
            Logger.error(`Failed to deserialize terminal ${this.terminalId}:`, error);
        }
    }
    
    /**
     * Get complete terminal state for persistence
     */
    getState() {
        return {
            id: this.terminalId,
            label: this.label,
            // Only serialize content for default terminals - launch command terminals start fresh
            rawContent: this.launchCommand ? '' : (this.serialize() || ''),
            terminalModes: this.modeTracker.getModes(), // Include terminal modes bitmask
            launchCommand: this.launchCommand,
            indicators: this.indicatorManager.getState().indicators
        };
    }
    
    /**
     * Restore terminal from complete state
     */
    restoreFromState(state) {
        if (!state) return;
        
        this.label = state.label || this.label;
        
        // Restore terminal modes bitmask
        this.modeTracker.restoreModes(state.terminalModes || 0);
        
        // Restore indicators
        if (this.indicatorManager) {
            this.indicatorManager.restoreState({ indicators: state.indicators || 0 });
        }
        
        // Restore launch command and derive terminal type
        this.launchCommand = state.launchCommand || state.customCommand || this.launchCommand; // Support old customCommand for migration
        
        // For terminals with launch commands, start fresh instead of restoring old content
        if (this.launchCommand) {
            Logger.debug(`Terminal ${this.terminalId}: Relaunching with command "${this.launchCommand}" instead of restoring content`);
            // PTY will be created with the launch command when terminal opens
        } else {
            // For default terminals, restore the saved content
            const contentToRestore = state.rawContent || state.serializedContent;
            if (contentToRestore) this.deserialize(contentToRestore);
        }
    }
    
    /**
     * Schedule a debounced save operation
     */
    scheduleDebouncedSave() {
        if (this._saveDebounceTimer) {
            clearTimeout(this._saveDebounceTimer);
        }
        this._saveDebounceTimer = setTimeout(() => {
            if (this.saveCallback) {
                this.saveCallback();
            }
        }, 750);
    }
    
    /**
     * Update snapshots for alt-screen handling
     */
    updateNormalScreenSnapshot() {
        if (this._pendingStableSnapshot) {
            this._lastNormalScreenSnapshot = this._pendingStableSnapshot;
        }
    }
    
    /**
     * Get last normal screen snapshot
     */
    getLastNormalScreenSnapshot() {
        return this._lastNormalScreenSnapshot;
    }
    
    /**
     * Clear snapshots and timers
     */
    dispose() {
        if (this._saveDebounceTimer) {
            clearTimeout(this._saveDebounceTimer);
            this._saveDebounceTimer = null;
        }
        this._pendingStableSnapshot = null;
        this._lastNormalScreenSnapshot = '';
    }
}