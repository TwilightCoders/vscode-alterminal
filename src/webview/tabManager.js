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
        
        // Initialize everything
        this.initializeEventListeners();
        this.setupResponsiveLayout();
        this.setupMessageHandling();
        this.setupWindowEventHandlers();
        this.autoInitialize();
        
        // Signal to extension that webview is ready
        setTimeout(() => {
            this.vscode.postMessage({ command: 'webviewReady' });
        }, 50);
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
                        Logger.debug('🔄 Received restoreState command with state:', message.state);
                        Logger.debug('🔄 Current terminals before restore:', this.terminals.size);
                        
                        // Try webview state first, then fall back to extension state
                        const webviewState = vscode.getState();
                        if (webviewState && webviewState.fullTabState) {
                            Logger.debug('🔄 Using webview state (more recent)');
                            this.restoreFromState(webviewState.fullTabState);
                        } else if (message.state) {
                            Logger.debug('🔄 Using extension state (fallback)');
                            this.restoreFromState(message.state);
                        } else {
                            Logger.debug('🔄 No state available, creating default');
                            this.restoreFromState(this.createDefaultState());
                        }
                        break;
                        
                    case 'initializeEmpty':
                        Logger.debug('🆕 Received initializeEmpty command - checking for existing state');
                        
                        // Check if we have webview state before creating empty
                        const existingState = vscode.getState();
                        if (existingState && existingState.fullTabState) {
                            Logger.debug('🔄 Found existing webview state, restoring instead of creating empty');
                            this.restoreFromState(existingState.fullTabState);
                        } else {
                            Logger.debug('🆕 No existing state, creating default terminal');
                            const defaultState = this.createDefaultState();
                            this.restoreFromState(defaultState);
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
                        
                    case 'refresh':
                        location.reload();
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
                        
                    default:
                        Logger.warn('Unknown command received:', message.command);
                        break;
                }
            } catch (error) {
                Logger.error('Message handling error:', error);
            }
        });
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
            setTimeout(() => {
                const activeTerminal = this.getActiveTerminal();
                if (activeTerminal) {
                    activeTerminal.fit();
                }
            }, 100);
        });
        
        // Setup keyboard shortcut passthrough
        this.setupKeyboardPassthrough();
    }
    
    /**
     * Auto-initialize - just setup, restoration will handle terminal creation
     */
    autoInitialize() {
        // Just show the interface, terminal creation will happen via restoration
        setTimeout(() => {
            this.showInterface();
        }, 100);
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
        
        // Focus and select all text
        setTimeout(() => {
            input.focus();
            input.select();
        }, 0);
        
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
        
        for (const [id, terminal] of this.terminals) {
            const terminalData = {
                id: terminal.id,
                label: terminal.label,
                rawContent: terminal.serialize() || '',
                terminalType: terminal.terminalType || 'claude'
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
    restoreFromState(savedState) {
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
        for (const terminalData of savedState.terminals) {
            Logger.debug('🔄 Creating terminal from state:', { id: terminalData.id, label: terminalData.label, type: terminalData.terminalType });
            Logger.debug('🔄 About to create TerminalInstance from restore...');
            const terminal = new TerminalInstance(
                terminalData.id, 
                terminalData.label, 
                this.vscode, 
                this.terminalTheme, 
                this.getThemeColor,
                terminalData.terminalType || 'claude'
            );
            Logger.debug('🔄 TerminalInstance created from restore:', terminal);
            
            // Create container and attach
            const container = this.createTerminalContainer(terminalData.id);
            terminal.attachToContainer(container);
            
            // Restore terminal content using new format
            terminal.label = terminalData.label;
            terminal.terminalType = terminalData.terminalType || 'claude';
            
            if (terminalData.rawContent) {
                Logger.debug('🔄 Restoring content for terminal', terminalData.id, 'with content length:', terminalData.rawContent.length);
                
                // Add delay for first terminal to avoid race condition with PTY initialization
                const isFirstTerminal = Array.from(this.terminals.keys()).length === 0;
                const delay = isFirstTerminal ? 200 : 50; // Longer delay for first terminal
                
                setTimeout(() => {
                    Logger.debug(`🔄 Actually restoring terminal ${terminalData.id} after ${delay}ms delay`);
                    
                    // Add "History restored" message with timestamp for all terminals with content
                    if (terminalData.rawContent) {
                        const now = new Date();
                        const timeString = now.toLocaleTimeString();
                        // Ensure proper newline separation to avoid content collision
                        const ensureNewline = terminalData.rawContent.endsWith('\n') || terminalData.rawContent.endsWith('\r\n') ? '' : '\r\n';
                        const contentWithMessage = terminalData.rawContent + ensureNewline + `\r\n\x1b[36m* History restored at ${timeString}\x1b[0m\r\n`;
                        terminal.deserialize(contentWithMessage);
                    } else {
                        // No content to restore
                        terminal.deserialize(terminalData.rawContent);
                    }
                }, delay);
                
                // Terminal will naturally show a fresh prompt after content restoration
            }
            
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
        
        // Mark as initialized after successful restoration
        this.isInitialized = true;
        
        
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
            vscode.setState({
                fullTabState: fullState,
                timestamp: Date.now()
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
        setTimeout(() => {
            const rect = container.getBoundingClientRect();
            this.updateTabLayout(rect);
        }, 100);
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
        setTimeout(() => {
            const activeTerminal = this.getActiveTerminal();
            if (activeTerminal) {
                activeTerminal.fit();
            }
        }, 100);
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
     * Dispose of all terminals and cleanup
     */
    dispose() {
        for (const [id, terminal] of this.terminals) {
            terminal.dispose();
        }
        this.terminals.clear();
    }
}