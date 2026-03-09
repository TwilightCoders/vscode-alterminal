import {
  hideAllDropdowns as hideDropdowns,
  focusNextDropdownItem as focusNextItem,
  focusPrevDropdownItem as focusPrevItem,
} from "./dropdownUtils.js";

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

export class TabTitleManager {
  public tabId: number;
  public terminal: any;
  public vscode: any;
  public icon: string;
  private _state: number;
  public STATES: {
    NOTIFICATION: number;
    CUSTOMIZED: number;
    EDITING: number;
    DROPDOWN_OPEN: number;
  };
  public iconContainer: HTMLElement | null;
  public regularIcon: HTMLElement | null;
  public bellIcon: HTMLElement | null;
  public labelElement: HTMLElement | null;
  public baseLabel: string | null;
  public dropdown: HTMLElement | null;
  private _titleChangeCallback?: (tabId: number) => void;
  public onTitleChanged?: (tabId: number) => void;
  public onNotificationClick?: () => void;

  constructor(tabId: number, terminal: any, vscode: any, icon: string = "codicon-terminal") {
    this.tabId = tabId;
    this.terminal = terminal;
    this.vscode = vscode;
    this.icon = icon;


    // State tracking using bitmasks
    this._state = 0;

    // State bit positions
    this.STATES = {
      NOTIFICATION: 1 << 0, // Bell notification active
      CUSTOMIZED: 1 << 1, // User has customized the icon
      EDITING: 1 << 2, // Title is being edited
      DROPDOWN_OPEN: 1 << 3, // Dropdown menu is open
    };

    // DOM references
    this.iconContainer = null;
    this.regularIcon = null;
    this.bellIcon = null;
    this.labelElement = null;
    this.dropdown = null;

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
   * Create icon container with context menu support
   */
  createIconContainer(label) {
    const container = document.createElement("div");
    container.className = "tab-icon";
    container.setAttribute("aria-label", `${label} terminal`);

    // Create regular type icon
    this.regularIcon = document.createElement("span");
    this.regularIcon.className = `codicon ${this.icon}`;
    container.appendChild(this.regularIcon);

    // Create notification bell (hidden by default)
    this.bellIcon = document.createElement("span");
    this.bellIcon.className = "codicon codicon-bell-dot";
    this.bellIcon.style.display = "none";
    container.appendChild(this.bellIcon);

    return container;
  }

  /**
   * Create label element with editing support
   */
  createLabelElement(label) {
    const labelEl = document.createElement("span");
    labelEl.className = "tab-label";
    labelEl.textContent = label;

    // Context menu is handled by the parent tab element

    return labelEl;
  }

  /**
   * Get the terminal type for context menu
   */
  getTerminalType() {
    if (this.terminal?.launchCommand) {
      return "command";
    }
    return "shell";
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
    const baseTabName =
      this.baseLabel || this.terminal.label.split(" •")[0] || "Terminal";
    const cleanProcessName =
      processName &&
      processName !== "bash" &&
      processName !== "zsh" &&
      processName !== "sh"
        ? processName
        : null;

    // Simple template logic: "{n}{p? • {p}}"
    const newTitle = cleanProcessName
      ? `${baseTabName} • ${cleanProcessName}`
      : baseTabName;

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
      this.baseLabel = this.terminal.label.split(" •")[0] || "Terminal";
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
    // Show the raw template for editing (fall back to rendered label)
    const rawTemplate = this.terminal?.titleTemplate || currentLabel;

    // Create input element
    const input = document.createElement("input");
    input.type = "text";
    input.value = rawTemplate;
    input.className = "tab-rename-input";
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
      const newTemplate = input.value.trim();
      if (newTemplate && newTemplate !== rawTemplate) {
        // Store the raw template on the terminal
        if (this.terminal) {
          this.terminal.titleTemplate = newTemplate;
          this.terminal.markDirty();
        }
      }
      this.endTitleEdit(input);
    };

    const cancelRename = () => {
      this.endTitleEdit(input);
    };

    input.addEventListener("blur", saveRename);
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        saveRename();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelRename();
      }
    });

    // Replace label with input
    this.labelElement.style.display = "none";
    this.labelElement.parentNode.insertBefore(input, this.labelElement);
  }

  /**
   * End inline title editing
   */
  endTitleEdit(inputElement) {
    // Remove input element
    if (inputElement.parentNode) {
      inputElement.parentNode.removeChild(inputElement);
    }

    // Show label element
    if (this.labelElement) {
      this.labelElement.style.display = "";
    }

    this.clearState(this.STATES.EDITING);

    // Notify parent for re-rendering and state saving
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
    const tab = this.iconContainer.closest(".tab");
    if (tab && tab.classList.contains("active")) {
      return;
    }

    // Hide regular icon and show pulsing bell
    if (this.regularIcon) {
      this.regularIcon.style.display = "none";
    }
    if (this.bellIcon) {
      this.bellIcon.style.display = "inline-block";
    }

    this.iconContainer.classList.add("notification");
    this.setState(this.STATES.NOTIFICATION);

    // Update accessibility
    this.iconContainer.setAttribute("title", "New activity - click to view");
    this.iconContainer.setAttribute("aria-label", "New activity notification");
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
      this.regularIcon.style.display = "inline-block";
    }
    if (this.bellIcon) {
      this.bellIcon.style.display = "none";
    }

    this.iconContainer.classList.remove("notification");
    this.clearState(this.STATES.NOTIFICATION);

    // Reset accessibility
    const label = this.terminal ? this.terminal.label : "Terminal";
    this.iconContainer.setAttribute("title", `Click for ${label} options`);
    this.iconContainer.setAttribute("aria-label", `${label} menu`);
  }

  /**
   * Handle click on icon (notification logic only)
   */
  handleIconClick(): void {
    if (this.hasState(this.STATES.NOTIFICATION)) {
      // Clicking notification bell switches to tab
      if (this.onNotificationClick) {
        this.onNotificationClick();
      }
    }
    // Context menu is now handled natively by VS Code
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

    this.dropdown.classList.add("show");
    this.setState(this.STATES.DROPDOWN_OPEN);

    // Focus first item
    const firstItem = this.dropdown.querySelector<HTMLElement>(".tab-dropdown-item");
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

    this.dropdown.classList.remove("show");
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

    this.dropdown.style.position = "fixed";
    this.dropdown.style.top = `${y}px`;
    this.dropdown.style.left = `${x}px`;
    this.dropdown.classList.add("show");
    this.setState(this.STATES.DROPDOWN_OPEN);

    // Focus first item
    const firstItem = this.dropdown.querySelector<HTMLElement>(".tab-dropdown-item");
    if (firstItem) {
      firstItem.focus();
    }
  }

  /**
   * Hide all dropdown menus (static method for global use)
   */
  static hideAllDropdowns() {
    hideDropdowns();
  }

  /**
   * Handle dropdown menu actions
   */
  handleDropdownAction(action) {
    switch (action) {
      case "save":
        this.saveCommand();
        break;
      case "settings":
        this.openSettings();
        break;
      case "close":
        this.closeTab();
        break;
      default:
        console.warn("Unknown dropdown action:", action);
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
    const currentIconClass = this.regularIcon
      ? this.regularIcon.className
          .replace("codicon ", "")
          .replace("codicon-", "")
      : "rocket";

    this.vscode.postMessage({
      command: "saveCommand",
      tabId: this.tabId,
      launchCommand: this.terminal.launchCommand,
      tabLabel: this.terminal.label,
      iconClass: currentIconClass,
    });
  }

  /**
   * Open settings
   */
  openSettings() {
    this.vscode.postMessage({
      command: "openSettings",
    });
  }

  /**
   * Close tab
   */
  closeTab() {
    this.vscode.postMessage({
      command: "closeTab",
      tabId: this.tabId,
    });
  }

  /**
   * Check if command is already saved
   */
  checkCommandSavedStatus(command, saveElement) {
    this.vscode.postMessage({
      command: "checkCommandSaved",
      launchCommand: command,
    });

    saveElement.setAttribute("data-command", command);
  }

  /**
   * Update save button visibility
   */
  updateSaveButtonVisibility(command: any, isSaved: any): void {
    if (!this.dropdown) return;

    const saveItems = this.dropdown.querySelectorAll<HTMLElement>(
      `.tab-dropdown-item[data-action="save"][data-command="${command}"]`,
    );
    saveItems.forEach((item) => {
      if (isSaved) {
        item.classList.add("disabled");
        item.setAttribute("aria-hidden", "true");
        item.style.display = "none";
      } else {
        item.classList.remove("disabled");
        item.setAttribute("aria-hidden", "false");
        item.style.display = "flex";
      }
    });
  }


  /**
   * Keyboard navigation for dropdown
   */
  focusNextDropdownItem(currentItem: HTMLElement): void {
    focusNextItem(this.dropdown, currentItem);
  }

  focusPrevDropdownItem(currentItem: HTMLElement): void {
    focusPrevItem(this.dropdown, currentItem);
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
      baseLabel: this.baseLabel,
    };
  }

  /**
   * Restore state from serialization
   */
  restoreState(state) {
    if (state && typeof state.state === "number") {
      this._state = state.state;
    }

    if (state && state.baseLabel) {
      this.baseLabel = state.baseLabel;
    }
  }

  /**
   * Set the icon for this tab
   */
  setIcon(iconClass) {
    // Convert from $(iconname) format to codicon-iconname
    let newIcon = iconClass;
    if (iconClass.startsWith("$(") && iconClass.endsWith(")")) {
      const iconName = iconClass.slice(2, -1);
      newIcon = `codicon-${iconName}`;
    }

    this.icon = newIcon;

    // Update the regular icon element if it exists
    if (this.regularIcon) {
      this.regularIcon.className = `codicon ${this.icon}`;
    }

    // Mark as customized
    this.setState(this.STATES.CUSTOMIZED);
  }

  /**
   * Cleanup resources
   */
  dispose() {
    if (this.iconContainer) {
      this.iconContainer.remove();
    }
    if (this.labelElement) {
      this.labelElement.remove();
    }

    this.iconContainer = null;
    this.regularIcon = null;
    this.bellIcon = null;
    this.labelElement = null;
    this.onTitleChanged = null;
    this.onNotificationClick = null;
  }
}
