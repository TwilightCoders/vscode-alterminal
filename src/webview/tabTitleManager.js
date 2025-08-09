/**
 * Tab Title Manager
 * 
 * Purpose:
 * - Unified management of tab titles, icons, indicators, and dropdown menus  
 * - Handle tab icon type selection based on terminal type and commands
 * - Manage notification bells and activity states with proper precedence
 * - Create and manage dropdown menus for tab actions
 * - Handle tab title generation, updating, and inline editing
 * 
 * Responsibilities:
 * - Tab title creation, updating, and inline rename functionality
 * - Tab icon creation and type selection (rocket, robot, terminal, etc.)
 * - Notification bell management with pulsing animation
 * - Dropdown menu creation and interaction handling
 * - State management using bitmasks for efficiency
 * - Icon customization support for user preferences
 * - Template-based tab title generation with process detection
 * 
 * Key Features:
 * - Smart icon selection based on terminal/command patterns
 * - Unified notification system: bell > normal icon (no separate activity dots)
 * - Dropdown menu with save/settings/close actions
 * - Full keyboard accessibility support
 * - Inline tab title editing with double-click
 * - Template system for dynamic tab titles
 * - Integration with VS Code themes and styling
 */

class TabTitleManager {
    constructor(tabId, terminal, vscode, icon = 'codicon-terminal') {
        this.tabId = tabId;
        this.terminal = terminal;
        this.vscode = vscode;
        this.icon = icon;
        
        // State tracking using bitmasks
        this._state = 0;
        
        // State bit positions
        this.STATES = {
            NOTIFICATION: 1 << 0,  // Bell notification active
            DROPDOWN_OPEN: 1 << 1, // Dropdown menu is open
            CUSTOMIZED: 1 << 2,    // User has customized the icon
            EDITING: 1 << 3        // Title is being edited
        };

        // DOM references
        this.iconContainer = null;
        this.regularIcon = null;
        this.bellIcon = null;
        this.dropdown = null;
        this.labelElement = null;

        // Title management
        this.baseLabel = null; // Store original label before process updates
    }

    /**
     * Check if a specific state is active
     */
    hasState(stateBit) {
        return (this._state & stateBit) !== 0;
    }

    /**
     * Set a state bit
     */
    setState(stateBit) {
        this._state |= stateBit;
    }

    /**
     * Clear a state bit
     */
    clearState(stateBit) {
        this._state &= ~stateBit;
    }

    /**
     * Create the complete tab title structure (icon + label)
     */
    createTabTitle(label) {
        const tabFragment = document.createDocumentFragment();

        // Create icon container with dropdown
        this.iconContainer = this.createIconContainer(label);
        tabFragment.appendChild(this.iconContainer);

        // Create label element
        this.labelElement = this.createLabelElement(label);
        tabFragment.appendChild(this.labelElement);

        // Store base label for future updates
        this.baseLabel = label;

        return tabFragment;
    }

    /**
     * Create icon container with dropdown menu
     */
    createIconContainer(label) {
        const container = document.createElement('div');
        container.className = 'tab-icon';
        container.setAttribute('role', 'button');
        container.setAttribute('tabindex', '0');
        container.setAttribute('aria-label', `${label} menu`);
        container.setAttribute('title', `Click for ${label} options`);
        
        // Create regular type icon
        this.regularIcon = document.createElement('span');
        this.regularIcon.className = `codicon ${this.icon}`;
        container.appendChild(this.regularIcon);

        // Create notification bell (hidden by default)
        this.bellIcon = document.createElement('span');
        this.bellIcon.className = 'codicon codicon-bell-dot';
        this.bellIcon.style.display = 'none';
        container.appendChild(this.bellIcon);
        

        // Create dropdown menu as child of icon container
        this.dropdown = this.createDropdownMenu();
        container.appendChild(this.dropdown);

        // Set up event listeners
        this.setupEventListeners();

        return container;
    }

