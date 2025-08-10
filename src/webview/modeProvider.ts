// @ts-nocheck
import { IModeProvider } from './interfaces.js';
import { Logger } from './logger.js';

/**
 * Terminal Mode Provider
 * 
 * Purpose:
 * - Track and manage terminal modes (focus, mouse, alternate screen, etc.)
 * - Parse ANSI escape sequences for mode changes
 * - Provide efficient bitmask-based mode storage
 * - Handle mode restoration and cleanup
 * 
 * Responsibilities:
 * - Parse ESC[?<number><h|l> mode sequences
 * - Maintain mode state using efficient bitmasks
 * - Strip mode sequences from data for clean storage
 * - Restore terminal modes after state restoration
 * - Provide mode query interface
 * 
 * Key Features:
 * - Efficient bitmask storage for multiple modes
 * - Comprehensive ANSI mode sequence parsing
 * - Mode restoration for state persistence
 * - Clean data stripping for serialization
 * - Direct mode writing for restoration
 */

export class AnsiModeProvider implements IModeProvider {
    private terminal: any; // xterm.js terminal instance
    private vscode: any;
    private terminalId: string;
    
    // Mode state (bitmask for space efficiency)
    private _terminalModes = 0;
    
    // Mode bit positions - readonly for interface compliance
    public readonly MODES = {
        FOCUS_REPORTING: 1 << 0,      // ESC[?1004h/l - bit 0
        MOUSE_CLICK_TRACKING: 1 << 1, // ESC[?1000h/l - bit 1
        MOUSE_DRAG_TRACKING: 1 << 2,  // ESC[?1002h/l - bit 2
        MOUSE_MOTION_TRACKING: 1 << 3, // ESC[?1003h/l - bit 3
        SGR_MOUSE_MODE: 1 << 4,       // ESC[?1006h/l - bit 4
        ALTERNATE_SCREEN: 1 << 5,     // ESC[?1049h/l - bit 5
        BRACKETED_PASTE: 1 << 6       // ESC[?2004h/l - bit 6
    } as const;
    
