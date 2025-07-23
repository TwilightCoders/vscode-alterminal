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

class TerminalInstance {
    constructor(id, label, vscode, terminalTheme, getThemeColor, terminalType = 'claude') {
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
        
        // State management
        this.isActive = false;
        this.hasContent = false;
        
        // DOM container
        this.terminalContainer = null;
        
        // Initialize the complete terminal (frontend + backend)
        this.initialize();
        this.createPtyProcess();
    }
    
    /**
     * Initialize the terminal with all addons and configuration
     */
    initialize() {
        try {
            let XTerminal = null;
            
            console.log('Checking for Terminal constructors...');
            console.log('window.Terminal:', typeof window.Terminal, window.Terminal);
            console.log('globalThis keys with "term":', Object.keys(globalThis).filter(k => k.toLowerCase().includes('term')));
            console.log('All available globals:', Object.getOwnPropertyNames(window).slice(0, 20));
            
            // Check various possible locations
            if (window.Terminal && typeof window.Terminal === 'function') {
                XTerminal = window.Terminal;
                console.log('Found Terminal on window');
            } else if (globalThis.Terminal && typeof globalThis.Terminal === 'function') {
                XTerminal = globalThis.Terminal;
                console.log('Found Terminal on globalThis');
            } else if (self.Terminal && typeof self.Terminal === 'function') {
                XTerminal = self.Terminal;
                console.log('Found Terminal on self');
            } else {
                // Try to find any object that might be the Terminal
                const possibleTerminal = window.Terminal || globalThis.Terminal;
                console.log('Possible Terminal object:', possibleTerminal);
                
                if (possibleTerminal && possibleTerminal.Terminal) {
                    XTerminal = possibleTerminal.Terminal;
                    console.log('Found nested Terminal constructor');
                } else {
                    throw new Error('Terminal constructor not found. window.Terminal type: ' + typeof window.Terminal + ', available globals: ' + Object.keys(window).filter(k => k.toLowerCase().includes('term')).join(', '));
                }
            }
            
            console.log('Using Terminal constructor:', XTerminal);
            
            // Create terminal with proper configuration
            this.terminal = new XTerminal({
                cursorBlink: true,
                fontSize: parseInt(this.getThemeColor('--vscode-editor-font-size', '14').replace('px', '')) || 14,
                fontFamily: this.getThemeColor('--vscode-editor-font-family', 'Consolas, Monaco, Menlo, monospace'),
                theme: this.terminalTheme,
                scrollback: window.scrollbackLines || 1000,
                scrollOnUserInput: false
            });
            
            // Initialize addons
            this.fitAddon = new FitAddon.FitAddon();
            this.serializeAddon = new SerializeAddon.SerializeAddon();
            
            // Configure WebLinksAddon
            this.webLinksAddon = new WebLinksAddon.WebLinksAddon((event, uri) => {
                if (uri.startsWith('/') || uri.match(/^[a-zA-Z]:\\\\/)) {
                    this.vscode.postMessage({ command: 'openFile', filePath: uri });
                    return false;
                }
                if (uri.match(/^https?:\/\//)) {
                    this.vscode.postMessage({ command: 'openUrl', url: uri });
                    return false;
                }
                return true;
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
            this.terminal.loadAddon(this.fitAddon);
            this.terminal.loadAddon(this.serializeAddon);
            this.terminal.loadAddon(this.webLinksAddon);
            
            // Set up event handlers
            this.setupEventHandlers();
            
        } catch (error) {
            console.error(`Failed to initialize terminal ${this.id}:`, error);
        }
    }
    
    /**
     * Set up terminal event handlers with proper disposal management
     */
    setupEventHandlers() {
        // Dispose existing handlers first
        this.disposeEventHandlers();
        
        // Set up data handler - coordinate with PTY backend
        this.dataDisposable = this.terminal.onData((data) => {
            // Send user input to our PTY process
            this.sendDataToPty(data);
            
            // Save to local webview state when user types
            if (window.tabManager && window.tabManager.saveToLocalState) {
                window.tabManager.saveToLocalState();
            }
        });
        
        // Set up resize handler - coordinate with PTY backend
        this.resizeDisposable = this.terminal.onResize((size) => {
            // Notify our PTY process of resize
            this.sendResizeToPty(size.cols, size.rows);
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
            }
            setTimeout(() => {
                if (this.fitAddon && container.offsetWidth > 0 && container.offsetHeight > 0) {
                    this.fitAddon.fit();
                }
            }, 50);
        } catch (error) {
            console.error(`Failed to attach terminal ${this.id} to container:`, error);
        }
    }
    
    /**
     * Write data to the terminal
     */
    write(data) {
        if (!this.terminal) return;
        
        try {
            this.terminal.write(data);
            
            // Mark as having content when data is written
            this.hasContent = true;
            
            // Save to local webview state when PTY sends data
            if (window.tabManager && window.tabManager.saveToLocalState) {
                window.tabManager.saveToLocalState();
            }
        } catch (error) {
            console.error(`Failed to write to terminal ${this.id}:`, error);
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
            console.error(`Failed to focus terminal ${this.id}:`, error);
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
            console.error(`Failed to fit terminal ${this.id}:`, error);
        }
    }
    
    /**
     * Clear the terminal
     */
    clear() {
        if (!this.terminal) return;
        
        try {
            this.terminal.clear();
            // Reset content state when cleared
            this.hasContent = false;
        } catch (error) {
            console.error(`Failed to clear terminal ${this.id}:`, error);
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
            setTimeout(() => {
                this.fit();
                this.focus();
            }, 100);
        }
    }
    
    /**
     * Serialize terminal state for persistence
     */
    serialize() {
        if (!this.serializeAddon) {
            return null;
        }
        
        try {
            return this.serializeAddon.serialize({
                scrollback: window.scrollbackLines || 1000,
                excludeModes: true,
                excludeAltBuffer: true
            });
        } catch (error) {
            console.error(`Failed to serialize terminal ${this.id}:`, error);
            return null;
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
            this.terminal.write(serializedContent);
            window.dispatchEvent(new Event('resize'));
        } catch (error) {
            console.error(`Failed to deserialize terminal ${this.id}:`, error);
        }
    }
    
    /**
     * Get terminal state for persistence
     */
    getState() {
        return {
            id: this.id,
            label: this.label,
            hasContent: true,
            rawContent: this.serialize() || ''
        };
    }
    
    /**
     * Restore terminal from state
     */
    restoreFromState(state) {
        if (!state) return;
        
        this.label = state.label || this.label;
        
        // Restore content if available
        const contentToRestore = state.rawContent || state.serializedContent;
        if (contentToRestore) {
            setTimeout(() => {
                this.deserialize(contentToRestore);
            }, 100);
        }
    }
    
    /**
     * Dispose of event handlers
     */
    disposeEventHandlers() {
        if (this.dataDisposable) {
            this.dataDisposable.dispose();
            this.dataDisposable = null;
        }
        
        if (this.resizeDisposable) {
            this.resizeDisposable.dispose();
            this.resizeDisposable = null;
        }
    }
    
    /**
     * Create PTY process for this terminal
     */
    createPtyProcess() {
        this.vscode.postMessage({ 
            command: 'createPty', 
            tabId: this.id,
            terminalType: this.terminalType
        });
    }
    
    /**
     * Send data to PTY process
     */
    sendDataToPty(data) {
        this.vscode.postMessage({ 
            command: 'data', 
            data: data, 
            tabId: this.id 
        });
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
     * Send file path to PTY process
     */
    sendFilePathToPty(filePath) {
        this.vscode.postMessage({ 
            command: 'sendFilePath', 
            filePath: filePath, 
            tabId: this.id 
        });
    }
    
    /**
     * Send file data to PTY process
     */
    sendFileDataToPty(fileData, fileName, fileType) {
        this.vscode.postMessage({ 
            command: 'sendFileData', 
            fileData: fileData, 
            fileName: fileName, 
            fileType: fileType, 
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
            
            // Clear references
            this.fitAddon = null;
            this.serializeAddon = null;
            this.webLinksAddon = null;
            
        } catch (error) {
            console.error(`Failed to dispose terminal ${this.id}:`, error);
        }
    }
}