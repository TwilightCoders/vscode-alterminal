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
        const { autoStartPty = true, launchCommand = null } = options;
        this.launchCommand = launchCommand;
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
        
        // Providers for separation of concerns
        this.lifecycleManager = new TerminalLifecycleManager(this, vscode, id);
        this.linkProvider = new FilePathLinkProvider(this, vscode, id);
        this.modeProvider = new AnsiModeProvider(this, vscode, id);
        
        // Legacy state management (will be refactored out)
        this._lastWriteTs = 0; // timestamp of last data write
        this._pendingStableSnapshot = ''; // cache last stable snapshot
        this._createdAt = Date.now();
        
        // Debounce timers for various operations
        this._debounceTimers = new Map();
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
        // One-time creation inspection log (shallow properties + direct reference)
        try {
            const shallow = {} as any;
            Object.keys(this).forEach(k => {
                if (typeof (this as any)[k] !== 'function') {
                    // Avoid huge nested objects
                    const val = (this as any)[k];
                    if (val && typeof val === 'object' && (k === 'terminal' || k.endsWith('Addon'))) return; // skip heavy objects
                    shallow[k] = val;
                }
            });
            console.log('TerminalInstance created', { id: this.id, label: this.label, type: this.terminalType, shallow, instance: this });
        } catch (_) {}
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
     * Reusable debounce utility for any operation
     * @param key - Unique key to identify the debounced operation
     * @param delay - Delay in milliseconds
     * @param callback - Function to call after delay
     */
    debounce(key, delay, callback) {
        // Clear any existing timer for this key
        if (this._debounceTimers.has(key)) {
            clearTimeout(this._debounceTimers.get(key));
        }
        
        // Set new timer
        const timer = setTimeout(() => {
            this._debounceTimers.delete(key);
            callback();
        }, delay);
        
        this._debounceTimers.set(key, timer);
    }
    
    /**
     * Initialize the terminal with all addons and configuration
     */
    initialize() {
    Logger.debug('Starting terminal initialization for terminal', this.id);
        try {
            performance.mark(`t${this.id}-init-start`);
            let XTerminal = null;
            
            Logger.debug('Locating Terminal constructors...');
            
            // Check various possible locations
            if (window.Terminal && typeof window.Terminal === 'function') {
                XTerminal = window.Terminal;
                Logger.debug('Found Terminal on window');
            } else if (globalThis.Terminal && typeof globalThis.Terminal === 'function') {
                XTerminal = globalThis.Terminal;
                Logger.debug('Found Terminal on globalThis');
            } else if (self.Terminal && typeof self.Terminal === 'function') {
                XTerminal = self.Terminal;
                Logger.debug('Found Terminal on self');
            } else {
                // Try to find any object that might be the Terminal
                const possibleTerminal = window.Terminal || globalThis.Terminal;
                Logger.debug('Possible Terminal object candidate');
                
                if (possibleTerminal && possibleTerminal.Terminal) {
                    XTerminal = possibleTerminal.Terminal;
                    Logger.debug('Found nested Terminal constructor');
                } else {
                    throw new Error('Terminal constructor not found. window.Terminal type: ' + typeof window.Terminal + ', available globals: ' + Object.keys(window).filter(k => k.toLowerCase().includes('term')).join(', '));
                }
            }
            
            Logger.debug('Using Terminal constructor');
            
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
            Logger.debug('Loading addons');
            this.terminal.loadAddon(this.fitAddon);
            Logger.debug('Loaded FitAddon');
            this.terminal.loadAddon(this.serializeAddon);
            Logger.debug('Loaded SerializeAddon');
            this.terminal.loadAddon(this.unicodeAddon);
            Logger.debug('Loaded UnicodeAddon');
            this.terminal.loadAddon(this.webLinksAddon);
            Logger.debug('Loaded WebLinksAddon');
            
            // Note: File path link setup moved to after terminal attachment
            
            // (Removed heavy forced debug test injection for performance)
            
            // Set up event handlers
            this.setupEventHandlers();
            
            // Initialize providers
            // Listen to lifecycle events BEFORE calling initialize to avoid missing early bootReady
            this.lifecycleManager.on('bootReady', () => {
                this._markBootReady();
                // Take initial stable snapshot when ready
                if (window.tabManager && window.tabManager.saveToLocalState) {
                    window.tabManager.saveToLocalState();
                }
                try { this.serialize(); } catch (_) {}
            });
            this.lifecycleManager.initialize();
            this.linkProvider.initialize();
            this.modeProvider.initialize();
            
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
     * Dispose of existing file path link providers (delegated to linkProvider)
     */
    disposeFilePathLinks() {
        this.linkProvider.dispose();
    }
    
    /**
     * Set up file path link detection (delegated to linkProvider)
     */
    setupFilePathLinks() {
        this.linkProvider.setupFilePathLinks();
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
        
        // Set up buffer change detection using onData event
        if (typeof this.terminal.onData === 'function') {
            this.dataDisposable = this.terminal.onData(() => {
                // Debounce buffer saves to avoid excessive saving during rapid terminal output
                this.debounce('bufferSave', 750, () => {
                    if (window.tabManager?.saveToLocalState) {
                        window.tabManager.saveToLocalState();
                    }
                });
            });
        }
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
                        if (this._pendingAltExit && !this.modeProvider.hasMode(this.modeProvider.MODES.ALTERNATE_SCREEN)) {
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
     * Set a terminal mode bit (delegated to modeProvider)
     */
    setMode(bit, enabled) {
        this.modeProvider.setMode(bit, enabled);
    }
    
    /**
     * Check if a terminal mode is enabled (delegated to modeProvider)
     */
    hasMode(bit) {
        return this.modeProvider.hasMode(bit);
    }
    
    /**
     * Parse and track terminal modes from escape sequences (delegated to modeProvider)
     */
    parseAndTrackModes(data) {
        this.modeProvider.parseAndTrackModes(data);
    }
    
    /**
     * Strip terminal mode sequences from data (delegated to modeProvider)
     */
    stripModeSequences(data) {
        return this.modeProvider.stripModeSequences(data);
    }
    
    /**
     * Restore terminal modes after deserializing content (delegated to modeProvider)
     */
    restoreTerminalModes() {
        this.modeProvider.restoreModes();
    }
    
    /**
     * Write data to the terminal
     */
    write(data) {
        if (!this.terminal) return;
        try {
            // 1. Parse and track terminal modes for state management
            this.parseAndTrackModes(data);
            
            // 2. Detect alt-screen enter/leave sequences - use modeProvider
            const wasInAltScreen = this.modeProvider.hasMode(this.modeProvider.MODES.ALTERNATE_SCREEN);
            if (/\x1b\[\?1049h|\x1b\[\?47h|\x1b\[\?1047h/.test(data)) {
                if (!wasInAltScreen && this._pendingStableSnapshot) {
                    this._lastNormalScreenSnapshot = this._pendingStableSnapshot;
                }
            }
            if (/\x1b\[\?1049l|\x1b\[\?47l|\x1b\[\?1047l/.test(data)) {
                this._pendingAltExit = true; // handled at next render
            }
            
            // 3. Strip mode sequences and write clean data to terminal for display
            const cleanData = this.stripModeSequences(data);
            this.terminal.write(cleanData);
            this._lastWriteTs = Date.now();
            
            
            
            // Lifecycle manager is now ready immediately - no boot detection needed
            // Buffer change events will handle state saving automatically
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
            
            // Clear our cached snapshots since terminal is now empty
            this._pendingStableSnapshot = '';
            this._lastNormalScreenSnapshot = '';
            
            // Trigger immediate state save to persist the cleared state
            this.serialize();
            if (window.tabManager && window.tabManager.saveToLocalState) {
                window.tabManager.saveToLocalState();
            }
            
            Logger.debug(`Terminal ${this.id} cleared and state saved`);
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
            if (!this.lifecycleManager.isReady) {
                return this._pendingStableSnapshot || null;
            }
            // Avoid capturing transient full-screen apps
            if (this.modeProvider.hasMode(this.modeProvider.MODES.ALTERNATE_SCREEN)) {
                return this._lastNormalScreenSnapshot || this._pendingStableSnapshot || null;
            }
            // Rate-limit immediate re-snapshots after writes
            const now = Date.now();
            if (now - this._lastWriteTs < 120 && this._pendingStableSnapshot) {
                return this._pendingStableSnapshot;
            }
            const serialized = this.serializeAddon.serialize({
                scrollback: window.scrollbackLines || 1000,
                excludeModes: false,
                excludeAltBuffer: true
            });
            // Guard against incomplete escape sequence at end
            if (/\x1b$/.test(serialized) || /\x1b\[[0-9;?]*$/.test(serialized)) {
                Logger.debug(`Skip snapshot t${this.id}: trailing incomplete escape`);
                return this._pendingStableSnapshot || null;
            }
            const cleanSerialized = this.stripModeSequences(serialized);
            const lines = cleanSerialized ? cleanSerialized.split('\n').length : 0;
            const lastLine = cleanSerialized ? cleanSerialized.split('\n').slice(-2)[0] : 'none';
            Logger.debug(`Serialized terminal ${this.id}: ${lines} lines, length: ${cleanSerialized?.length || 0}, last line: "${lastLine}"`);
            this._pendingStableSnapshot = cleanSerialized;
            this._lastNormalScreenSnapshot = cleanSerialized;
            return cleanSerialized;
        } catch (error) {
            Logger.error(`Failed to serialize terminal ${this.id}:`, error);
            return this._pendingStableSnapshot || null;
        }
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
            
            // Strip any lingering mode sequences from stored content before restoring
            const cleanContent = this.stripModeSequences(serializedContent);
            
            // Write clean content (don't trigger state save during restoration)
            this.terminal.write(cleanContent);
            
            // Restore terminal modes after content with slight delay to ensure terminal is ready
            setTimeout(() => {
                this.restoreTerminalModes();
            }, 100);
            
            window.dispatchEvent(new Event('resize'));
            // Establish baseline snapshot with clean content
            try {
                this._pendingStableSnapshot = cleanContent;
            } catch (_) {}
        } catch (error) {
            Logger.error(`Failed to deserialize terminal ${this.id}:`, error);
        }
    }
    
    /**
     * Get terminal state for persistence
     */
    getState() {
        const serializedContent = this.command ? '' : (this.serialize() || '');
        Logger.debug(`🔍 Terminal ${this.id} getState():`, {
            id: this.id,
            label: this.label,
            hascommand: !!this.command,
            serializedLength: serializedContent.length,
            serializedPreview: serializedContent.substring(0, 100) + '...',
            modes: this.modeProvider.getState()
        });
        return {
            id: this.id,
            label: this.label,
            // Only serialize content for default terminals - launch command terminals start fresh
            buffer: this.launchCommand ? '' : (this.serialize() || ''), // Only serialize content for default terminals - launch command terminals start fresh
            modes: this.modeProvider.getState(), // Include terminal modes bitmask
            launchCommand: this.launchCommand
        };
    }
    
    /**
     * Restore terminal from state
     */
    restoreFromState(state) {
        if (!state) return;
        
        this.label = state.label || this.label;
        
        // Restore terminal modes through modeProvider  
        this.modeProvider.restoreState(state.modes || state.terminalModes || 0); // Support both new and old property names
        
        // Restore launch command and derive terminal type
        this.launchCommand = state.launchCommand || this.launchCommand;
        this.terminalType = this.launchCommand ? 'command' : 'default';
        
        if (this.launchCommand) {
            Logger.debug(`Terminal ${this.id}: Relaunching with command "${this.launchCommand}" instead of restoring content`);
        } else {
            const contentToRestore = state.buffer;
            if (contentToRestore) this.deserialize(contentToRestore);
        }
    }

    disposeEventHandler(handler) {
        if (handler) {
            handler.dispose();
            return null;
        }
        return handler;
    }
    
    /**
     * Dispose of event handlers
     */
    disposeEventHandlers() {
        // Dispose all event handler disposables
        this.inputHandler = this.disposeEventHandler(this.inputHandler);
        this.dataDisposable = this.disposeEventHandler(this.dataDisposable);
        this.resizeDisposable = this.disposeEventHandler(this.resizeDisposable);
        this.bellDisposable = this.disposeEventHandler(this.bellDisposable);
        this.renderDisposable = this.disposeEventHandler(this.renderDisposable);
        
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
            customCommand: this.command
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
            
            // Dispose providers
            this.lifecycleManager.dispose();
            this.linkProvider.dispose(); 
            this.modeProvider.dispose();
            
            // Dispose event handlers
            this.disposeEventHandlers();
            
            // Clear all debounce timers
            this._debounceTimers.forEach(timer => clearTimeout(timer));
            this._debounceTimers.clear();
            
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