    // Mode sequence regex for parsing
    private readonly MODE_REGEX = /\x1b\[\?(\d+)([hl])/g;
    
    constructor(terminal: any, vscode: any, terminalId: string) {
        this.terminal = terminal;
        this.vscode = vscode;
        this.terminalId = terminalId;
    }
    
    // IModeProvider interface
    initialize(): void {
        Logger.debug(`🎛️ ModeProvider initialized for terminal ${this.terminalId}`);
        // No special initialization needed - ready to parse modes
    }
    
    dispose(): void {
        // Reset all modes
        this._terminalModes = 0;
        Logger.debug(`🎛️ ModeProvider disposed for terminal ${this.terminalId}`);
    }
    
    setMode(bit: number, enabled: boolean): void {
        if (enabled) {
            this._terminalModes |= bit; // Set bit
        } else {
            this._terminalModes &= ~bit; // Clear bit
        }
        
        Logger.debug(`🎛️ Terminal ${this.terminalId}: Mode ${bit} ${enabled ? 'enabled' : 'disabled'}`);
    }
    
    hasMode(bit: number): boolean {
        return (this._terminalModes & bit) !== 0;
    }
    
    parseAndTrackModes(data: string): void {
        // Match terminal mode sequences: ESC[?<number><h|l>
        const modeRegex = new RegExp(this.MODE_REGEX.source, 'g'); // Fresh regex instance
        let match;
        
        while ((match = modeRegex.exec(data)) !== null) {
            const modeNumber = match[1];
            const enable = match[2] === 'h'; // 'h' = enable, 'l' = disable
            
            switch (modeNumber) {
                case '1004': // Focus reporting
                    this.setMode(this.MODES.FOCUS_REPORTING, enable);
                    Logger.debug(`Terminal ${this.terminalId}: Focus reporting ${enable ? 'enabled' : 'disabled'}`);
                    break;
                case '1000': // Mouse click tracking  
                    this.setMode(this.MODES.MOUSE_CLICK_TRACKING, enable);
                    break;
                case '1002': // Mouse drag tracking
                    this.setMode(this.MODES.MOUSE_DRAG_TRACKING, enable);
                    break;
                case '1003': // Mouse motion tracking
                    this.setMode(this.MODES.MOUSE_MOTION_TRACKING, enable);
                    break;
                case '1006': // SGR mouse mode
                    this.setMode(this.MODES.SGR_MOUSE_MODE, enable);
                    break;
                case '1049': // Alternate screen
                    this.setMode(this.MODES.ALTERNATE_SCREEN, enable);
                    Logger.debug(`Terminal ${this.terminalId}: Alternate screen ${enable ? 'entered' : 'exited'}`);
                    break;
                case '2004': // Bracketed paste
                    this.setMode(this.MODES.BRACKETED_PASTE, enable);
                    break;
                default:
                    // Unknown mode, log for future handling
                    Logger.debug(`Terminal ${this.terminalId}: Unknown mode ${modeNumber} ${enable ? 'enabled' : 'disabled'}`);
                    break;
            }
        }
    }
    
    stripModeSequences(data: string): string {
        // Remove the mode sequences we're tracking separately
        return data.replace(/\x1b\[\?(1004|1000|1002|1003|1006|1049|2004)[hl]/g, '');
    }
    
    // Mode restoration methods
    restoreModes(): void {
        if (!this.terminal || typeof this.terminal.write !== 'function') {
            Logger.warn(`Cannot restore modes: terminal not available for ${this.terminalId}`);
            return;
        }
        
        try {
            // Restore each tracked mode that was enabled
            if (this.hasMode(this.MODES.FOCUS_REPORTING)) {
                Logger.debug(`Terminal ${this.terminalId}: Restoring focus reporting mode`);
                this._writeModeDirect('\x1b[?1004h');
            }
            if (this.hasMode(this.MODES.MOUSE_CLICK_TRACKING)) {
                this._writeModeDirect('\x1b[?1000h');
            }
            if (this.hasMode(this.MODES.MOUSE_DRAG_TRACKING)) {
                this._writeModeDirect('\x1b[?1002h');
            }
            if (this.hasMode(this.MODES.MOUSE_MOTION_TRACKING)) {
                this._writeModeDirect('\x1b[?1003h');
            }
            if (this.hasMode(this.MODES.SGR_MOUSE_MODE)) {
                this._writeModeDirect('\x1b[?1006h');
            }
            if (this.hasMode(this.MODES.ALTERNATE_SCREEN)) {
                this._writeModeDirect('\x1b[?1049h');
            }
            if (this.hasMode(this.MODES.BRACKETED_PASTE)) {
                this._writeModeDirect('\x1b[?2004h');
            }
            
            Logger.debug(`🎛️ Modes restored for terminal ${this.terminalId}`);
            
        } catch (error) {
            Logger.error(`Failed to restore terminal modes for ${this.terminalId}:`, error);
        }
    }
    
    // State management
    getState(): number {
        return this._terminalModes;
    }
    
    restoreState(modes: number): void {
        this._terminalModes = modes || 0;
        Logger.debug(`🎛️ Mode state restored for terminal ${this.terminalId}: ${modes}`);
    }
    
    // Utility methods
    getAllActiveModes(): string[] {
        const activeModes: string[] = [];
        
        Object.entries(this.MODES).forEach(([name, bit]) => {
            if (this.hasMode(bit)) {
                activeModes.push(name);
            }
        });
        
        return activeModes;
    }
    
    // Private methods
    private _writeModeDirect(sequence: string): void {
        // Write directly to xterm.js without going through normal processing
        // This prevents mode sequences from being parsed/displayed during restoration
        if (this.terminal && this.terminal.write) {
            try {
                this.terminal.write(sequence);
            } catch (error) {
                Logger.warn(`Failed to write mode sequence ${sequence}:`, error);
            }
        }
    }
}