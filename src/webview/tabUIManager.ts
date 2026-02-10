/**
 * Tab UI Manager
 *
 * Purpose:
 * - Handles all tab bar UI rendering and interactions
 * - Manages tab creation, activation, and visual updates
 * - Handles drag-and-drop reordering
 * - Manages dropdown menus and notifications
 *
 * Responsibilities:
 * - Create and update tab DOM elements
 * - Handle tab click, keyboard, and drag events
 * - Manage dropdown menu visibility and actions
 * - Show/hide notification indicators
 * - Support responsive layout CMD-mode styling
 *
 * Key Features:
 * - Event delegation for efficient tab interactions
 * - Accessibility support (ARIA, keyboard navigation)
 * - Clean separation from terminal logic
 */

import { TabTitleManager } from "./tabTitleManager.js";
import { Logger } from "./logger.js";

/**
 * Callbacks interface for TabUIManager
 */
export interface TabUIManagerCallbacks {
  // Tab operations
  switchToTab: (tabId: number) => void;
  closeTab: (tabId: number) => void;
  startTabRename: (tabId: number, labelElement: HTMLElement) => void;
  
  // Dropdown actions
  saveCommand: (tabId: number) => void;
  openTabSettings: (tabId: number) => void;
  
  // State management
  scheduleSaveState: (reason: string) => void;
  requestFormattedTitle: (tabId: number) => void;

  // Terminal access
  getTerminal: (tabId: number) => any;
  getSavedCommandsSet: () => Set<string>;
  getTitleManagers: () => Map<number, TabTitleManager>;
}

export class TabUIManager {
  private _callbacks: TabUIManagerCallbacks;
  private _windowBlurHandler: (() => void) | null = null;
  private _container: HTMLElement | null = null;

  constructor(callbacks: TabUIManagerCallbacks) {
    this._callbacks = callbacks;
  }

  /**
   * Initialize all UI event listeners
   */
  setup(): void {
    this.initializeEventListeners();
  }

  /**
   * Create a tab element in the tab bar
   */
  createTabElement(tabId: number, label: string, vscode: any): void {
    const tabList = document.querySelector(".tab-list");
    if (!tabList) return;

    // Get the terminal to check if it's a command tab
    const terminal = this._callbacks.getTerminal(tabId);
    const isCommandTab = terminal && terminal.launchCommand;

    // Create semantic list item for tab
    const tab = document.createElement("li");
    tab.className = "tab";
    tab.dataset.tabId = tabId.toString();
    tab.setAttribute("role", "tab");
    tab.setAttribute("tabindex", "0");
    tab.setAttribute("aria-selected", "false");
    tab.setAttribute("aria-label", `${label} tab`);

    // Set VS Code context for tab-specific context menu
    const savedCommandsSet = this._callbacks.getSavedCommandsSet();
    const isSaved =
      terminal?.launchCommand &&
      savedCommandsSet &&
      savedCommandsSet.has(terminal.launchCommand);
    tab.setAttribute(
      "data-vscode-context",
      JSON.stringify({
        webviewSection: "alterminal",
        contextType: "tab",
        tabId: tabId.toString(),
        terminalType: terminal?.launchCommand ? "command" : "shell",
        launchCommand: terminal?.launchCommand || null,
        savedCommand: !!isSaved,
        preventDefaultContextMenuItems: true,
      }),
    );

    // Enable drag and drop for tab reordering
    tab.setAttribute("draggable", "true");

    // Create TabTitleManager instance for this tab - pass icon directly
    const icon =
      terminal.icon ||
      (terminal.launchCommand ? "codicon-rocket" : "codicon-terminal");
    const tabTitleManager = new TabTitleManager(tabId, terminal, vscode, icon);

    // Store TabTitleManager instance for later use
    this._callbacks.getTitleManagers().set(tabId, tabTitleManager);

    // Set up callback for title changes (saves state after rename)
    tabTitleManager.setTitleChangeCallback((tabId) => {
      this._callbacks.requestFormattedTitle(tabId);
      this._callbacks.scheduleSaveState("titleChange");
    });

    // Create tab title (icon + label) using TabTitleManager
    const tabContent = tabTitleManager.createTabTitle(label);
    tab.appendChild(tabContent);

    // Append to the end of the tab list
    tabList.appendChild(tab);
  }

