/**
 * Tab Manager Class (Refactored)
 * 
 * Purpose:
 * - Manages a collection of TerminalWrapper instances
 * - Handles tab UI (create, switch, close, labels)
 * - Coordinates terminal display and focus
 * - Manages bulk save/restore operations
 * - Provides clean API for tab operations
 * 
 * Responsibilities:
 * - Create and destroy TerminalWrapper instances
 * - Handle tab UI interactions and responsive layout
 * - Manage active/inactive terminal switching
 * - Coordinate with extension host for PTY operations
 * - Bulk serialization and restoration of all terminals
 * 
 * Key Features:
 * - Clean separation: TabManager handles UI, TerminalWrapper handles terminals
 * - Simple collection management with Map<id, TerminalWrapper>
 * - Responsive tab layout switching
 * - Bulk operations for save/restore
 * - Event delegation for tab interactions
 */

class TabManager {
    constructor(vscode, terminalTheme, getThemeColor) {
        this.vscode = vscode;
        this.terminalTheme = terminalTheme;
        this.getThemeColor = getThemeColor;
        
        // Tab title rendering is now handled by the extension host
        
        // Collection of terminal wrappers
        this.terminals = new Map();
        this.activeTabId = null;
        this.nextTabId = 1;
        this.isInitialized = false;
    // Cold/warm restore tracking (minimal)
    this._historyBannerInjected = false; // guards single injection of History Restored banner for this restore cycle
    this._historyBannerShownEver = false; // persisted (via vscode.setState) across webview instances to avoid re-showing banner
        
        // Initialize everything
        this.initializeEventListeners();
        this.setupResponsiveLayout();
        this.setupMessageHandling();
        this.setupWindowEventHandlers();
        this.autoInitialize();
        
        // Show current debug filter status on startup
        this.showDebugFilterStatus();
        
        // Signal immediately that webview is ready and request file cache
        queueMicrotask(() => {
            this.vscode.postMessage({ command: 'webviewReady' });
            this.vscode.postMessage({ command: 'requestFileCache' });
        });

    // Performance samples storage
    window.__terminalPerf = window.__terminalPerf || { samples: [] };
    }
    
