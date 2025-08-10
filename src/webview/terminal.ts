// @ts-nocheck
import { InputHandler } from './inputHandler.js';
import { TerminalLifecycleManager } from './lifecycleManager.js';
import { FilePathLinkProvider } from './linkProvider.js';
import { AnsiModeProvider } from './modeProvider.js';
import { Logger } from './logger.js';

/**
 * Terminal Class - Unified Frontend + Backend Terminal Instance
 * 
 * Purpose:
 * - Complete terminal instance managing both xterm.js display AND PTY backend
 * - Unified lifecycle - one terminal = one xterm.js + one PTY process
 * - Clean API for all terminal operations without artificial frontend/backend split
 * 
 * Responsibilities:
 * - Create and configure xterm.js terminal with all addons
 * - Coordinate with extension host to create and manage its own PTY process
 * - Handle all terminal events, state, and lifecycle as one cohesive unit
 * - Serialize/deserialize complete terminal state (both display and PTY state)
 * - Clean disposal of both frontend and backend resources
 * 
 * Key Features:
 * - Unified terminal instance (no more TerminalWrapper + PtyManager split)
 * - Self-manages both UI and PTY through extension messaging
 * - Complete lifecycle control from creation to disposal
 * - VS Code theme integration and error handling throughout
 * - Event-driven PTY operations coordinated through vscode messaging
 */