  /**
   * Update active tab UI
   */
  updateActiveTabUI(tabId: number): void {
    // Update all tabs to inactive state
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.remove("active");
      tab.setAttribute("aria-selected", "false");
      tab.setAttribute("tabindex", "-1");
    });

    // Set target tab to active state
    const targetTab = document.querySelector(`[data-tab-id="${tabId}"]`);
    if (targetTab) {
      targetTab.classList.add("active");
      targetTab.setAttribute("aria-selected", "true");
      targetTab.setAttribute("tabindex", "0");
    }
  }

  /**
   * Set up event listeners for tab interactions
   */
  private initializeEventListeners(): void {
    // Track CMD/Ctrl key for link cursor styling
    // Cache container reference to avoid repeated DOM queries on every keypress
    this._container = document.getElementById("container");
    document.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey) {
        this._container?.classList.add("cmd-mode");
      }
    });
    document.addEventListener("keyup", (e) => {
      if (!e.metaKey && !e.ctrlKey) {
        this._container?.classList.remove("cmd-mode");
      }
    });
    // Also handle focus loss (e.g., CMD+Tab away)
    this._windowBlurHandler = () => {
      this._container?.classList.remove("cmd-mode");
    };
    window.addEventListener("blur", this._windowBlurHandler);

    // Tab click and keyboard handlers (using event delegation)
    const tabBar = document.getElementById("tab-bar");
    if (tabBar) {
      // Keyboard navigation support
      tabBar.addEventListener("keydown", (e) => {
        const target = e.target as HTMLElement;
        if (
          target.classList.contains("tab") ||
          target.classList.contains("tab-close")
        ) {
          if (e.key === "Enter" || e.key === " ") {
            target.click();
            e.preventDefault();
          }
        }
      });

      // Click handlers
      tabBar.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        // Handle tab icon clicks (show dropdown or handle notification)
        if (
          target.classList.contains("tab-icon") ||
          target.parentElement?.classList.contains("tab-icon")
        ) {
          const icon = target.classList.contains("tab-icon")
            ? target
            : target.parentElement as HTMLElement;
          const tab = icon.closest(".tab");

          // If clicking on notification bell, switch to tab instead of showing dropdown
          if (icon.classList.contains("notification")) {
            const tabId = parseInt((tab as HTMLElement).dataset.tabId!);
            if (!isNaN(tabId)) {
              this._callbacks.switchToTab(tabId);
            }
          } else {
            // Normal menu behavior
            const dropdown = icon.querySelector(".tab-dropdown");
            if (dropdown) {
              this.toggleDropdown(dropdown);
            }
          }
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // Handle dropdown item clicks
        if (
          target.classList.contains("tab-dropdown-item") ||
          target.parentElement?.classList.contains("tab-dropdown-item")
        ) {
          const item = target.classList.contains("tab-dropdown-item")
            ? target
            : target.parentElement as HTMLElement;
          const action = item.getAttribute("data-action");
          const tab = item.closest(".tab") as HTMLElement;

          if (tab && tab.dataset.tabId) {
            const tabId = parseInt(tab.dataset.tabId);
            if (!isNaN(tabId)) {
              this.handleDropdownAction(action, tabId);
            }
          }

          // Close dropdown after action
          this.hideAllDropdowns();
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // Handle tab clicks for switching
        if (
          target.classList.contains("tab") ||
          target.parentElement?.classList.contains("tab")
        ) {
          const tab = target.classList.contains("tab")
            ? target
            : target.parentElement as HTMLElement;
          const tabId = parseInt(tab.dataset.tabId);
          if (!isNaN(tabId)) {
            this._callbacks.switchToTab(tabId);
          }
        }
      });

      // Double-click handler for tab renaming
      tabBar.addEventListener("dblclick", (e) => {
        const target = e.target as HTMLElement;
        // Handle double-clicks on tab labels for renaming
        if (target.classList.contains("tab-label")) {
          const tab = target.closest(".tab") as HTMLElement;
          if (tab && tab.dataset.tabId) {
            const tabId = parseInt(tab.dataset.tabId);
            if (!isNaN(tabId)) {
              this._callbacks.startTabRename(tabId, target);
            }
          }
          e.preventDefault();
          e.stopPropagation();
        }
      });

      // Keyboard handlers for accessibility
      tabBar.addEventListener("keydown", (e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains("tab")) {
          switch (e.key) {
            case "Enter":
            case " ":
              const tabId = parseInt(target.dataset.tabId!);
              if (!isNaN(tabId)) {
                this._callbacks.switchToTab(tabId);
              }
              e.preventDefault();
              break;
            case "Delete":
            case "Backspace":
              const deleteTabId = parseInt(target.dataset.tabId!);
              if (!isNaN(deleteTabId)) {
                this._callbacks.closeTab(deleteTabId);
              }
              e.preventDefault();
              break;
          }
        } else if (target.classList.contains("tab-icon")) {
          if (e.key === "Enter" || e.key === " ") {
            // If icon has notification, switch to tab instead of showing dropdown
            if (target.classList.contains("notification")) {
              const tab = target.closest(".tab") as HTMLElement;
              const tabId = parseInt(tab.dataset.tabId!);
              if (!isNaN(tabId)) {
                this._callbacks.switchToTab(tabId);
              }
            } else {
              const dropdown = target.querySelector(".tab-dropdown");
              if (dropdown) {
                this.toggleDropdown(dropdown);
              }
            }
            e.preventDefault();
          }
        } else if (target.classList.contains("tab-dropdown-item")) {
          switch (e.key) {
            case "Enter":
            case " ":
              const action = target.getAttribute("data-action");
              const tab = target.closest(".tab") as HTMLElement;
              if (tab && tab.dataset.tabId) {
                const tabId = parseInt(tab.dataset.tabId);
                if (!isNaN(tabId)) {
                  this.handleDropdownAction(action, tabId);
                }
              }
              this.hideAllDropdowns();
              e.preventDefault();
              break;
            case "Escape":
              this.hideAllDropdowns();
              e.preventDefault();
              break;
            case "ArrowDown":
              this.focusNextDropdownItem(e.target as HTMLElement);
              e.preventDefault();
              break;
            case "ArrowUp":
              this.focusPrevDropdownItem(e.target as HTMLElement);
              e.preventDefault();
              break;
          }
        }
      });

      // Drag and drop handlers for tab reordering
      this.setupTabDragHandlers(tabBar);
    }

    // Close dropdowns when clicking outside
    document.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (
        !target.closest(".tab-icon") &&
        !target.closest(".tab-dropdown")
      ) {
        this.hideAllDropdowns();
      }
    });
  }

  /**
   * Setup drag and drop handlers for tab reordering
   */
  private setupTabDragHandlers(tabBar: HTMLElement): void {
    let draggedTab: HTMLElement | null = null;
    let lastTargetTab: HTMLElement | null = null;
    let lastInsertBefore = false;

    tabBar.addEventListener("dragstart", (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains("tab")) {
        draggedTab = target;
        target.classList.add("dragging");
        e.dataTransfer!.effectAllowed = "move";
        e.dataTransfer!.setData("text/plain", target.dataset.tabId!);
      }
    });

    tabBar.addEventListener("dragend", (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains("tab")) {
        target.classList.remove("dragging");

        // Use the last target from dragover
        if (lastTargetTab && draggedTab && lastTargetTab !== draggedTab) {
          const tabList = lastTargetTab.parentElement;
          if (lastInsertBefore) {
            tabList!.insertBefore(draggedTab, lastTargetTab);
          } else {
            tabList!.insertBefore(draggedTab, lastTargetTab.nextSibling);
          }

          // Save the new tab order
          this._callbacks.scheduleSaveState("tabReorder");
        }

        // Clear all drag-over indicators
        document.querySelectorAll(".tab").forEach((tab) => {
          tab.classList.remove("drag-over-left", "drag-over-right");
        });

        // Reset state
        draggedTab = null;
        lastTargetTab = null;
        lastInsertBefore = false;
      }
    });

    tabBar.addEventListener("dragenter", (e) => {
      e.preventDefault();
    });

    tabBar.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!draggedTab) return;

      const target = e.target as HTMLElement;
      const targetTab = target.closest(".tab") as HTMLElement;
      if (!targetTab || targetTab === draggedTab) {
        return;
      }

      // Track the target for use in dragend
      lastTargetTab = targetTab;

      // Clear previous indicators
      document.querySelectorAll(".tab").forEach((tab) => {
        tab.classList.remove("drag-over-left", "drag-over-right");
      });

      // Determine which side to show the indicator
      const rect = targetTab.getBoundingClientRect();
      const midpoint = rect.left + rect.width / 2;

      lastInsertBefore = e.clientX < midpoint;

      if (lastInsertBefore) {
        targetTab.classList.add("drag-over-left");
      } else {
        targetTab.classList.add("drag-over-right");
      }

      e.dataTransfer!.dropEffect = "move";
    });
  }

  /**
   * Toggle dropdown visibility
   */
  toggleDropdown(dropdown: Element): void {
    // Hide other dropdowns first
    this.hideAllDropdowns();

    // Toggle the target dropdown
    dropdown.classList.toggle("show");

    // Focus the first item if opening
    if (dropdown.classList.contains("show")) {
      const firstItem = dropdown.querySelector(".tab-dropdown-item") as HTMLElement;
      if (firstItem) {
        firstItem.focus();
      }
    }
  }

  /**
   * Hide all dropdown menus
   */
  hideAllDropdowns(): void {
    const dropdowns = document.querySelectorAll(".tab-dropdown");
    dropdowns.forEach((dropdown) => {
      dropdown.classList.remove("show");
    });
  }

  /**
   * Handle dropdown menu actions
   */
  private handleDropdownAction(action: string | null, tabId: number): void {
    switch (action) {
      case "save":
        this._callbacks.saveCommand(tabId);
        break;
      case "settings":
        this._callbacks.openTabSettings(tabId);
        break;
      case "close":
        this._callbacks.closeTab(tabId);
        break;
      default:
        Logger.warn("Unknown dropdown action:", action);
        break;
    }
  }

  /**
   * Focus next dropdown item for keyboard navigation
   */
  private focusNextDropdownItem(currentItem: HTMLElement): void {
    const dropdown = currentItem.closest(".tab-dropdown");
    if (!dropdown) return;

    const items = dropdown.querySelectorAll(
      ".tab-dropdown-item:not(.disabled)",
    ) as NodeListOf<HTMLElement>;
    const currentIndex = Array.from(items).indexOf(currentItem);
    const nextIndex = (currentIndex + 1) % items.length;

    items[nextIndex].focus();
  }

  /**
   * Focus previous dropdown item for keyboard navigation
   */
  private focusPrevDropdownItem(currentItem: HTMLElement): void {
    const dropdown = currentItem.closest(".tab-dropdown");
    if (!dropdown) return;

    const items = dropdown.querySelectorAll(
      ".tab-dropdown-item:not(.disabled)",
    ) as NodeListOf<HTMLElement>;
    const currentIndex = Array.from(items).indexOf(currentItem);
    const prevIndex = currentIndex === 0 ? items.length - 1 : currentIndex - 1;

    items[prevIndex].focus();
  }

  /**
   * Show notification bell for a specific tab
   */
  showNotification(tabId: number): void {
    const titleManagers = this._callbacks.getTitleManagers();
    const tabTitleManager = titleManagers?.get(tabId);
    if (tabTitleManager) {
      tabTitleManager.showNotification();
    }
  }

  /**
   * Hide notification bell for a specific tab
   */
  hideNotification(tabId: number): void {
    const titleManagers = this._callbacks.getTitleManagers();
    const tabTitleManager = titleManagers?.get(tabId);
    if (tabTitleManager) {
      tabTitleManager.hideNotification();
    }
  }

  /**
   * Cleanup event listeners
   */
  dispose(): void {
    if (this._windowBlurHandler) {
      window.removeEventListener("blur", this._windowBlurHandler);
      this._windowBlurHandler = null;
    }
  }
}