    /**
     * Setup message handling from extension host
     */
    setupMessageHandling() {
        window.addEventListener('message', event => {
            const message = event.data;
            Logger.debug('📨 Webview received message:', message.command);
            
            try {
                switch (message.command) {
                    case 'restoreState':
                        Logger.debug('🔄 Received restoreState terminals:', message.state?.terminals?.length, 'existing:', this.terminals.size, 'providerColdFlag:', !!message.cold);
                        if (this.terminals.size > 0) {
                            Logger.debug('⏭️ Skipping restoreState (already have terminals) treating as warm focus');
                            break;
                        }
                        
                        // Try webview state first, then fall back to extension state
                        const webviewState = vscode.getState();
                        // If we've ever shown the history banner before in ANY previous webview instance, record it separately
                        if (webviewState && webviewState.historyBannerShownOnce) {
                            this._historyBannerShownEver = true;
                        }
                        if (webviewState && webviewState.fullTabState) {
                            Logger.debug('🔄 Using webview state (more recent)');
                            this.restoreFromState(webviewState.fullTabState, !!message.cold);
                        } else if (message.state) {
                            Logger.debug('🔄 Using extension state (fallback)');
                            this.restoreFromState(message.state, !!message.cold);
                        } else {
                            Logger.debug('🔄 No state available, creating default');
                            this.restoreFromState(this.createDefaultState(), !!message.cold);
                        }
                        break;
                        
                    case 'initializeEmpty':
                        Logger.debug('🆕 Received initializeEmpty command - checking for existing state');
                        
                        // Check if we have webview state before creating empty
                        const existingState = vscode.getState();
                        if (existingState && existingState.fullTabState) {
                            Logger.debug('🔄 Found existing webview state, restoring instead of creating empty');
                            this.restoreFromState(existingState.fullTabState, !!message.cold);
                        } else {
                            Logger.debug('🆕 No existing state, creating default terminal');
                            const defaultState = this.createDefaultState();
                            this.restoreFromState(defaultState, !!message.cold);
                        }
                        break;
                        
                    case 'data':
                        this.ensureInitialized();
                        
                        // Write data to specific terminal
                        if (message.tabId) {
                            this.writeToTerminal(message.tabId, message.data);
                        } else {
                            // Fallback to active terminal
                            const activeTerminal = this.getActiveTerminal();
                            if (activeTerminal) {
                                activeTerminal.write(message.data);
                            }
                        }
                        break;
                        
                    case 'reconnect':
                    case 'redraw':
                        // Simple redraw - fit the active terminal
                        const activeTerminal = this.getActiveTerminal();
                        if (activeTerminal) {
                            activeTerminal.fit();
                        }
                        break;
                    case 'focus':
                        // Warm focus: just refresh active terminal visuals
                        const act = this.getActiveTerminal();
                        if (act && act.terminal) {
                            try { act.terminal.refresh(0, act.terminal.rows - 1); act.fit(); } catch(_) {}
                        }
                        break;
                        
                    case 'refresh':
                        location.reload();
                        break;
                    case 'refreshActive':
                        // Lightweight visual refresh only
                        const a = this.getActiveTerminal();
                        if (a && a.terminal) {
                            try {
                                a.terminal.refresh(0, a.terminal.rows - 1);
                                a.fit();
                            } catch (_) {}
                        }
                        break;
                        
                    case 'triggerResize':
                        window.dispatchEvent(new Event('resize'));
                        break;
                        
                    case 'requestState':
                        console.log('📤 Webview received requestState command');
                        this.ensureInitialized();
                        
                        const currentState = this.saveAllStates();
                        console.log('📤 Sending state response:', currentState ? `${currentState.terminals?.length} terminals` : 'no state');
                        this.vscode.postMessage({ 
                            command: 'stateResponse', 
                            state: currentState 
                        });
                        break;
                        
                    case 'processChange':
                        this.handleProcessChange(message.processName, message.tabId);
                        break;
                        
                    case 'createNewTab':
                        this.createNewTab(message.terminalType);
                        break;
                        
                    case 'switchToTab':
                        if (message.tabId) {
                            this.switchToTab(message.tabId);
                        }
                        break;
                        
                    case 'updateFileCache':
                        window.workspaceFileCache = new Set(message.files || []);
                        
                        // Debug: Log first few files to see the format
                        const firstTen = Array.from(window.workspaceFileCache).slice(0, 10);
                        
                        // Check if package.json is in cache
                        const hasPackageJson = window.workspaceFileCache.has('package.json');
                        
                        // Check for files ending with package.json
                        let foundPackageJson = false;
                        for (const file of window.workspaceFileCache) {
                            if (file.endsWith('package.json')) {
                                foundPackageJson = true;
                                break;
                            }
                        }
                        if (!foundPackageJson) {
                        }
                        break;
                        
                    case 'fileExistsResponse':
                        Logger.debug('🔍 File exists response:', message.filePath, '->', message.exists);
                        // Could be used for individual file checks if needed
                        break;
                        
                    case 'setDebugFilter':
                        if (message.filter) {
                            localStorage.setItem('claudePilot.debugFilter', JSON.stringify(message.filter));
                            console.log('📝 Debug filter set to:', message.filter);
                        } else {
                            localStorage.removeItem('claudePilot.debugFilter');
                            console.log('📝 Debug filter cleared');
                        }
                        break;
                        
                    case 'setDeveloperMode':
                        window.DEVELOPER_MODE = message.enabled;
                        console.log('🛠️ Developer mode:', message.enabled ? 'ENABLED' : 'DISABLED');
                        
                        // Enable debug features if developer mode is on
                        if (message.enabled) {
                            console.log('🛠️ Debug features available for developer');
                        }
                        break;
                    case 'collectPerformance':
                        this._reportPerformance();
                        break;
                        
                    default:
                        Logger.warn('Unknown command received:', message.command);
                        break;
                }
            } catch (error) {
                Logger.error('Message handling error:', error);
            }
        });
    }

    _recordTerminalTiming(id) {
        try {
            const initStart = performance.getEntriesByName(`t${id}-init-start`)[0];
            const openMark = performance.getEntriesByName(`t${id}-open`)[0];
            const activeTime = performance.getEntriesByName(`t${id}-active`)[0];
            if (initStart && openMark) {
                const initToOpen = openMark.startTime - initStart.startTime;
                const openToActive = activeTime ? activeTime.startTime - openMark.startTime : null;
                window.__terminalPerf.samples.push({ id, initToOpen, openToActive });
            }
        } catch (e) { /* ignore */ }
    }

    _reportPerformance() {
        const samples = window.__terminalPerf.samples || [];
        if (!samples.length) {
            this.vscode.postMessage({ command: 'performanceReport', data: { count: 0, samples: [] } });
            return;
        }
        const initVals = samples.map(s => s.initToOpen).filter(n => n != null);
        const openVals = samples.map(s => s.openToActive).filter(n => n != null);
        const avg = arr => arr.reduce((a,b)=>a+b,0)/arr.length;
        this.vscode.postMessage({ command: 'performanceReport', data: {
            count: samples.length,
            avgInit: initVals.length ? avg(initVals) : 0,
            avgOpenToActive: openVals.length ? avg(openVals) : 0,
            samples
        }});
    }
    
    /**
     * Show current debug filter status on startup
     */
    showDebugFilterStatus() {
        const currentFilter = localStorage.getItem('claudePilot.debugFilter');
        if (currentFilter) {
            try {
                const filterEmojis = JSON.parse(currentFilter);
                const filterDisplay = Array.isArray(filterEmojis) ? filterEmojis.join(' ') : filterEmojis;
                console.log(`📝 Debug filter active: ${filterDisplay}`);
                console.log(`📝 To change: debug-filter 🔗 📁 (or debug-filter clear)`);
            } catch {
                console.log(`📝 Debug filter active: ${currentFilter}`);
            }
        } else {
            console.log('📝 No debug filter active - showing all logs');
            console.log('📝 To filter: debug-filter 📁 (files) or debug-filter 🔗 (links)');
        }
    }
    
