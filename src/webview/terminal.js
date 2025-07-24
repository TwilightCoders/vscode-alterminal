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
        // SUCCESS! Our code is running and hover is working!
        console.log('🔧 FORCE LOG: TerminalInstance constructor called with id:', id, 'type:', terminalType);
        console.log('🔧 Debug mode check:', localStorage.getItem('claudePilot.debug'));
        
        // Temporarily force debug mode for testing
        if (!localStorage.getItem('claudePilot.debug')) {
            localStorage.setItem('claudePilot.debug', 'true');
            console.log('🔧 FORCE ENABLED debug mode');
        }
        
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
        this.hasBellIndicator = false;
        
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
        Logger.debug('🚀 Starting terminal initialization for terminal', this.id);
        try {
            let XTerminal = null;
            
            Logger.debug('Checking for Terminal constructors...');
            Logger.debug('window.Terminal:', typeof window.Terminal, window.Terminal);
            Logger.debug('globalThis keys with "term":', Object.keys(globalThis).filter(k => k.toLowerCase().includes('term')));
            Logger.debug('All available globals:', Object.getOwnPropertyNames(window).slice(0, 20));
            
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
                Logger.debug('Possible Terminal object:', possibleTerminal);
                
                if (possibleTerminal && possibleTerminal.Terminal) {
                    XTerminal = possibleTerminal.Terminal;
                    Logger.debug('Found nested Terminal constructor');
                } else {
                    throw new Error('Terminal constructor not found. window.Terminal type: ' + typeof window.Terminal + ', available globals: ' + Object.keys(window).filter(k => k.toLowerCase().includes('term')).join(', '));
                }
            }
            
            Logger.debug('Using Terminal constructor:', XTerminal);
            
            // Create terminal with proper configuration
            this.terminal = new XTerminal({
                cursorBlink: true,
                fontSize: parseInt(this.getThemeColor('--vscode-editor-font-size', '14').replace('px', '')) || 14,
                fontFamily: this.getThemeColor('--vscode-editor-font-family', 'Consolas, Monaco, Menlo, monospace'),
                theme: this.terminalTheme,
                scrollback: window.scrollbackLines || 1000,
                scrollOnUserInput: false,
                allowTransparency: false,
                windowsMode: false,
                experimentalCharAtlas: 'dynamic',
                allowProposedApi: true
            });
            
            // Initialize addons
            this.fitAddon = new FitAddon.FitAddon();
            this.serializeAddon = new SerializeAddon.SerializeAddon();
            this.unicodeAddon = new Unicode11Addon.Unicode11Addon();
            
            
            // Configure WebLinksAddon for web URLs only
            this.webLinksAddon = new WebLinksAddon.WebLinksAddon((event, uri) => {
                console.log('🔧 FORCE DEBUG: WebLinksAddon detected web URL:', uri);
                Logger.debug(`WebLinksAddon detected web URL: "${uri}"`);
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
            console.log('🔧 FORCE DEBUG: Loading addons...');
            this.terminal.loadAddon(this.fitAddon);
            console.log('🔧 FORCE DEBUG: Loaded FitAddon');
            this.terminal.loadAddon(this.serializeAddon);
            console.log('🔧 FORCE DEBUG: Loaded SerializeAddon');
            this.terminal.loadAddon(this.unicodeAddon);
            console.log('🔧 FORCE DEBUG: Loaded UnicodeAddon');
            this.terminal.loadAddon(this.webLinksAddon);
            console.log('🔧 FORCE DEBUG: Loaded WebLinksAddon');
            
            // Note: File path link setup moved to after terminal attachment
            
            // Try to manually trigger link detection after a delay
            setTimeout(() => {
                console.log('🔧 FORCE DEBUG: Attempting to manually trigger link detection...');
                Logger.debug('🔗 Attempting to manually trigger link detection...');
                
                // Check if terminal has any methods for triggering link detection
                const linkMethods = Object.getOwnPropertyNames(this.terminal).filter(name => 
                    name.toLowerCase().includes('link') || name.toLowerCase().includes('refresh')
                );
                console.log('🔧 FORCE DEBUG: Available link/refresh methods:', linkMethods);
                Logger.debug('Available link/refresh methods:', linkMethods);
                
                // Write some test content with file paths
                console.log('🔧 FORCE DEBUG: Writing test file paths to terminal...');
                this.terminal.write('\r\nTest file paths:\r\n');
                this.terminal.write('/Users/volte/test.js\r\n');
                this.terminal.write('./src/terminal.js\r\n');
                this.terminal.write('~/Documents/project.ts\r\n');
                this.terminal.write('package.json\r\n');
                
                // Debug: Check what's in the terminal buffer after writing
                setTimeout(() => {
                    console.log('🔧 FORCE DEBUG: Checking terminal buffer after write...');
                    const activeBuffer = this.terminal.buffer.active;
                    const bufferLength = activeBuffer.length;
                    console.log('🔧 FORCE DEBUG: Buffer length:', bufferLength);
                    
                    // Check the last few lines for our test content
                    for (let i = Math.max(0, bufferLength - 10); i < bufferLength; i++) {
                        const line = activeBuffer.getLine(i);
                        if (line) {
                            const lineText = line.translateToString(true);
                            console.log(`🔧 FORCE DEBUG: Line ${i + 1}: "${lineText}"`);
                        }
                    }
                }, 500);
                
                // Try some common trigger methods if they exist
                if (typeof this.terminal.refresh === 'function') {
                    console.log('🔧 FORCE DEBUG: Calling terminal.refresh()');
                    Logger.debug('Calling terminal.refresh()');
                    this.terminal.refresh();
                }
                
                if (typeof this.terminal.resize === 'function') {
                    console.log('🔧 FORCE DEBUG: Triggering resize to refresh links');
                    Logger.debug('Triggering resize to refresh links');
                    const dims = this.fitAddon?.proposeDimensions();
                    if (dims) {
                        this.terminal.resize(dims.cols, dims.rows);
                    }
                }
                
            }, 2000); // Wait 2 seconds for terminal to be fully ready
            
            // Set up event handlers
            this.setupEventHandlers();
            
            // Activate Unicode 11 support (based on xterm.js PR #2568)
            // if (this.terminal.unicode) {
            //     this.terminal.unicode.activeVersion = '11';
            //     console.log('Unicode 11 activated, active version:', this.terminal.unicode.activeVersion);
            //     console.log('Available Unicode versions:', this.terminal.unicode.versions);
            // } else {
            //     console.warn('Unicode API not available on terminal');
            // }
            
        } catch (error) {
            Logger.error(`Failed to initialize terminal ${this.id}:`, error);
        }
    }
    
    /**
     * Set up custom link providers for file paths using xterm-link-provider
     */
    setupFilePathLinks() {
        console.log('🔧 FORCE DEBUG: setupFilePathLinks called for terminal', this.id);
        Logger.debug('🔗 setupFilePathLinks called for terminal', this.id);
        if (!this.terminal) {
            Logger.debug('🔗 No terminal available, returning');
            return;
        }
        
        try {
            Logger.debug('🔗 Starting debug checks...');
            
            // Debug: Check what link-related methods are available on the terminal
            try {
                const linkMethods = Object.getOwnPropertyNames(this.terminal).filter(name => name.toLowerCase().includes('link'));
                Logger.debug('Terminal methods with "link":', linkMethods);
            } catch (e) {
                Logger.error('Error getting terminal methods:', e);
            }
            
            try {
                const prototypeLinkMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(this.terminal)).filter(name => name.toLowerCase().includes('link'));
                Logger.debug('Terminal prototype methods with "link":', prototypeLinkMethods);
            } catch (e) {
                Logger.error('Error getting prototype methods:', e);
            }
            
            Logger.debug('registerLinkProvider exists:', typeof this.terminal.registerLinkProvider);
            Logger.debug('registerLinkMatcher exists:', typeof this.terminal.registerLinkMatcher);
            
            // Check xterm.js version
            Logger.debug('Terminal constructor name:', this.terminal.constructor.name);
            Logger.debug('Available terminal properties:', Object.getOwnPropertyNames(this.terminal).slice(0, 10));
            
            // Check if registerLinkProvider actually works
            if (typeof this.terminal.registerLinkProvider !== 'function') {
                Logger.error('registerLinkProvider is not a function, falling back to registerLinkMatcher');
                this.setupFilePathLinksWithMatcher();
                return;
            }
            
            // Test if registerLinkProvider works at all
            Logger.debug('Testing basic registerLinkProvider functionality...');
            
            // First, try the simplest possible link provider
            const testProvider = {
                provideLinks: (y, callback) => {
                    Logger.debug('🧪 TEST: provideLinks called for line', y);
                    callback(undefined); // Return no links for now
                }
            };
            
            try {
                const testDisposable = this.terminal.registerLinkProvider(testProvider);
                Logger.debug('🧪 TEST: Successfully registered test provider, disposable:', testDisposable);
                
                // If that worked, dispose it and try our real implementation
                if (testDisposable && testDisposable.dispose) {
                    testDisposable.dispose();
                    Logger.debug('🧪 TEST: Disposed test provider');
                }
            } catch (testError) {
                Logger.error('🧪 TEST: Failed to register test provider:', testError);
            }
            
            // Create proper FilePathLinkProvider based on official xterm.js patterns
            Logger.debug('Creating FilePathLinkProvider based on official xterm.js patterns...');
            
            class FilePathLinkProvider {
                constructor(terminal, regex, handler, options = {}) {
                    this._terminal = terminal;
                    this._regex = regex;
                    this._handler = handler;
                    this._options = options;
                }
                
                provideLinks(y, callback) {
                    console.log('🔧 FORCE DEBUG: FilePathLinkProvider.provideLinks called for line', y);
                    Logger.debug('🔍 FilePathLinkProvider.provideLinks called for line', y);
                    try {
                        const links = this._computeLinks(y);
                        Logger.debug('🔍 Computed', links.length, 'links for line', y);
                        callback(links.length > 0 ? links : undefined);
                    } catch (error) {
                        Logger.error('Error in FilePathLinkProvider.provideLinks:', error);
                        callback(undefined);
                    }
                }
                
                _computeLinks(y) {
                    const rex = new RegExp(
                        this._regex.source,
                        ((this._regex.flags || '') + 'g')
                            .split('')
                            .filter((value, index, arr) => arr.indexOf(value) === index)
                            .join('')
                    );
                    
                    const [line, startLineIndex] = this._translateBufferLineToStringWithWrap(y - 1);
                    console.log('🔧 FORCE DEBUG: Processing line', y, 'text:', `"${line}"`);
                    Logger.debug('🔍 Processing line text:', `"${line}"`);
                    
                    let match;
                    let stringIndex = -1;
                    const result = [];
                    
                    while ((match = rex.exec(line)) !== null) {
                        const text = match[0]; // Use full match, not match[1]
                        if (!text) {
                            Logger.debug('🔍 Empty match found, skipping');
                            continue;
                        }
                        
                        // Find the actual position of the match in the line
                        stringIndex = line.indexOf(text, stringIndex + 1);
                        rex.lastIndex = stringIndex + text.length;
                        
                        if (stringIndex < 0) {
                            Logger.debug('🔍 Invalid string index, breaking');
                            break;
                        }
                        
                        Logger.debug('🔍 Found file path match:', text, 'at string index', stringIndex);
                        
                        const range = {
                            start: this._stringIndexToBufferPosition(startLineIndex, stringIndex),
                            end: this._stringIndexToBufferPosition(startLineIndex, stringIndex + text.length - 1, true)
                        };
                        
                        const link = {
                            range: range,
                            text: text,
                            activate: (event, text) => {
                                console.log('🔧 FORCE DEBUG: File path link ACTIVATED:', text);
                                console.log('🔧 FORCE DEBUG: Event:', event);
                                Logger.debug('🔗 File path link activated:', text);
                                this._handler(event, text);
                            },
                            ...this._options
                        };
                        
                        result.push(link);
                    }
                    
                    return result;
                }
                
                _translateBufferLineToStringWithWrap(lineIndex) {
                    let lineString = '';
                    let lineWrapsToNext;
                    let prevLinesToWrap;
                    
                    // Find the start of wrapped lines
                    do {
                        const line = this._terminal.buffer.active.getLine(lineIndex);
                        if (!line) {
                            break;
                        }
                        if (line.isWrapped) {
                            lineIndex--;
                        }
                        prevLinesToWrap = line.isWrapped;
                    } while (prevLinesToWrap);
                    
                    const startLineIndex = lineIndex;
                    
                    // Collect all wrapped lines
                    do {
                        const nextLine = this._terminal.buffer.active.getLine(lineIndex + 1);
                        lineWrapsToNext = nextLine ? nextLine.isWrapped : false;
                        const line = this._terminal.buffer.active.getLine(lineIndex);
                        if (!line) {
                            break;
                        }
                        lineString += line.translateToString(true).substring(0, this._terminal.cols);
                        lineIndex++;
                    } while (lineWrapsToNext);
                    
                    return [lineString, startLineIndex];
                }
                
                _stringIndexToBufferPosition(lineIndex, stringIndex, reportLastCell = false) {
                    const cell = this._terminal.buffer.active.getNullCell();
                    while (stringIndex) {
                        const line = this._terminal.buffer.active.getLine(lineIndex);
                        if (!line) {
                            return { x: 0, y: 0 };
                        }
                        const length = line.length;
                        for (let i = 0; i < length; ) {
                            line.getCell(i, cell);
                            stringIndex -= cell.getChars().length;
                            if (stringIndex < 0) {
                                return { x: i + (reportLastCell ? cell.getWidth() : 1), y: lineIndex + 1 };
                            }
                            i += cell.getWidth();
                        }
                        lineIndex++;
                    }
                    return { x: 1, y: lineIndex + 1 };
                }
            }
            
            const LinkProviderClass = FilePathLinkProvider;

            // Improved file path patterns for better detection
            const patterns = [
                // Unix absolute paths: /path/to/file.ext or /path/to/directory
                { regex: /\/[a-zA-Z0-9][a-zA-Z0-9\._\-\/]*[a-zA-Z0-9]/g, type: 'absolute' },
                // Relative paths: ./file or ../path/file.ext
                { regex: /\.\.?\/[a-zA-Z0-9][a-zA-Z0-9\._\-\/]*[a-zA-Z0-9]/g, type: 'relative' },
                // Home directory paths: ~/path/file.ext
                { regex: /~\/[a-zA-Z0-9][a-zA-Z0-9\._\-\/]*[a-zA-Z0-9]/g, type: 'home' },
                // Windows paths: C:\path\file.ext
                { regex: /[a-zA-Z]:[\\][a-zA-Z0-9][a-zA-Z0-9\._\-\\]*[a-zA-Z0-9]/g, type: 'windows' },
                // Simple filename with extension (common in error messages)
                { regex: /[a-zA-Z0-9][a-zA-Z0-9\._\-]*\.[a-zA-Z]{1,4}/g, type: 'filename' }
            ];
            
            Logger.debug('📋 Registering file path patterns:', patterns.map(p => ({ type: p.type, regex: p.regex.source })));
            
            // Track providers for cleanup
            if (!this.linkProviders) {
                this.linkProviders = [];
            }
            
            patterns.forEach(pattern => {
                try {
                    console.log(`🔧 FORCE DEBUG: Creating ${pattern.type} FilePathLinkProvider with regex:`, pattern.regex.source);
                    Logger.debug(`📝 Creating ${pattern.type} FilePathLinkProvider with regex:`, pattern.regex.source);
                    
                    const linkProvider = new LinkProviderClass(
                        this.terminal,
                        pattern.regex,
                        (event, text) => {
                            console.log(`🔧 FORCE DEBUG: File path link clicked (${pattern.type}): "${text}"`);
                            console.log('🔧 FORCE DEBUG: Sending openFile message to VS Code');
                            Logger.debug(`🔗 File path link clicked (${pattern.type}): "${text}"`);
                            this.vscode.postMessage({ command: 'openFile', filePath: text });
                        },
                        {
                            hover: (event, text) => {
                                Logger.debug(`👁️ Hovering over ${pattern.type} path: "${text}"`);
                            },
                            leave: (event, text) => {
                                Logger.debug(`👁️ Left hover on ${pattern.type} path: "${text}"`);
                            }
                        }
                    );
                    
                    Logger.debug(`🏁 Created ${pattern.type} FilePathLinkProvider instance:`, {
                        hasProvideLinks: typeof linkProvider.provideLinks === 'function',
                        regex: pattern.regex.source,
                        type: pattern.type
                    });
                    
                    // Register the link provider
                    console.log(`🔧 FORCE DEBUG: About to register ${pattern.type} link provider...`);
                    const disposable = this.terminal.registerLinkProvider(linkProvider);
                    console.log(`🔧 FORCE DEBUG: registerLinkProvider returned:`, disposable);
                    
                    Logger.debug(`✅ Successfully registered ${pattern.type} path link provider, disposable exists:`, !!disposable);
                    this.linkProviders.push({ provider: linkProvider, disposable, type: pattern.type });
                } catch (providerError) {
                    Logger.error(`❌ Failed to register ${pattern.type} path link provider:`, providerError);
                }
            });
            
            console.log('🔧 FORCE DEBUG: Total link providers registered:', this.linkProviders.length);
            Logger.debug(`📋 Total link providers registered:`, this.linkProviders.length);
            
        } catch (error) {
            Logger.error('Failed to setup file path links:', error);
        }
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
        
        // Set up data handler - coordinate with PTY backend
        this.dataDisposable = this.terminal.onData((data) => {
            // Send user input to our PTY process
            this.sendDataToPty(data);
            
            // Save state synchronously (fast, no async messaging)
            if (window.tabManager && window.tabManager.saveToLocalState) {
                window.tabManager.saveToLocalState();
            }
        });
        
        // Set up resize handler - coordinate with PTY backend
        this.resizeDisposable = this.terminal.onResize((size) => {
            // Notify our PTY process of resize
            this.sendResizeToPty(size.cols, size.rows);
        });
        
        // Set up bell handler - listen for terminal bell events
        this.bellDisposable = this.terminal.onBell(() => {
            Logger.debug(`Terminal ${this.id} received bell event`);
            this.showBellIndicator();
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
                
                // Set up file path links immediately after opening
                // The terminal is now attached to DOM and ready for link providers
                console.log('🔧 FORCE DEBUG: Setting up file path links after terminal.open()');
                this.setupFilePathLinks();
                
                // Also listen for terminal render events to ensure links work if content changes
                if (typeof this.terminal.onRender === 'function') {
                    this.renderDisposable = this.terminal.onRender(() => {
                        // Links are automatically re-evaluated by xterm.js on render
                        // No need to re-register providers
                    });
                    console.log('🔧 FORCE DEBUG: Set up onRender listener for link updates');
                }
            }
            
            // Fit the terminal to container
            if (this.fitAddon && container.offsetWidth > 0 && container.offsetHeight > 0) {
                this.fitAddon.fit();
            }
        } catch (error) {
            Logger.error(`Failed to attach terminal ${this.id} to container:`, error);
        }
    }
    
    /**
     * Write data to the terminal
     */
    write(data) {
        if (!this.terminal) return;
        
        try {
            this.terminal.write(data);
            
            // Note: Content is written - no need to track hasContent flag
            
            // Save state synchronously (fast, no async messaging)
            if (window.tabManager && window.tabManager.saveToLocalState) {
                window.tabManager.saveToLocalState();
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
            // Clear bell indicator when tab becomes active
            if (this.hasBellIndicator) {
                this.clearBellIndicator();
            }
            
            setTimeout(() => {
                this.fit();
                this.focus();
            }, 100);
        }
    }
    
    /**
     * Show bell indicator in tab
     */
    showBellIndicator() {
        const tabElement = document.querySelector(`[data-tab-id="${this.id}"]`);
        if (!tabElement) return;
        
        // Check if bell indicator already exists to avoid duplicates
        let bellIndicator = tabElement.querySelector('.bell-indicator');
        if (!bellIndicator) {
            // Create bell indicator
            bellIndicator = document.createElement('span');
            bellIndicator.className = 'bell-indicator codicon codicon-bell';
            bellIndicator.style.cssText = `
                margin-left: 4px;
                opacity: 1;
                transition: opacity 0.3s ease;
                color: var(--vscode-notificationsWarningIcon-foreground, #ffcc02);
            `;
            
            // Insert bell before close button
            const closeBtn = tabElement.querySelector('.tab-close');
            if (closeBtn) {
                tabElement.insertBefore(bellIndicator, closeBtn);
            } else {
                tabElement.appendChild(bellIndicator);
            }
        } else {
            // Reset opacity if indicator already exists
            bellIndicator.style.opacity = '1';
        }
        
        // Mark that this terminal has an unread bell
        this.hasBellIndicator = true;
        
        // Play sound notification and include tab info for navigation
        this.vscode.postMessage({
            command: 'playBellSound',
            tabId: this.id,
            tabLabel: this.label
        });
    }
    
    /**
     * Clear bell indicator when tab becomes active
     */
    clearBellIndicator() {
        const tabElement = document.querySelector(`[data-tab-id="${this.id}"]`);
        if (!tabElement) return;
        
        const bellIndicator = tabElement.querySelector('.bell-indicator');
        if (bellIndicator) {
            bellIndicator.style.opacity = '0';
            // Remove element after fade completes
            setTimeout(() => {
                if (bellIndicator && bellIndicator.parentNode) {
                    bellIndicator.parentNode.removeChild(bellIndicator);
                }
            }, 300);
        }
        
        this.hasBellIndicator = false;
    }
    
    /**
     * Serialize terminal state for persistence
     */
    serialize() {
        if (!this.serializeAddon) {
            return null;
        }
        
        try {
            // Try including modes to capture prompt state
            const serialized = this.serializeAddon.serialize({
                scrollback: window.scrollbackLines || 1000,
                excludeModes: false,  // Include terminal modes to capture prompt state
                excludeAltBuffer: true
            });
            
            // Debug: Log serialization info
            const lines = serialized ? serialized.split('\n').length : 0;
            const lastLine = serialized ? serialized.split('\n').slice(-2)[0] : 'none'; // -2 because last is usually empty
            Logger.debug(`Serialized terminal ${this.id}: ${lines} lines, last line: "${lastLine}"`);
            
            return serialized;
        } catch (error) {
            Logger.error(`Failed to serialize terminal ${this.id}:`, error);
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
            // Debug: Log deserialization info
            const lines = serializedContent.split('\n').length;
            const lastLine = serializedContent.split('\n').slice(-2)[0]; // -2 because last is usually empty
            Logger.debug(`Deserializing terminal ${this.id}: ${lines} lines, last line: "${lastLine}"`);
            
            // Write content (don't trigger state save during restoration)
            this.terminal.write(serializedContent);
            window.dispatchEvent(new Event('resize'));
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
            
            // Clear bell indicator
            if (this.hasBellIndicator) {
                this.clearBellIndicator();
            }
            
            // Clear references
            this.fitAddon = null;
            this.serializeAddon = null;
            this.webLinksAddon = null;
            
        } catch (error) {
            Logger.error(`Failed to dispose terminal ${this.id}:`, error);
        }
    }
}