    /**
     * Create label element with editing support
     */
    createLabelElement(label) {
        const labelEl = document.createElement('span');
        labelEl.className = 'tab-label';
        labelEl.textContent = label;
        
        // Add right-click context menu
        labelEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showContextMenu(e.clientX, e.clientY);
        });
        
        return labelEl;
    }

    /**
     * Setup event listeners for icon interactions
     */
    setupEventListeners() {
        if (!this.iconContainer) return;

        // Icon click handler
        this.iconContainer.addEventListener('click', (e) => {
            e.stopPropagation();
            
            // If dropdown is open, close it
            if (this.hasState(this.STATES.DROPDOWN_OPEN)) {
                this.hideDropdown();
                return;
            }
            
            // Otherwise handle normal icon click logic
            this.handleIconClick();
        });

        // Keyboard support for icon
        this.iconContainer.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                
                // Same logic as click - check if dropdown is open first
                if (this.hasState(this.STATES.DROPDOWN_OPEN)) {
                    this.hideDropdown();
                } else {
                    this.handleIconClick();
                }
            }
        });

        // Dropdown item click handler
        if (this.dropdown) {
            this.dropdown.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = e.target.closest('.tab-dropdown-item')?.getAttribute('data-action');
                if (action) {
                    this.handleDropdownAction(action);
                }
            });

            // Dropdown keyboard navigation
            this.dropdown.addEventListener('keydown', (e) => {
                const currentItem = e.target;
                if (!currentItem.classList.contains('tab-dropdown-item')) return;

                switch (e.key) {
                    case 'ArrowDown':
                        e.preventDefault();
                        this.focusNextDropdownItem(currentItem);
                        break;
                    case 'ArrowUp':
                        e.preventDefault();
                        this.focusPrevDropdownItem(currentItem);
                        break;
                    case 'Enter':
                    case ' ':
                        e.preventDefault();
                        const action = currentItem.getAttribute('data-action');
                        if (action) {
                            this.handleDropdownAction(action);
                        }
                        break;
                    case 'Escape':
                        e.preventDefault();
                        this.hideDropdown();
                        this.iconContainer.focus();
                        break;
                }
            });
        }


        // Close dropdown when clicking outside (store reference for cleanup)
        this.documentClickHandler = (e) => {
            if (!this.dropdown?.contains(e.target) && !this.iconContainer?.contains(e.target)) {
                this.hideDropdown();
            }
        };
        document.addEventListener('click', this.documentClickHandler);
    }

    /**
     * Create dropdown menu with appropriate items
     */
    createDropdownMenu() {
        const dropdown = document.createElement('div');
        dropdown.className = 'tab-dropdown';

        // Save menu item (only for command tabs that aren't saved)
        if (this.isCommandTab()) {
            const saveItem = document.createElement('button');
            saveItem.className = 'tab-dropdown-item';
            saveItem.setAttribute('data-action', 'save');
            saveItem.innerHTML = '<span class="codicon codicon-save"></span>Save Command';
            
            // Check if command is already saved
            this.checkCommandSavedStatus(this.terminal.launchCommand, saveItem);
            dropdown.appendChild(saveItem);
        }

        // Settings menu item
        const settingsItem = document.createElement('button');
        settingsItem.className = 'tab-dropdown-item';
        settingsItem.setAttribute('data-action', 'settings');
        settingsItem.innerHTML = '<span class="codicon codicon-settings-gear"></span>Settings';
        dropdown.appendChild(settingsItem);

        // Close menu item
        const closeItem = document.createElement('button');
        closeItem.className = 'tab-dropdown-item';
        closeItem.setAttribute('data-action', 'close');
        closeItem.innerHTML = '<span class="codicon codicon-close"></span>Close Tab';
        dropdown.appendChild(closeItem);

        return dropdown;
    }

    /**
     * Check if this is a command tab
     */
    isCommandTab() {
        return this.terminal && this.terminal.launchCommand;
    }

    /**
     * Update tab label text
     */
    updateLabel(newLabel) {
        if (this.labelElement) {
            this.labelElement.textContent = newLabel;
            this.terminal.label = newLabel;
        }
    }

    /**
     * Generate tab title with template system  
     */
    generateTabTitle(processName = null) {
        const baseTabName = this.baseLabel || this.terminal.label.split(' •')[0] || 'Terminal';
        const cleanProcessName = processName && processName !== 'bash' && processName !== 'zsh' && processName !== 'sh' ? processName : null;
        
        // Simple template logic: "{n}{p? • {p}}"
        const newTitle = cleanProcessName ? `${baseTabName} • ${cleanProcessName}` : baseTabName;
        
        if (newTitle !== this.terminal.label) {
            this.updateLabel(newTitle);
        }
        
        return newTitle;
    }

    /**
     * Handle process name changes for dynamic tab labeling
     */
    handleProcessChange(processName) {
        // Store base label if not already stored
        if (!this.baseLabel) {
            this.baseLabel = this.terminal.label.split(' •')[0] || 'Terminal';
        }
        
        // Generate new title with process info
        this.generateTabTitle(processName);
    }

    /**
     * Start inline tab title editing
     */
    startTitleEdit() {
        if (!this.labelElement || this.hasState(this.STATES.EDITING)) {
            return;
        }

        const currentLabel = this.labelElement.textContent;
        
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
        
        this.setState(this.STATES.EDITING);
        
        // Focus and select all text
        requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
        
        // Event handlers
        const saveRename = () => {
            const newLabel = input.value.trim();
            if (newLabel && newLabel !== currentLabel) {
                this.updateLabel(newLabel);
                this.baseLabel = newLabel; // Update base label too
            }
            this.endTitleEdit(input, currentLabel);
        };
        
        const cancelRename = () => {
            this.endTitleEdit(input, currentLabel);
        };
        
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
        this.labelElement.style.display = 'none';
        this.labelElement.parentNode.insertBefore(input, this.labelElement);
    }

    /**
     * End inline title editing
     */
    endTitleEdit(inputElement, originalLabel) {
        // Remove input element
        if (inputElement.parentNode) {
            inputElement.parentNode.removeChild(inputElement);
        }
        
        // Show label element
        if (this.labelElement) {
            this.labelElement.style.display = '';
        }
        
        this.clearState(this.STATES.EDITING);
        
        // Notify parent for state saving
        if (this.onTitleChanged) {
            this.onTitleChanged(this.tabId);
        }
    }

    /**
     * Show notification bell (unified approach - no separate activity dots)
     */
    showNotification() {
        if (!this.iconContainer || this.hasState(this.STATES.NOTIFICATION)) {
            return;
        }

        // Don't show notification on active tabs
        const tab = this.iconContainer.closest('.tab');
        if (tab && tab.classList.contains('active')) {
            return;
        }


        // Hide regular icon and show pulsing bell
        if (this.regularIcon) {
            this.regularIcon.style.display = 'none';
        }
        if (this.bellIcon) {
            this.bellIcon.style.display = 'inline-block';
        }
        
        this.iconContainer.classList.add('notification');
        this.setState(this.STATES.NOTIFICATION);

        // Update accessibility
        this.iconContainer.setAttribute('title', 'New activity - click to view');
        this.iconContainer.setAttribute('aria-label', 'New activity notification');
    }

    /**
     * Hide notification bell and restore normal icon
     */
    hideNotification() {
        if (!this.iconContainer) {
            return;
        }


        // Always ensure regular icon is visible and bell is hidden
        if (this.regularIcon) {
            this.regularIcon.style.display = 'inline-block';
        }
        if (this.bellIcon) {
            this.bellIcon.style.display = 'none';
        }
        
        this.iconContainer.classList.remove('notification');
        this.clearState(this.STATES.NOTIFICATION);

        // Reset accessibility
        const label = this.terminal ? this.terminal.label : 'Terminal';
        this.iconContainer.setAttribute('title', `Click for ${label} options`);
        this.iconContainer.setAttribute('aria-label', `${label} menu`);
    }

    /**
     * Handle click on icon (notification vs menu logic)
     */
    handleIconClick() {
        if (this.hasState(this.STATES.NOTIFICATION)) {
            // Clicking notification bell switches to tab
            if (this.onNotificationClick) {
                this.onNotificationClick(this.tabId);
            }
        } else {
            // Normal menu behavior - just show dropdown (toggle logic handled in click handler)
            this.showDropdown();
        }
    }

    /**
     * Toggle dropdown menu visibility
     */
    toggleDropdown() {
        if (!this.dropdown) return;

        if (this.hasState(this.STATES.DROPDOWN_OPEN)) {
            this.hideDropdown();
        } else {
            this.showDropdown();
        }
    }

    /**
     * Show dropdown menu
     */
    showDropdown() {
        if (!this.dropdown || this.hasState(this.STATES.DROPDOWN_OPEN)) {
            return;
        }

        // Hide any other open dropdowns first
        TabTitleManager.hideAllDropdowns();

        // No positioning needed - dropdown is now positioned with CSS relative to its parent icon

        this.dropdown.classList.add('show');
        this.setState(this.STATES.DROPDOWN_OPEN);

        // Focus first item
        const firstItem = this.dropdown.querySelector('.tab-dropdown-item');
        if (firstItem) {
            firstItem.focus();
        }
    }

    /**
     * Hide dropdown menu
     */
    hideDropdown() {
        if (!this.dropdown || !this.hasState(this.STATES.DROPDOWN_OPEN)) {
            return;
        }

        this.dropdown.classList.remove('show');
        this.clearState(this.STATES.DROPDOWN_OPEN);
    }

    /**
     * Show context menu at specific position
     */
    showContextMenu(x, y) {
        // Hide any open dropdowns first
        TabTitleManager.hideAllDropdowns();
        
        // Create context menu (reuse dropdown but position at mouse)
        if (!this.dropdown) return;
        
        this.dropdown.style.position = 'fixed';
        this.dropdown.style.top = `${y}px`;
        this.dropdown.style.left = `${x}px`;
        this.dropdown.classList.add('show');
        this.setState(this.STATES.DROPDOWN_OPEN);
        
        // Focus first item
        const firstItem = this.dropdown.querySelector('.tab-dropdown-item');
        if (firstItem) {
            firstItem.focus();
        }
    }

    /**
     * Hide all dropdown menus (static method for global use)
     */
    static hideAllDropdowns() {
        const dropdowns = document.querySelectorAll('.tab-dropdown');
        dropdowns.forEach(dropdown => {
            dropdown.classList.remove('show');
        });
    }

    /**
     * Handle dropdown menu actions
     */
    handleDropdownAction(action) {
        switch (action) {
            case 'save':
                this.saveCommand();
                break;
            case 'settings':
                this.openSettings();
                break;
            case 'close':
                this.closeTab();
                break;
            default:
                console.warn('Unknown dropdown action:', action);
                break;
        }
        
        this.hideDropdown();
    }

    /**
     * Save command functionality
     */
    saveCommand() {
        if (!this.isCommandTab()) {
            return;
        }

        // Get current icon class (remove 'codicon-' prefix for storage)
        const currentIconClass = this.regularIcon ? 
            this.regularIcon.className.replace('codicon ', '').replace('codicon-', '') : 
            'rocket';

        this.vscode.postMessage({
            command: 'saveCommand',
            tabId: this.tabId,
            launchCommand: this.terminal.launchCommand,
            tabLabel: this.terminal.label,
            iconClass: currentIconClass
        });
    }

    /**
     * Open settings
     */
    openSettings() {
        this.vscode.postMessage({
            command: 'openSettings'
        });
    }

    /**
     * Close tab
     */
    closeTab() {
        this.vscode.postMessage({
            command: 'closeTab',
            tabId: this.tabId
        });
    }

    /**
     * Check if command is already saved
     */
    checkCommandSavedStatus(command, saveElement) {
        this.vscode.postMessage({
            command: 'checkCommandSaved',
            launchCommand: command
        });
        
        saveElement.setAttribute('data-command', command);
    }

    /**
     * Update save button visibility
     */
    updateSaveButtonVisibility(command, isSaved) {
        if (!this.dropdown) return;

        const saveItems = this.dropdown.querySelectorAll(`.tab-dropdown-item[data-action="save"][data-command="${command}"]`);
        saveItems.forEach(item => {
            if (isSaved) {
                item.classList.add('disabled');
                item.setAttribute('aria-hidden', 'true');
                item.style.display = 'none';
            } else {
                item.classList.remove('disabled');
                item.setAttribute('aria-hidden', 'false');
                item.style.display = 'flex';
            }
        });
    }

    /**
     * Set custom icon for this terminal and save to workspace
     */
    setCustomIcon(iconClass) {
        // Update the display immediately
        if (this.regularIcon && !this.hasState(this.STATES.NOTIFICATION)) {
            this.regularIcon.className = `codicon ${iconClass}`;
        }
        
        // Save tab state including new icon
        this.vscode.postMessage({
            command: 'updateTabIcon',
            tabId: this.tabId,
            iconClass: iconClass
        });
    }

    /**
     * Keyboard navigation for dropdown
     */
    focusNextDropdownItem(currentItem) {
        if (!this.dropdown) return;
        
        const items = this.dropdown.querySelectorAll('.tab-dropdown-item:not(.disabled)');
        const currentIndex = Array.from(items).indexOf(currentItem);
        const nextIndex = (currentIndex + 1) % items.length;
        
        items[nextIndex].focus();
    }

    /**
     * Keyboard navigation for dropdown
     */
    focusPrevDropdownItem(currentItem) {
        if (!this.dropdown) return;
        
        const items = this.dropdown.querySelectorAll('.tab-dropdown-item:not(.disabled)');
        const currentIndex = Array.from(items).indexOf(currentItem);
        const prevIndex = currentIndex === 0 ? items.length - 1 : currentIndex - 1;
        
        items[prevIndex].focus();
    }

    /**
     * Set callback for tab title changes
     */
    setTitleChangeCallback(callback) {
        this.onTitleChanged = callback;
    }

    /**
     * Set callback for notification clicks
     */
    setNotificationClickCallback(callback) {
        this.onNotificationClick = callback;
    }

    /**
     * Get current state for serialization
     */
    getState() {
        return {
            state: this._state,
            customIcons: Array.from(this.customIcons.entries()),
            baseLabel: this.baseLabel
        };
    }

    /**
     * Restore state from serialization
     */
    restoreState(state) {
        if (state && typeof state.state === 'number') {
            this._state = state.state;
        }
        
        if (state && Array.isArray(state.customIcons)) {
            this.customIcons = new Map(state.customIcons);
        }

        if (state && state.baseLabel) {
            this.baseLabel = state.baseLabel;
        }
    }

    /**
     * Cleanup resources
     */
    dispose() {
        // Remove document click handler
        if (this.documentClickHandler) {
            document.removeEventListener('click', this.documentClickHandler);
            this.documentClickHandler = null;
        }
        
        if (this.iconContainer) {
            this.iconContainer.remove();
        }
        if (this.labelElement) {
            this.labelElement.remove();
        }
        
        this.iconContainer = null;
        this.regularIcon = null;
        this.bellIcon = null;
        this.dropdown = null;
        this.labelElement = null;
        this.customIcons.clear();
        this.onTitleChanged = null;
        this.onNotificationClick = null;
    }
}