    /**
     * Setup window event handlers
     */
    setupWindowEventHandlers() {
        // Window resize handling
        window.addEventListener('resize', () => {
            const activeTerminal = this.getActiveTerminal();
            if (activeTerminal) {
                activeTerminal.fit();
            }
        });

        // Focus handling
        window.addEventListener('focus', () => {
            requestAnimationFrame(() => {
                const activeTerminal = this.getActiveTerminal();
                if (activeTerminal) activeTerminal.fit();
            });
        });
        
        // Setup keyboard shortcut passthrough
        this.setupKeyboardPassthrough();
    }
    
    /**
     * Auto-initialize - just setup, restoration will handle terminal creation
     */
    autoInitialize() {
        // Just show the interface, terminal creation will happen via restoration
    // Show interface immediately (no artificial delay)
    this.showInterface();
    }
    
    /**
     * Ensure we have at least one terminal
     */
    ensureInitialized() {
        if (!this.isInitialized) {
            this.initialize();
            this.isInitialized = true;
        }
    }
    
    /**
     * Set up keyboard event interception to allow VS Code shortcuts
     */
    setupKeyboardPassthrough() {
        const vsCodeShortcuts = [
            { key: 'F5', ctrlKey: false, shiftKey: false, altKey: false },
            { key: 'F1', ctrlKey: false, shiftKey: false, altKey: false },
            { key: 'F11', ctrlKey: false, shiftKey: false, altKey: false },
            { key: 'p', ctrlKey: true, shiftKey: true, altKey: false },
            { key: 'P', ctrlKey: true, shiftKey: true, altKey: false },
            { key: 'n', ctrlKey: true, shiftKey: false, altKey: false },
            { key: 'o', ctrlKey: true, shiftKey: false, altKey: false },
            { key: 's', ctrlKey: true, shiftKey: false, altKey: false },
            { key: 'w', ctrlKey: true, shiftKey: false, altKey: false },
            { key: 'g', ctrlKey: true, shiftKey: false, altKey: false },
            { key: 'f', ctrlKey: true, shiftKey: false, altKey: false },
            { key: 'h', ctrlKey: true, shiftKey: false, altKey: false },
            { key: 'b', ctrlKey: true, shiftKey: false, altKey: false },
            { key: '`', ctrlKey: true, shiftKey: false, altKey: false },
            { key: 'j', ctrlKey: true, shiftKey: false, altKey: false },
            { key: 'Tab', ctrlKey: true, shiftKey: false, altKey: false },
            { key: 'Tab', ctrlKey: true, shiftKey: true, altKey: false },
            { key: '=', ctrlKey: true, shiftKey: false, altKey: false },
            { key: '-', ctrlKey: true, shiftKey: false, altKey: false },
            { key: '0', ctrlKey: true, shiftKey: false, altKey: false },
        ];
        
        // Add clear terminal shortcut (Cmd+K on macOS, Ctrl+K on Windows/Linux)
        const clearShortcut = { key: 'k', ctrlKey: true, shiftKey: false, altKey: false };
        
        // Add macOS shortcuts
        if (navigator.platform.indexOf('Mac') > -1) {
            const macShortcuts = vsCodeShortcuts.map(shortcut => ({
                ...shortcut,
                ctrlKey: false,
                metaKey: shortcut.ctrlKey
            }));
            vsCodeShortcuts.push(...macShortcuts);
        }
        
        document.addEventListener('keydown', (event) => {
            // Check for clear terminal shortcut first
            const isMac = navigator.platform.indexOf('Mac') > -1;
            const clearKeyPressed = event.key === 'k' && 
                                  ((isMac && event.metaKey) || (!isMac && event.ctrlKey)) &&
                                  !event.shiftKey && !event.altKey;
            
            if (clearKeyPressed) {
                event.preventDefault();
                event.stopPropagation();
                this.clearActiveTerminal();
                return false;
            }
            
            const matchesShortcut = vsCodeShortcuts.some(shortcut => {
                return event.key === shortcut.key &&
                       event.ctrlKey === shortcut.ctrlKey &&
                       event.shiftKey === shortcut.shiftKey &&
                       event.altKey === shortcut.altKey &&
                       (shortcut.metaKey === undefined || event.metaKey === shortcut.metaKey);
            });
            
            if (matchesShortcut) {
                return true;
            }
            
            return true;
        }, true);
    }
    
    /**
     * Initialize - just show interface, terminal creation happens via restoration
     */
    initialize() {
        // Show the main interface and hide loading screen
        this.showInterface();
        this.isInitialized = true;
    }
    