export class TerminalInstance {
    constructor(id, label, vscode, terminalTheme, getThemeColor, terminalType = 'default', options = {}) {
        const { autoStartPty = true, customCommand = null } = options;
        this.launchCommand = customCommand;
        // SUCCESS! Our code is running and hover is working!
        Logger.debug('🚀 TerminalInstance constructor called with id:', id, 'type:', terminalType);
        Logger.debug('🚀 Debug mode check:', localStorage.getItem('alterminal.debug'));
        
    // Respect existing debug mode flag (no forced enable in production)
        
        Logger.debug('🆕 Creating new TerminalInstance with id:', id, 'type:', terminalType);
        this.id = id;
        this.label = label;
        this.vscode = vscode;
        this.terminalTheme = terminalTheme;
        this.getThemeColor = getThemeColor;
        this.terminalType = terminalType;
        
        // Terminal and addons
        this.terminal = null;
        this.fitAddon = null;
        this.serializeAddon = null;
        this.webLinksAddon = null;
        
        // Event handler disposables
        this.dataDisposable = null;
        this.resizeDisposable = null;
        this.bellDisposable = null;
        this.renderDisposable = null;
        
        // State management
        this.isActive = false;
        
        // Tab indicators handled by IndicatorManager
        
        // Terminal mode tracking (bitmask for space efficiency)
        this._terminalModes = 0; // All modes start disabled
        
        // Mode bit positions
        this.MODES = {
            FOCUS_REPORTING: 1 << 0,      // ESC[?1004h/l - bit 0
            MOUSE_CLICK_TRACKING: 1 << 1, // ESC[?1000h/l - bit 1
            MOUSE_DRAG_TRACKING: 1 << 2,  // ESC[?1002h/l - bit 2
            MOUSE_MOTION_TRACKING: 1 << 3, // ESC[?1003h/l - bit 3
            SGR_MOUSE_MODE: 1 << 4,       // ESC[?1006h/l - bit 4
            ALTERNATE_SCREEN: 1 << 5,     // ESC[?1049h/l - bit 5
            BRACKETED_PASTE: 1 << 6       // ESC[?2004h/l - bit 6
        };
    this._lastWriteTs = 0; // timestamp of last data write
    this._pendingStableSnapshot = ''; // cache last stable snapshot
    this._saveDebounceTimer = null; // debounce handle
    // Boot / readiness state to avoid capturing transient init control sequences
    this._booting = true;               // true until we detect a stable prompt
    this._bootReady = false;            // flips when prompt detected & idle
    this._bootIdleTimer = null;         // timer to evaluate readiness after idle
    this._bootLastActivity = Date.now();// last PTY output time during boot
    this._bootSnapshotTaken = false;    // ensure snapshot taken exactly once at readiness
    // Prompt heuristic: common final prompt chars optionally followed by a space; allow color codes before
    this._promptRegex = /(?:\x1b\[[0-9;]*m)*.*([#%$>]) ?$/;
    this._createdAt = Date.now();
    this._inAltScreen = false;        // track application alternate screen (curses, TUIs)
    this._lastNormalScreenSnapshot = ''; // last snapshot taken outside alt-screen
    // Event / promise lifecycle
    this._listeners = new Map();
    this.whenOpened = new Promise(r => { this._openedResolve = r; });
    this.whenBootReady = new Promise(r => { this._bootReadyResolve = r; });
    this._pendingAltExit = false; // alt-screen exit awaiting stabilized render
        
        // DOM container
        this.terminalContainer = null;
        
        // Input handler
        this.inputHandler = null;
        
        
        // Initialize the complete terminal (frontend + backend)
        this.initialize();
        if (autoStartPty) {
            this.createPtyProcess();
        } else {
            this._pendingPtyStart = true; // mark for later start
        }
    }

    // Simple event emitter API
    on(event, handler) { if (!this._listeners.has(event)) this._listeners.set(event, new Set()); this._listeners.get(event).add(handler); return () => this.off(event, handler); }
    off(event, handler) { const set = this._listeners.get(event); if (set) set.delete(handler); }
    _emit(event, payload) { const set = this._listeners.get(event); if (set) for (const fn of Array.from(set)) { try { fn(payload); } catch(_) {} } }
    _markOpened() { if (this._openedResolve) this._openedResolve(); this._emit('opened'); }
    _markBootReady() { if (this._bootReadyResolve) this._bootReadyResolve(); this._emit('bootReady'); }
    
    /**
     * Initialize the terminal with all addons and configuration
     */
    initialize() {
        Logger.debug('🚀 Starting terminal initialization for terminal', this.id);
        try {
            performance.mark(`t${this.id}-init-start`);
            let XTerminal = null;
            
            Logger.debug('🚀 Checking for Terminal constructors...');
            Logger.debug('🚀 window.Terminal:', typeof window.Terminal, window.Terminal);
            Logger.debug('🚀 globalThis keys with "term":', Object.keys(globalThis).filter(k => k.toLowerCase().includes('term')));
            Logger.debug('🚀 All available globals:', Object.getOwnPropertyNames(window).slice(0, 20));
            
            // Check various possible locations
            if (window.Terminal && typeof window.Terminal === 'function') {
                XTerminal = window.Terminal;
                Logger.debug('🚀 Found Terminal on window');
            } else if (globalThis.Terminal && typeof globalThis.Terminal === 'function') {
                XTerminal = globalThis.Terminal;
                Logger.debug('🚀 Found Terminal on globalThis');
            } else if (self.Terminal && typeof self.Terminal === 'function') {
                XTerminal = self.Terminal;
                Logger.debug('🚀 Found Terminal on self');
            } else {
                // Try to find any object that might be the Terminal
                const possibleTerminal = window.Terminal || globalThis.Terminal;
                Logger.debug('🚀 Possible Terminal object:', possibleTerminal);
                
                if (possibleTerminal && possibleTerminal.Terminal) {
                    XTerminal = possibleTerminal.Terminal;
                    Logger.debug('🚀 Found nested Terminal constructor');
                } else {
                    throw new Error('Terminal constructor not found. window.Terminal type: ' + typeof window.Terminal + ', available globals: ' + Object.keys(window).filter(k => k.toLowerCase().includes('term')).join(', '));
                }
            }
            
            Logger.debug('🚀 Using Terminal constructor:', XTerminal);
            
            // Create terminal with proper configuration
            this.terminal = new XTerminal({
                cursorBlink: true,
                fontSize: parseInt(this.getThemeColor('--vscode-editor-font-size', '14').replace('px', '')) || 14,
                fontFamily: this.getThemeColor('--vscode-editor-font-family', 'Consolas, Monaco, Menlo, monospace'),
                theme: this.terminalTheme,
                scrollback: window.scrollbackLines || 1000,
                scrollOnUserInput: true,
                sendFocus: true, // allow focus in/out sequences so ncurses apps can redraw properly
                allowTransparency: false,
                windowsMode: false,
                experimentalCharAtlas: 'dynamic',
                allowProposedApi: true,
                convertEol: true,
                disableStdin: false
            });
            
            // Initialize addons
            this.fitAddon = new FitAddon.FitAddon();
            this.serializeAddon = new SerializeAddon.SerializeAddon();
            this.unicodeAddon = new Unicode11Addon.Unicode11Addon();
            
            
            // Configure WebLinksAddon for web URLs only
            this.webLinksAddon = new WebLinksAddon.WebLinksAddon((event, uri) => {
                Logger.debug(`🔗 WebLinksAddon detected web URL: "${uri}"`);
                this.vscode.postMessage({ command: 'openUrl', url: uri });
                return false; // Prevent default browser opening
            });
            
            // Try WebGL first, fallback to Canvas
            try {
                const webglAddon = new WebglAddon.WebglAddon();
                this.terminal.loadAddon(webglAddon);
            } catch (e) {
                const canvasAddon = new CanvasAddon.CanvasAddon();
                this.terminal.loadAddon(canvasAddon);
            }
            
            // Load addons
            Logger.debug('🚀 Loading addons...');
            this.terminal.loadAddon(this.fitAddon);
            Logger.debug('🚀 Loaded FitAddon');
            this.terminal.loadAddon(this.serializeAddon);
            Logger.debug('🚀 Loaded SerializeAddon');
            this.terminal.loadAddon(this.unicodeAddon);
            Logger.debug('🚀 Loaded UnicodeAddon');
            this.terminal.loadAddon(this.webLinksAddon);
            Logger.debug('🚀 Loaded WebLinksAddon');
            
            // Note: File path link setup moved to after terminal attachment
            
            // (Removed heavy forced debug test injection for performance)
            
            // Set up event handlers
            this.setupEventHandlers();
            
            // Activate Unicode 11 support (based on xterm.js PR #2568)
            if (this.terminal.unicode) {
                this.terminal.unicode.activeVersion = '11';
            } else {
                console.warn('Unicode API not available on terminal');
            }
            
        } catch (error) {
            Logger.error(`Failed to initialize terminal ${this.id}:`, error);
        }
    }
    
    /**
     * Dispose of existing file path link providers
     */
    disposeFilePathLinks() {
        // Dispose link providers
        if (this.linkProviders) {
            this.linkProviders.forEach(({ provider, disposable }) => {
                try {
                    if (disposable && disposable.dispose) {
                        disposable.dispose();
                        Logger.debug('Disposed link provider');
                    }
                } catch (error) {
                    Logger.error('Error disposing link provider:', error);
                }
            });
            this.linkProviders = [];
        }
        
        // Dispose link matchers (fallback)
        if (this.linkMatcherIds && this.terminal && this.terminal.deregisterLinkMatcher) {
            this.linkMatcherIds.forEach(matcherId => {
                try {
                    this.terminal.deregisterLinkMatcher(matcherId);
                    Logger.debug('Deregistered link matcher:', matcherId);
                } catch (error) {
                    Logger.error('Error deregistering link matcher:', error);
                }
            });
            this.linkMatcherIds = [];
        }
    }
    
    /**
     * Set up file path link detection with clean regex patterns
     */
    setupFilePathLinks() {
        Logger.debug('🔗 Setting up file path links (combined) for terminal', this.id);
        if (!this.terminal) return;
        this.disposeFilePathLinks();
        if (typeof this.terminal.registerLinkProvider !== 'function') {
            this.setupFilePathLinksWithMatcher();
            return;
        }
        const COMBINED = /(\b[\.~]?\/[^\s"'`]*(?:\s[^\s"'`]*)*|[a-z0-9_][^\s\/]*\.[a-z0-9]+|[a-zA-Z]:\\[^\s"'`]+)/gi;
        const UNIVERSAL = /[^\s"'`]+/g;
        const provider = {
            provideLinks: (y, callback) => {
                const line = this.terminal.buffer.active.getLine(y - 1);
                if (!line) return callback(undefined);
                const lineText = line.translateToString();
                const isCmd = window.linkModeState && (window.linkModeState.isCmdPressed || window.linkModeState.isCtrlPressed);
                const regex = isCmd ? UNIVERSAL : COMBINED;
                const links = [];
                let match;
                const r = new RegExp(regex.source, regex.flags);
                while ((match = r.exec(lineText)) !== null) {
                    const raw = match[0];
                    const trimmed = raw.trim();
                    if (!trimmed) continue;
                    const leading = raw.match(/^\s*/)[0].length;
                    const startIndex = match.index + leading;
                    // Validation: skip tokens with dangerous shell metachars when not in cmd mode
                    if (!isCmd && /[;&|`]/.test(trimmed)) continue;
                    const underline = isCmd || (window.workspaceFileCache && window.workspaceFileCache.has(trimmed));
                    if (!underline) continue;
                    links.push({
                        range: { start: { x: startIndex + 1, y }, end: { x: startIndex + trimmed.length, y } },
                        text: trimmed,
                        decorations: { underline: true },
                        activate: () => {
                            const cmdPressed = window.linkModeState && (window.linkModeState.isCmdPressed || window.linkModeState.isCtrlPressed);
                            if (!cmdPressed) {
                                this.vscode.postMessage({ command: 'openFile', filePath: trimmed });
                            }
                        },
                        hover: () => {
                            const container = document.getElementById('container');
                            if (isCmd) container?.classList.add('cmd-mode'); else container?.classList.remove('cmd-mode');
                        },
                        leave: () => {
                            document.getElementById('container')?.classList.remove('cmd-mode');
                        }
                    });
                }
                callback(links.length ? links : undefined);
            }
        };
        const disposable = this.terminal.registerLinkProvider(provider);
        this.linkProviders = [disposable];
        Logger.debug('🔗 Combined link provider registered');
    }

    /**
     * Fallback method using registerLinkMatcher (for when registerLinkProvider fails)
     */
    setupFilePathLinksWithMatcher() {
        Logger.debug('Setting up file path links with registerLinkMatcher fallback');
        
        if (!this.terminal) {
            Logger.error('No terminal available');
            return;
        }
        
        if (typeof this.terminal.registerLinkMatcher !== 'function') {
            Logger.error('registerLinkMatcher not available either - no link support');
            return;
        }
        
        try {
            // Simpler, more specific file path patterns
            const patterns = [
                { regex: /\/[a-zA-Z0-9\._\-\/]+\.[a-zA-Z0-9]+/g, type: 'absolute' },  // /path/to/file.ext
                { regex: /\.\/[a-zA-Z0-9\._\-\/]+/g, type: 'relative' },              // ./path/file
                { regex: /\.\.\/[a-zA-Z0-9\._\-\/]+/g, type: 'relative-up' },         // ../path/file
                { regex: /~\/[a-zA-Z0-9\._\-\/]+/g, type: 'home' },                   // ~/path/file
            ];
            
            // Track matcher IDs for cleanup
            if (!this.linkMatcherIds) {
                this.linkMatcherIds = [];
            }
            
            patterns.forEach(pattern => {
                try {
                    Logger.debug(`Registering matcher for ${pattern.type} with regex:`, pattern.regex);
                    
                    const matcherId = this.terminal.registerLinkMatcher(
                        pattern.regex, 
                        (event, uri) => {
                            Logger.debug(`File path link clicked (${pattern.type}): "${uri}"`);
                            this.vscode.postMessage({ command: 'openFile', filePath: uri });
                        },
                        {
                            validationCallback: (uri, callback) => {
                                Logger.debug(`Validating ${pattern.type} path: "${uri}"`);
                                callback(true); // Always validate as true for now
                            },
                            tooltipCallback: (event, uri) => {
                                Logger.debug(`Hovering over ${pattern.type} path: "${uri}"`);
                            },
                            priority: 10
                        }
                    );
                    
                    if (matcherId !== undefined) {
                        Logger.debug(`Successfully registered ${pattern.type} path matcher with ID ${matcherId}`);
                        this.linkMatcherIds.push(matcherId);
                    } else {
                        Logger.warn(`registerLinkMatcher returned undefined for ${pattern.type}`);
                    }
                } catch (matcherError) {
                    Logger.error(`Failed to register ${pattern.type} path matcher:`, matcherError);
                }
            });
            
            Logger.debug(`Registered ${this.linkMatcherIds.length} link matchers`);
            
        } catch (error) {
            Logger.error('Failed to setup file path links with matcher fallback:', error);
        }
    }
    
    /**
     * Set up terminal event handlers with proper disposal management
     */
    setupEventHandlers() {
        // Dispose existing handlers first
        this.disposeEventHandlers();
        
        // Set up input handling (keyboard, file drops, etc.)
        this.inputHandler = new InputHandler(
            this.terminal,
            this.id,
            (msg) => this.vscode.postMessage(msg),
            () => {
                if (window.tabManager && window.tabManager.saveToLocalState) {
                    window.tabManager.saveToLocalState();
                }
            }
        );
        
        // Set up resize handler - coordinate with PTY backend
        this.resizeDisposable = this.terminal.onResize((size) => {
            // Notify our PTY process of resize
            this.sendResizeToPty(size.cols, size.rows);
        });
        
        // Set up bell handler - listen for terminal bell events
        this.bellDisposable = this.terminal.onBell(() => {
            const timestamp = new Date().toISOString();
            // Only show indicator if tab is not currently active
            if (!this.isActive) {
                // Show bell notification on inactive tabs
                if (this.onBellReceived) {
                    this.onBellReceived(this.id);
                }
            }
        });
    }
    
    /**
     * Create and attach terminal to DOM container
     */
    attachToContainer(container) {
        if (!this.terminal || !container) return;
        
        try {
            this.terminalContainer = container;
            // Only open if terminal is not already opened
            if (!this.terminal.element) {
                this.terminal.open(container);
                performance.mark(`t${this.id}-open`);
                
                // Set up file path links immediately after opening
                // The terminal is now attached to DOM and ready for link providers
                Logger.debug('🔗 Setting up file path links after terminal.open()');
                this.setupFilePathLinks();

                // Visibility-aware fitting & refresh
                this._installVisibilityHandlers();

                // Kick off multi-pass stabilization redraw (addresses blank-on-move)
                this._scheduleRedrawSequence();
                
                // Also listen for terminal render events to ensure links work if content changes
                if (typeof this.terminal.onRender === 'function') {
                    this.renderDisposable = this.terminal.onRender(() => {
                        // First render -> opened
                        this._markOpened();
                        // Handle deferred alt-screen exit snapshot after a clean render
                        if (this._pendingAltExit && !this._inAltScreen) {
                            this._pendingAltExit = false;
                            try { this.serialize(); if (window.tabManager) window.tabManager.saveToLocalState(); } catch(_) {}
                            this._emit('altScreenExit');
                        }
                    });
                    Logger.debug('🔗 Set up onRender listener');
                }
            }
            
            // Fit the terminal to container
            if (this.fitAddon && container.offsetWidth > 0 && container.offsetHeight > 0) this.fitAddon.fit();
            // Fallback ensure opened event if render never fires soon
            requestAnimationFrame(() => this._markOpened());
        } catch (error) {
            Logger.error(`Failed to attach terminal ${this.id} to container:`, error);
        }
    }
    
    /**
     * Set a terminal mode bit
     */
    setMode(bit, enabled) {
        if (enabled) {
            this._terminalModes |= bit; // Set bit
        } else {
            this._terminalModes &= ~bit; // Clear bit
        }
    }
    
    /**
     * Check if a terminal mode is enabled
     */
    hasMode(bit) {
        return (this._terminalModes & bit) !== 0;
    }
    
    /**
     * Parse and track terminal modes from escape sequences
     */
    parseAndTrackModes(data) {
        // Match terminal mode sequences: ESC[?<number><h|l>
        const modeRegex = /\x1b\[\?(\d+)([hl])/g;
        let match;
        
        while ((match = modeRegex.exec(data)) !== null) {
            const modeNumber = match[1];
            const action = match[2]; // 'h' = enable, 'l' = disable
            const enable = action === 'h';
            
            switch (modeNumber) {
                case '1004': // Focus reporting
                    this.setMode(this.MODES.FOCUS_REPORTING, enable);
                    Logger.debug(`Terminal ${this.id}: Focus reporting ${enable ? 'enabled' : 'disabled'}`);
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
                    break;
                case '2004': // Bracketed paste
                    this.setMode(this.MODES.BRACKETED_PASTE, enable);
                    break;
                default:
                    // Unknown mode, log for future handling
                    Logger.debug(`Terminal ${this.id}: Unknown terminal mode: ${modeNumber}${action}`);
            }
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
     * Restore terminal modes after deserializing content
     */
    /**
     * Write mode sequences directly to xterm without processing
     */
    _writeModeDirect(sequence) {
        // Write directly to xterm.js without going through our write() method
        // This prevents mode sequences from being parsed/displayed during restoration
        if (this.terminal && this.terminal.write) {
            this.terminal.write(sequence);
        }
    }
    
    restoreTerminalModes() {
        if (!this.terminal) return;
        
        try {
            // Restore each tracked mode that was enabled directly
            if (this.hasMode(this.MODES.FOCUS_REPORTING)) {
                Logger.debug(`Terminal ${this.id}: Restoring focus reporting mode`);
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
        } catch (error) {
            Logger.error(`Failed to restore terminal modes for ${this.id}:`, error);
        }
    }
    
    /**
     * Write data to the terminal
     */
    write(data) {
        if (!this.terminal) return;
        try {
            // 1. Parse and track terminal modes for state management
            this.parseAndTrackModes(data);
            
            // 2. Detect alt-screen enter/leave sequences in outbound PTY data (output side)
            // Enter: CSI ? 1049 h (and sometimes 47/1047 h)
            // Leave: CSI ? 1049 l (and 47/1047 l)
            if (/\x1b\[\?1049h|\x1b\[\?47h|\x1b\[\?1047h/.test(data)) {
                this._inAltScreen = true;
                if (this._pendingStableSnapshot) this._lastNormalScreenSnapshot = this._pendingStableSnapshot;
            }
            if (/\x1b\[\?1049l|\x1b\[\?47l|\x1b\[\?1047l/.test(data)) {
                this._inAltScreen = false;
                this._pendingAltExit = true; // handled at next render
            }
            
            // 3. Write original data to terminal (let xterm.js handle modes properly)
            this.terminal.write(data);
            this._lastWriteTs = Date.now();
            
            
            if (this._booting) {
                this._bootLastActivity = Date.now();
                this._scheduleBootReadinessCheck();
            } else {
                this._scheduleDebouncedSave();
            }
        } catch (error) {
            Logger.error(`Failed to write to terminal ${this.id}:`, error);
        }
    }
    
    /**
     * Focus the terminal
     */
    focus() {
        if (!this.terminal) return;
        
        try {
            this.terminal.focus();
        } catch (error) {
            Logger.error(`Failed to focus terminal ${this.id}:`, error);
        }
    }
    
    /**
     * Fit the terminal to its container
     */
    fit() {
        if (!this.fitAddon) return;
        
        try {
            this.fitAddon.fit();
        } catch (error) {
            Logger.error(`Failed to fit terminal ${this.id}:`, error);
        }
    }
    
    /**
     * Clear the terminal
     */
    clear() {
        if (!this.terminal) return;
        
        try {
            this.terminal.clear();
            // Terminal cleared
        } catch (error) {
            Logger.error(`Failed to clear terminal ${this.id}:`, error);
        }
    }
    
    /**
     * Set active/inactive state
     */
    setActive(active) {
        this.isActive = active;
        if (this.terminalContainer) {
            this.terminalContainer.style.display = active ? 'block' : 'none';
        }
        
        if (active) {
            // Clear all indicators when tab becomes active
            
            queueMicrotask(() => {
                if (this.terminal) {
                    // this.terminal.refresh(0, this.terminal.rows - 1);
                }
                requestAnimationFrame(() => {
                    this.fit();
                    this.focus();
                    try {
                        performance.mark(`t${this.id}-active`);
                        if (window.tabManager && window.tabManager._recordTerminalTiming) {
                            window.tabManager._recordTerminalTiming(this.id);
                        }
                    } catch (e) {}
                    // Additional staged redraws to combat late layout thrash
                    this._scheduleRedrawSequence();
                });
            });
        }
    }
    

    
    
    /**
     * Serialize terminal state for persistence
     */
    serialize() {
        if (!this.serializeAddon) return null;
        try {
            if (this._booting && !this._bootReady) {
                // Suppress early snapshots; return last stable snapshot (may be empty)
                return this._pendingStableSnapshot || null;
            }
            // If in alternate screen, don't capture transient full-screen UI; return last normal snapshot
            if (this._inAltScreen) {
                return this._lastNormalScreenSnapshot || this._pendingStableSnapshot || null;
            }
            const now = Date.now();
            // If we wrote very recently, reuse last stable snapshot to avoid partial escape capture
            if (now - this._lastWriteTs < 120 && this._pendingStableSnapshot) {
                return this._pendingStableSnapshot;
            }
            const serialized = this.serializeAddon.serialize({
                scrollback: window.scrollbackLines || 1000,
                excludeModes: false,
                excludeAltBuffer: true
            });
            // Gating: skip updating snapshot if ending incomplete escape
            if (/\x1b$/.test(serialized) || /\x1b\[[0-9;?]*$/.test(serialized)) {
                Logger.debug(`Skip snapshot t${this.id}: trailing incomplete escape`);
                return this._pendingStableSnapshot || null;
            }
            
            // Strip terminal mode sequences for clean storage (but keep content)
            const cleanSerialized = this.stripModeSequences(serialized);
            
            const lines = cleanSerialized ? cleanSerialized.split('\n').length : 0;
            const lastLine = cleanSerialized ? cleanSerialized.split('\n').slice(-2)[0] : 'none';
            Logger.debug(`Serialized terminal ${this.id}: ${lines} lines, last line: "${lastLine}"`);
            this._pendingStableSnapshot = cleanSerialized;
            this._lastNormalScreenSnapshot = cleanSerialized; // update last normal snapshot
            return cleanSerialized;
        } catch (error) {
            Logger.error(`Failed to serialize terminal ${this.id}:`, error);
            return this._pendingStableSnapshot || null;
        }
    }

    _scheduleDebouncedSave() {
        if (this._saveDebounceTimer) {
            clearTimeout(this._saveDebounceTimer);
        }
        this._saveDebounceTimer = setTimeout(() => {
            if (window.tabManager && window.tabManager.saveToLocalState) {
                window.tabManager.saveToLocalState();
            }
        }, 750);
    }

    _scheduleBootReadinessCheck() {
        if (this._bootIdleTimer) {
            clearTimeout(this._bootIdleTimer);
        }
        // Wait 500ms idle after last activity to evaluate readiness
        this._bootIdleTimer = setTimeout(() => {
            try {
                const buffer = this.terminal.buffer?.active;
                if (!buffer) return;
                const line = buffer.getLine(buffer.cursorY);
                const text = line ? line.translateToString().trimEnd() : '';
                // Heuristic: prompt line ends with common prompt char + space and cursor at line end
                const cursorAtEnd = buffer.cursorX === (line ? line.translateToString().length : 0);
                const elapsed = Date.now() - this._createdAt;
                const promptMatch = this._promptRegex.test(text) && cursorAtEnd;
                const timeoutFallback = elapsed > 4000; // 4s fallback to avoid indefinite suppression
                if (promptMatch || timeoutFallback) {
                    this._bootReady = true;
                    this._booting = false;
                    this._markBootReady();
                    if (!this._bootSnapshotTaken) {
                        // Take initial stable snapshot & persist
                        this._bootSnapshotTaken = true;
                        if (window.tabManager && window.tabManager.saveToLocalState) {
                            window.tabManager.saveToLocalState();
                        }
                        // Also refresh stable snapshot immediately
                        try { this.serialize(); } catch (_) {}
                    }
                } else {
                    // Not ready; reschedule (still within boot window)
                    this._scheduleBootReadinessCheck();
                }
            } catch (e) {
                console.error('Boot readiness check failed:', e);
            }
        }, 500);
    }
    
    /**
     * Restore terminal content from serialized state
     */
    deserialize(serializedContent) {
        if (!this.terminal || !serializedContent) {
            return;
        }
        
        try {
            // Debug: Log deserialization info
            const lines = serializedContent.split('\n').length;
            const lastLine = serializedContent.split('\n').slice(-2)[0]; // -2 because last is usually empty
            Logger.debug(`Deserializing terminal ${this.id}: ${lines} lines, last line: "${lastLine}"`);
            
            // Write content (don't trigger state save during restoration)
            this.terminal.write(serializedContent);
            
            // Restore terminal modes after content with slight delay to ensure terminal is ready
            setTimeout(() => {
                this.restoreTerminalModes();
            }, 100);
            
            window.dispatchEvent(new Event('resize'));
            // Establish baseline snapshot so early saves can preserve history even if boot gating suppresses live serialization
            try {
                this._pendingStableSnapshot = serializedContent;
            } catch (_) {}
        } catch (error) {
            Logger.error(`Failed to deserialize terminal ${this.id}:`, error);
        }
    }
    
    /**
     * Get terminal state for persistence
     */
    getState() {
        return {
            id: this.id,
            label: this.label,
            // Only serialize content for default terminals - launch command terminals start fresh
            rawContent: this.launchCommand ? '' : (this.serialize() || ''),
            terminalModes: this._terminalModes, // Include terminal modes bitmask
            launchCommand: this.launchCommand
        };
    }
    
    /**
     * Restore terminal from state
     */
    restoreFromState(state) {
        if (!state) return;
        
        this.label = state.label || this.label;
        
        // Restore terminal modes bitmask
        this._terminalModes = state.terminalModes || 0;
        
        // Restore launch command and derive terminal type
        this.launchCommand = state.launchCommand || state.customCommand || this.launchCommand; // Support old customCommand for migration
        this.terminalType = this.launchCommand ? 'command' : 'default';
        
        // For terminals with launch commands, start fresh instead of restoring old content
        if (this.launchCommand) {
            Logger.debug(`Terminal ${this.id}: Relaunching with command "${this.launchCommand}" instead of restoring content`);
            // PTY will be created with the launch command when terminal opens
        } else {
            // For default terminals, restore the saved content
            const contentToRestore = state.rawContent || state.serializedContent;
            if (contentToRestore) this.deserialize(contentToRestore);
        }
    }
    
    /**
     * Dispose of event handlers
     */
    disposeEventHandlers() {
        // Dispose input handler
        if (this.inputHandler) {
            this.inputHandler.dispose();
            this.inputHandler = null;
        }
        
        if (this.dataDisposable) {
            this.dataDisposable.dispose();
            this.dataDisposable = null;
        }
        
        if (this.resizeDisposable) {
            this.resizeDisposable.dispose();
            this.resizeDisposable = null;
        }
        
        if (this.bellDisposable) {
            this.bellDisposable.dispose();
            this.bellDisposable = null;
        }
        
        if (this.renderDisposable) {
            this.renderDisposable.dispose();
            this.renderDisposable = null;
        }
        
        // Dispose link providers
        if (this.linkProviders) {
            this.linkProviders.forEach(({ provider, disposable }) => {
                try {
                    if (disposable && disposable.dispose) {
                        disposable.dispose();
                        Logger.debug('Disposed link provider');
                    }
                } catch (error) {
                    Logger.error('Error disposing link provider:', error);
                }
            });
            this.linkProviders = [];
        }
        
        // Dispose link matchers (fallback)
        if (this.linkMatcherIds && this.terminal && this.terminal.deregisterLinkMatcher) {
            this.linkMatcherIds.forEach(matcherId => {
                try {
                    this.terminal.deregisterLinkMatcher(matcherId);
                    Logger.debug(`Deregistered link matcher ${matcherId}`);
                } catch (error) {
                    Logger.error(`Error deregistering link matcher ${matcherId}:`, error);
                }
            });
            this.linkMatcherIds = [];
        }
    }
    
    /**
     * Create PTY process for this terminal
     */
    createPtyProcess() {
        this.vscode.postMessage({ 
            command: 'createPty', 
            tabId: this.id,
            terminalType: this.terminalType,
            customCommand: this.launchCommand
        });
    }

    startDeferredPtyIfNeeded() {
        if (this._pendingPtyStart) {
            this._pendingPtyStart = false;
            this.createPtyProcess();
        }
    }
    
    /**
     * Send resize to PTY process
     */
    sendResizeToPty(cols, rows) {
        this.vscode.postMessage({ 
            command: 'resize', 
            cols: cols, 
            rows: rows, 
            tabId: this.id 
        });
    }
    
    /**
     * Dispose PTY process
     */
    disposePtyProcess() {
        this.vscode.postMessage({ 
            command: 'disposePty', 
            tabId: this.id 
        });
    }
    
    /**
     * Dispose of all resources (both frontend and backend)
     */
    dispose() {
        try {
            // Dispose PTY process first
            this.disposePtyProcess();
            
            // Dispose event handlers
            this.disposeEventHandlers();
            
            // Dispose terminal
            if (this.terminal) {
                this.terminal.dispose();
                this.terminal = null;
            }
            
            // Remove container
            if (this.terminalContainer && this.terminalContainer.parentNode) {
                this.terminalContainer.parentNode.removeChild(this.terminalContainer);
                this.terminalContainer = null;
            }
            
            // Clear all indicators
            
            // Clear references
            this.fitAddon = null;
            this.serializeAddon = null;
            this.webLinksAddon = null;
            
        } catch (error) {
            Logger.error(`Failed to dispose terminal ${this.id}:`, error);
        }
    }

    _installVisibilityHandlers() {
        if (this._visibilityInstalled) return;
        this._visibilityInstalled = true;
        const container = document.getElementById('container');
        if (container && 'ResizeObserver' in window) {
            const ro = new ResizeObserver(() => {
                if (this.isActive) {
                    this.fit();
                    // If width/height just became non-zero, force redraw sequence
                    if (this.terminalContainer && this.terminalContainer.offsetWidth > 0 && this.terminalContainer.offsetHeight > 0) {
                        this._scheduleRedrawSequence();
                    }
                }
            });
            ro.observe(container);
            this._resizeObserver = ro;
        }
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && this.isActive) {
                requestAnimationFrame(() => {
                    if (this.terminal) {
                        // this.terminal.refresh(0, this.terminal.rows - 1);
                        this.fit();
                        this._scheduleRedrawSequence();
                    }
                });
            }
        });
        // WebGL context loss fallback
        const attachWebglHandlers = () => {
            const cvs = this.terminalContainer?.querySelectorAll('canvas') || [];
            if (!cvs.length) return false;
            cvs.forEach(cv => {
                cv.addEventListener('webglcontextlost', (e) => {
                    e.preventDefault();
                    Logger.warn('WebGL context lost – falling back to canvas');
                    try {
                        const canvasAddon = new CanvasAddon.CanvasAddon();
                        this.terminal.loadAddon(canvasAddon);
                        this.fit();
                        this._scheduleRedrawSequence();
                    } catch (err) { Logger.error('Failed canvas fallback:', err); }
                }, { passive: false });
            });
            return true;
        };
        // Try now, else poll a few animation frames
        if (!attachWebglHandlers()) {
            let attempts = 0;
            const poll = () => {
                if (attachWebglHandlers()) return;
                if (++attempts < 10) requestAnimationFrame(poll);
            };
            requestAnimationFrame(poll);
        }

        // Mutation observer to detect panel moves or DOM reparenting
        try {
            const observer = new MutationObserver(() => {
                if (!this.isActive) return;
                if (!this.terminalContainer) return;
                if (this.terminalContainer.offsetWidth === 0 || this.terminalContainer.offsetHeight === 0) return;
                // Trigger opportunistic redraw
                this._scheduleRedrawSequence();
            });
            observer.observe(document.body, { attributes: true, childList: true, subtree: true });
            this._mutationObserver = observer;
        } catch (e) {
            Logger.debug('MutationObserver unavailable:', e);
        }
    }

    _scheduleRedrawSequence() { this._runStabilizedRedraw(); }

    _runStabilizedRedraw() {
        if (!this.terminal || this._stabilizing) return;
        this._stabilizing = true;
        let stable = 0, attempts = 0, lastW = -1, lastH = -1;
        const step = () => {
            if (!this.terminal || !this.isActive) { this._stabilizing = false; return; }
            const w = this.terminalContainer?.offsetWidth || 0;
            const h = this.terminalContainer?.offsetHeight || 0;
            // try { this.terminal.refresh(0, this.terminal.rows - 1); this.fit(); } catch(_) {}
            if (w === lastW && h === lastH) stable++; else { stable = 0; lastW = w; lastH = h; }
            attempts++;
            if (stable >= 2 || attempts >= 10) { this._stabilizing = false; return; }
            requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }
}