    /**
     * Create a new terminal tab
     */
    createNewTab(terminalType = 'claude') {
        Logger.debug('📝 createNewTab called with type:', terminalType);
        const tabId = this.nextTabId++;
        
        // Generate label based on terminal type
        let label;
        switch (terminalType) {
            case 'shell':
                label = 'Shell';
                break;
            case 'continue':
                label = 'Claude (Continue)';
                break;
            case 'claude':
            default:
                label = 'Claude Session';
                break;
        }
        
        // Create unified terminal instance (handles both frontend and backend)
        Logger.debug('🏗️ About to create TerminalInstance with id:', tabId, 'label:', label, 'type:', terminalType);
        const terminal = new TerminalInstance(tabId, label, this.vscode, this.terminalTheme, this.getThemeColor, terminalType);
        Logger.debug('🏗️ TerminalInstance created successfully:', terminal);
        
        // Create container and attach terminal
        const container = this.createTerminalContainer(tabId);
        terminal.attachToContainer(container);
        
        // Store the terminal
        this.terminals.set(tabId, terminal);
        
        // Create tab DOM element
        this.createTabElement(tabId, label);
        
        // Set as active if first tab, otherwise switch to it
        if (this.activeTabId === null) {
            this.activeTabId = tabId;
            terminal.setActive(true);
            this.updateActiveTabUI(tabId);
        } else {
            this.switchToTab(tabId);
        }
        
        // Update tab bar visibility
        this.updateTabBarVisibility();
        
        // Save state after creating new tab (synchronous now)
        Logger.debug('New tab created, saving state...');
        this.saveToLocalState();
        
        // PTY process is now created by the Terminal instance itself
    }
    
    /**
     * Switch to a specific tab
     */
    switchToTab(tabId) {
        if (!this.terminals.has(tabId) || tabId === this.activeTabId) return;
        
        // Deactivate all terminals first
        for (const [id, terminal] of this.terminals) {
            terminal.setActive(false);
        }
        
        // Activate target terminal
        const targetTerminal = this.terminals.get(tabId);
        if (targetTerminal) {
            targetTerminal.setActive(true);
        }
        
        // Update UI
        this.updateActiveTabUI(tabId);
        this.activeTabId = tabId;
        
        // Tab switching is now purely UI-level, no need to notify extension host
        // Persist active tab change immediately so reload restores correct tab
        try {
            this.saveToLocalState();
        } catch (e) {
            Logger.warn('Could not persist state after tab switch:', e);
        }
    }
    
    /**
     * Close a specific tab
     */
    closeTab(tabId) {
        if (this.terminals.size <= 1) return; // Don't close last tab
        
        const terminal = this.terminals.get(tabId);
        if (!terminal) return;
        
        // Dispose terminal (handles both frontend and backend cleanup)
        terminal.dispose();
        
        // Remove from collection
        this.terminals.delete(tabId);
        
        // Remove tab element from DOM
        const tabElement = document.querySelector(`[data-tab-id="${tabId}"]`);
        if (tabElement) {
            tabElement.remove();
        }
        
        // If closing active tab, switch to another tab
        if (tabId === this.activeTabId) {
            const remainingTabIds = Array.from(this.terminals.keys());
            if (remainingTabIds.length > 0) {
                this.switchToTab(remainingTabIds[0]);
            }
        }
        
        // Update tab bar visibility
        this.updateTabBarVisibility();
        
        this.saveToLocalState();
        
        // PTY disposal is now handled by the Terminal instance itself
    }
    
    /**
     * Update tab bar visibility based on number of tabs
     */
    updateTabBarVisibility() {
        const tabBar = document.getElementById('tab-bar');
        if (!tabBar) return;
        
        // Hide tab bar if there's only one tab, show it if there are multiple tabs
        if (this.terminals.size <= 1) {
            tabBar.style.display = 'none';
        } else {
            tabBar.style.display = '';
        }
    }

    /**
     * Write data to a specific terminal
     */
    writeToTerminal(tabId, data) {
        const terminal = this.terminals.get(tabId);
        if (terminal) {
            terminal.write(data);
        }
    }
    
    /**
     * Get the active terminal
     */
    getActiveTerminal() {
        return this.terminals.get(this.activeTabId);
    }
    
    /**
     * Update tab label
     */
    updateTabLabel(tabId, label) {
        const terminal = this.terminals.get(tabId);
        if (terminal) {
            terminal.label = label;
            
            const tabElement = document.querySelector(`[data-tab-id="${tabId}"] .tab-label`);
            if (tabElement) {
                tabElement.textContent = label;
            }
        }
    }
    
    /**
     * Start inline tab renaming
     */
    startTabRename(tabId, labelElement) {
        const currentLabel = labelElement.textContent;
        
        // Create input element
        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentLabel;
        input.className = 'tab-rename-input';
        input.style.cssText = `
            background: var(--vscode-input-background, #3c3c3c);
            color: var(--vscode-input-foreground, #cccccc);
            border: 1px solid var(--vscode-input-border, #3c3c3c);
            border-radius: 2px;
            padding: 2px 4px;
            font-size: 12px;
            font-family: inherit;
            width: 100%;
            min-width: 60px;
            outline: none;
        `;
        
        // Focus and select all text (next frame)
        requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
        
        // Save function
        const saveRename = () => {
            const newLabel = input.value.trim();
            if (newLabel && newLabel !== currentLabel) {
                this.updateTabLabel(tabId, newLabel);
            }
            this.endTabRename(labelElement, input, currentLabel);
        };
        
        // Cancel function
        const cancelRename = () => {
            this.endTabRename(labelElement, input, currentLabel);
        };
        
        // Event handlers
        input.addEventListener('blur', saveRename);
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                e.preventDefault();
                saveRename();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelRename();
            }
        });
        
        // Replace label with input
        labelElement.style.display = 'none';
        labelElement.parentNode.insertBefore(input, labelElement);
    }
    
    /**
     * End inline tab renaming
     */
    endTabRename(labelElement, inputElement, originalLabel) {
        // Remove input element
        if (inputElement.parentNode) {
            inputElement.parentNode.removeChild(inputElement);
        }
        
        // Show label element
        labelElement.style.display = '';
        
        // Save state after renaming
        this.saveToLocalState();
    }
    
    /**
     * Save state of all terminals (using WebviewViewSerializer format)
     */
    saveAllStates() {
        Logger.debug('TabManager.saveAllStates() - Current terminals:', this.terminals.size);
        const terminals = [];
        // Map prior persisted rawContent by id so we don't erase history when serialize is suppressed
        let priorContentById = new Map();
        try {
            const priorState = vscode.getState && vscode.getState();
            if (priorState && priorState.fullTabState && Array.isArray(priorState.fullTabState.terminals)) {
                for (const t of priorState.fullTabState.terminals) {
                    priorContentById.set(t.id, t.rawContent || '');
                }
            }
        } catch (e) {
            Logger.warn('Could not read prior state for preservation:', e);
        }
        
        for (const [id, terminal] of this.terminals) {
            // Serialize raw (TerminalInstance handles gating to avoid incomplete CSI sequences)
            let serialized = terminal.serialize();
            if (serialized == null) {
                const preserved = priorContentById.get(id);
                if (preserved) {
                    Logger.debug(`Serialization suppressed for terminal ${id}; preserving prior snapshot (${preserved.length} chars)`);
                    serialized = preserved;
                } else {
                    serialized = '';
                }
            }
            // Trim large non-shell buffers to last 40 lines to reduce stale full-screen TUI state
            if (terminal.terminalType && terminal.terminalType !== 'shell' && serialized) {
                const lines = serialized.split('\n');
                if (lines.length > 40) serialized = lines.slice(-40).join('\n');
            }
            const terminalData = {
                id: terminal.id,
                label: terminal.label,
                rawContent: serialized,
                terminalType: terminal.terminalType || 'claude',
                terminalModes: terminal._terminalModes || 0
            };
            Logger.debug(`Saving terminal ${id}:`, { id: terminalData.id, label: terminalData.label, type: terminalData.terminalType, hasContent: !!terminalData.rawContent });
            terminals.push(terminalData);
        }
        
        const state = {
            terminals: terminals,
            activeTabId: this.activeTabId,
            timestamp: Date.now()
        };
        
        Logger.debug('Final state being saved:', { terminalCount: terminals.length, activeTabId: this.activeTabId });
        return state;
    }
    
    /**
     * Create a default state with one terminal
     */
    createDefaultState() {
        return {
            terminals: [{
                id: 1,
                label: 'Claude Session',
                rawContent: '',
                terminalType: 'claude'
            }],
            activeTabId: 1,
            timestamp: Date.now()
        };
    }
    
    /**
     * Restore terminals from saved state
     */
    restoreFromState(savedState, isColdBoot = false) {
        Logger.debug('TabManager.restoreFromState() called with:', { 
            hasState: !!savedState, 
            terminalCount: savedState?.terminals?.length,
            terminals: savedState?.terminals?.map(t => ({ id: t.id, label: t.label, type: t.terminalType }))
        });

        // If no state or empty state, manufacture a default state
        if (!savedState || !savedState.terminals || savedState.terminals.length === 0) {
            Logger.warn('⚠️ No valid saved state, manufacturing default state');
            savedState = this.createDefaultState();
        }
        
        // Only dispose existing terminals if we actually have any
        if (this.terminals.size > 0) {
            Logger.debug('Disposing existing terminals before restore');
            this.dispose();
        }
        this.terminals.clear();
        this.activeTabId = null;
        
        // Clear tab UI
        const tabBar = document.getElementById('tab-bar');
        if (tabBar) {
            const existingTabs = tabBar.querySelectorAll('.tab');
            existingTabs.forEach(tab => tab.remove());
        }
        
        // Recreate terminals from saved state (in the saved order)
    Logger.debug('Starting to recreate', savedState.terminals.length, 'terminals');
    let maxRestoreDelay = 0;
    for (const terminalData of savedState.terminals) {
            Logger.debug('🔄 Creating terminal from state:', { id: terminalData.id, label: terminalData.label, type: terminalData.terminalType });
            Logger.debug('🔄 About to create TerminalInstance from restore...');
            const terminal = new TerminalInstance(
                terminalData.id,
                terminalData.label,
                this.vscode,
                this.terminalTheme,
                this.getThemeColor,
                terminalData.terminalType || 'claude',
                { autoStartPty: false } // delay PTY spawn until after restored content is written
            );
            Logger.debug('🔄 TerminalInstance created from restore:', terminal);
            
            // Create container and attach
            const container = this.createTerminalContainer(terminalData.id);
            terminal.attachToContainer(container);
            
            // Restore terminal content using new format
            terminal.label = terminalData.label;
            terminal.terminalType = terminalData.terminalType || 'claude';
            
            // Decide what content to load without mutating persisted snapshot
            let contentToLoad = terminalData.rawContent || '';

            if (contentToLoad) {
                Logger.debug('🔄 Restoring content for terminal', terminalData.id, 'with content length:', contentToLoad.length);
                if (isColdBoot) {
                    Logger.debug('🏁 Injecting one-time history banner (cold boot)');
                    contentToLoad += '\n\n\x1b[47m\x1b[30m * \x1b[0m\x1b[48;5;69m\x1b[30m History restored \x1b[0m\n\n';
                }
            } else {
                Logger.debug('🔄 No persisted content for terminal', terminalData.id, '- starting PTY on open');
            }
            
            terminal.whenOpened.then(() => {
                terminal.deserialize(contentToLoad);
                try { terminal.startDeferredPtyIfNeeded(); } catch (e) { Logger.error('Deferred PTY start error:', e); }
            });
            
            // Update next tab ID if needed
            if (terminalData.id >= this.nextTabId) {
                this.nextTabId = terminalData.id + 1;
            }
            
            // Store terminal (Map preserves insertion order)
            this.terminals.set(terminalData.id, terminal);
            Logger.debug('Stored terminal', terminalData.id, '- Current terminal count:', this.terminals.size);
            
            // Create tab element (DOM order will match saved order)
            this.createTabElement(terminalData.id, terminalData.label);
            
            // PTY process creation is now handled by the Terminal instance itself
        }
        
        // Switch to previously active tab
        if (savedState.activeTabId && this.terminals.has(savedState.activeTabId)) {
            this.switchToTab(savedState.activeTabId);
        } else if (this.terminals.size > 0) {
            // Fallback to first available tab
            const firstTabId = Array.from(this.terminals.keys())[0];
            this.switchToTab(firstTabId);
        }
        
        // Show the interface after restoring
        this.showInterface();
        
        const existing = vscode.getState() || {};
        vscode.setState({
            ...existing,
            fullTabState: savedState,
            timestamp: Date.now()
        });
    
        // Once all terminals are boot ready, take a single baseline save
        try {
            const allBootPromises = Array.from(this.terminals.values()).map(t => t.whenBootReady.catch(()=>{}));
            Promise.all(allBootPromises).then(() => {
                Logger.debug('🧷 Post-restore baseline save (event-driven)');
                this.saveToLocalState();
            });
        } catch (e) { Logger.warn('Baseline save scheduling failed:', e); }
        Logger.debug('Restore complete - Final terminal count:', this.terminals.size, 'Active tab:', this.activeTabId);
    }
    
    
    /**
     * Save state synchronously to webview storage
     */
    saveToLocalState() {
        try {
            const fullState = this.saveAllStates();
            Logger.debug('TabManager saving state synchronously:', fullState ? `${fullState.terminals?.length} terminals` : 'no state');
            
            // Save synchronously to webview state - this persists across sessions
            const prior = vscode.getState() || {};
            vscode.setState({
                ...prior,
                fullTabState: fullState,
                timestamp: Date.now(),
                // Ensure persistence of the one-time banner flag once we've done a cold boot
                historyBannerShownOnce: prior.historyBannerShownOnce || this._historyBannerShownEver || false
            });
            
            // OPTIONALLY also send to extension for backup (non-critical, async)
            try {
                this.vscode.postMessage({ 
                    command: 'stateUpdate', 
                    state: fullState 
                });
            } catch (msgError) {
                // Don't fail if async message fails during shutdown
                Logger.warn('⚠️ Could not send state to extension (probably shutting down):', msgError);
            }
        } catch (error) {
            Logger.error('Failed to save state:', error);
        }
    }
    
    /**
     * Create a dedicated terminal container for a specific tab
     */
    createTerminalContainer(tabId) {
        const terminalContainerParent = document.querySelector('.terminal-container');
        if (!terminalContainerParent) return null;
        
        const terminalContainer = document.createElement('div');
        terminalContainer.id = `terminal-${tabId}`;
        terminalContainer.className = 'terminal-instance';
        // Positioning and sizing handled by CSS
        terminalContainer.style.display = 'none';
        
        terminalContainerParent.appendChild(terminalContainer);
        return terminalContainer;
    }
    
    /**
     * Create the DOM element for a tab
     */
    createTabElement(tabId, label) {
        const tabList = document.querySelector('.tab-list');
        
        if (!tabList) return;
        
        // Create semantic list item for tab
        const tab = document.createElement('li');
        tab.className = 'tab';
        tab.dataset.tabId = tabId.toString();
        tab.setAttribute('role', 'tab');
        tab.setAttribute('tabindex', '0');
        tab.setAttribute('aria-selected', 'false');
        tab.setAttribute('aria-label', `${label} tab`);
        // TODO: Add draggable="true" when implementing drag and drop reordering
        
        const labelElement = document.createElement('span');
        labelElement.className = 'tab-label';
        labelElement.textContent = label;
        
        const closeBtn = document.createElement('span');
        closeBtn.className = 'tab-close codicon codicon-trash';
        closeBtn.setAttribute('role', 'button');
        closeBtn.setAttribute('tabindex', '0');
        closeBtn.setAttribute('aria-label', `Close ${label} tab`);
        // TODO: Add draggable="false" when implementing drag and drop reordering
        
        tab.appendChild(labelElement);
        tab.appendChild(closeBtn);
        
        // Append to the end of the tab list
        tabList.appendChild(tab);
    }
    
    /**
     * Update active tab UI
     */
    updateActiveTabUI(tabId) {
        // Update all tabs to inactive state
        document.querySelectorAll('.tab').forEach(tab => {
            tab.classList.remove('active');
            tab.setAttribute('aria-selected', 'false');
            tab.setAttribute('tabindex', '-1');
        });
        
        // Set target tab to active state
        const targetTab = document.querySelector(`[data-tab-id="${tabId}"]`);
        if (targetTab) {
            targetTab.classList.add('active');
            targetTab.setAttribute('aria-selected', 'true');
            targetTab.setAttribute('tabindex', '0');
        }
    }
    
    /**
     * Set up event listeners for tab interactions
     */
    initializeEventListeners() {
        // New tab functionality is now handled by title bar button
        // No DOM-based new tab button needed
        
        // Tab click and keyboard handlers (using event delegation)
        const tabBar = document.getElementById('tab-bar');
        if (tabBar) {
            // Keyboard navigation support
            tabBar.addEventListener('keydown', (e) => {
                if (e.target.classList.contains('tab') || e.target.classList.contains('tab-close')) {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.target.click();
                        e.preventDefault();
                    }
                }
            });
            
            // Click handlers
            tabBar.addEventListener('click', (e) => {
                // Handle close button clicks
                if (e.target.classList.contains('tab-close')) {
                    const tab = e.target.closest('.tab');
                    if (tab && tab.dataset.tabId) {
                        const tabId = parseInt(tab.dataset.tabId);
                        if (!isNaN(tabId)) {
                            this.closeTab(tabId);
                        }
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                
                // Handle tab clicks for switching
                if (e.target.classList.contains('tab') || e.target.parentElement.classList.contains('tab')) {
                    const tab = e.target.classList.contains('tab') ? e.target : e.target.parentElement;
                    const tabId = parseInt(tab.dataset.tabId);
                    if (!isNaN(tabId)) {
                        this.switchToTab(tabId);
                    }
                }
            });
            
            // Double-click handler for tab renaming
            tabBar.addEventListener('dblclick', (e) => {
                // Handle double-clicks on tab labels for renaming
                if (e.target.classList.contains('tab-label')) {
                    const tab = e.target.closest('.tab');
                    if (tab && tab.dataset.tabId) {
                        const tabId = parseInt(tab.dataset.tabId);
                        if (!isNaN(tabId)) {
                            this.startTabRename(tabId, e.target);
                        }
                    }
                    e.preventDefault();
                    e.stopPropagation();
                }
            });
            
            // Keyboard handlers for accessibility
            tabBar.addEventListener('keydown', (e) => {
                if (e.target.classList.contains('tab')) {
                    switch (e.key) {
                        case 'Enter':
                        case ' ':
                            const tabId = parseInt(e.target.dataset.tabId);
                            if (!isNaN(tabId)) {
                                this.switchToTab(tabId);
                            }
                            e.preventDefault();
                            break;
                        case 'Delete':
                        case 'Backspace':
                            const deleteTabId = parseInt(e.target.dataset.tabId);
                            if (!isNaN(deleteTabId)) {
                                this.closeTab(deleteTabId);
                            }
                            e.preventDefault();
                            break;
                    }
                } else if (e.target.classList.contains('tab-close')) {
                    if (e.key === 'Enter' || e.key === ' ') {
                        const tab = e.target.closest('.tab');
                        if (tab && tab.dataset.tabId) {
                            const tabId = parseInt(tab.dataset.tabId);
                            if (!isNaN(tabId)) {
                                this.closeTab(tabId);
                            }
                        }
                        e.preventDefault();
                    }
                }
            });
        }
        
    }
    
    /**
     * Set up responsive layout detection and switching
     */
    setupResponsiveLayout() {
        const container = document.getElementById('container');
        if (!container) return;
        
        // ResizeObserver for responsive tab layout
        const resizeObserver = new ResizeObserver(entries => {
            this.updateTabLayout(entries[0].contentRect);
        });
        
        resizeObserver.observe(container);
        
        // Apply initial layout
        requestAnimationFrame(() => {
            const rect = container.getBoundingClientRect();
            this.updateTabLayout(rect);
        });
    }
    
    /**
     * Update tab layout based on configuration and container size
     */
    updateTabLayout(rect) {
        const container = document.getElementById('container');
        if (!container) return;
        
        const { width, height } = rect;
        const aspectRatio = width / height;
        
        // Get layout preference from configuration
        const layoutPreference = this.getTabLayoutPreference();
        
        let useVerticalTabs = false;
        
        switch (layoutPreference) {
            case 'vertical':
                useVerticalTabs = true;
                break;
            case 'horizontal':
                useVerticalTabs = false;
                break;
            case 'auto':
            default:
                // Switch to vertical tabs if width > height * 1.5
                useVerticalTabs = aspectRatio > 1.5;
                break;
        }
        
        // Apply the layout
        if (useVerticalTabs) {
            container.classList.add('vertical-tabs');
        } else {
            container.classList.remove('vertical-tabs');
        }
        
        // Refit active terminal after layout change
        requestAnimationFrame(() => {
            const activeTerminal = this.getActiveTerminal();
            if (activeTerminal) activeTerminal.fit();
        });
    }
    
    /**
     * Show the main interface and hide loading screen
     */
    showInterface() {
        const loadingDiv = document.querySelector('.loading');
        const container = document.getElementById('container');
        
        if (loadingDiv) {
            loadingDiv.style.display = 'none';
        }
        
        if (container) {
            container.style.display = 'flex';
        }
    }
    
    /**
     * Get tab layout preference from configuration
     */
    getTabLayoutPreference() {
        // For now, return 'auto' - this will be connected to VS Code settings later
        return 'auto';
    }
    
    /**
     * Handle process name changes for dynamic tab labeling
     */
    handleProcessChange(processName, tabId) {
        const terminal = this.terminals.get(tabId);
        if (!terminal) return;
        
        // Debug: log what we're getting
        Logger.debug(`Process change for tab ${tabId}: "${processName}"`);
        
        // Store base label if not already stored
        if (!terminal.baseLabel) {
            terminal.baseLabel = terminal.label.split(' •')[0] || 'Terminal';
        }
        
        // Use template system to generate new label
        const newLabel = this.generateTabTitle(tabId, processName);
        
        // Update the tab label if it changed
        if (newLabel !== terminal.label) {
            this.updateTabLabel(tabId, newLabel);
        }
    }
    
    /**
     * Generate tab title with simple fallback logic
     * TODO: Connect to extension host TabTitleProvider for full template support
     */
    generateTabTitle(tabId, processName) {
        const terminal = this.terminals.get(tabId);
        if (!terminal) return 'Terminal';
        
        const baseTabName = terminal.baseLabel || terminal.label.split(' •')[0] || 'Terminal';
        const cleanProcessName = processName && processName !== 'bash' && processName !== 'zsh' && processName !== 'sh' ? processName : null;
        
        // Simple template logic: "{n}{p? • {p}}"
        return cleanProcessName ? `${baseTabName} • ${cleanProcessName}` : baseTabName;
    }
    
    /**
     * Clear the active terminal (Cmd/Ctrl+K)
     */
    clearActiveTerminal() {
        const activeTerminal = this.getActiveTerminal();
        if (activeTerminal) {
            // Clear the xterm display (this also sets hasContent = false)
            activeTerminal.clear();
            
            // Save the cleared state
            this.saveToLocalState();
            
            Logger.debug('Cleared active terminal:', this.activeTabId);
        }
    }
    
    /**
     * Refresh link providers for all terminals when CMD key state changes
     */
    refreshLinkProviders() {
        console.log('🔧 REFRESH DEBUG: Refreshing link providers for', this.terminals.size, 'terminals');
        for (const terminal of this.terminals.values()) {
            if (terminal.setupFilePathLinks) {
                console.log('🔧 REFRESH DEBUG: Calling setupFilePathLinks for terminal', terminal.id);
                terminal.setupFilePathLinks();
            } else {
                console.log('🔧 REFRESH DEBUG: Terminal', terminal.id, 'has no setupFilePathLinks method');
            }
        }
    }
    
    /**
     * Dispose of all terminals and cleanup
     */
    dispose() {
        for (const [id, terminal] of this.terminals) {
            terminal.dispose();
        }
        this.terminals.clear();
    }

    /**
     * Remove trailing incomplete ANSI CSI escape sequence which can appear if we serialize
     * while a command is mid-output. Without this, an orphan ESC + '[' may render visibly as '^[['
     * upon restore because xterm can't reconstruct the intended final sequence.
     */
    // (Sanitization removed per design choice to avoid mutating raw terminal output)
}
