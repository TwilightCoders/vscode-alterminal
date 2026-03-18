import { TerminalInstance } from "./terminal.js";
import { TabTitleManager } from "./tabTitleManager.js";
import { Logger } from "./logger.js";
import { MessageHandler, MessageHandlerCallbacks } from "./messageHandler.js";
import { KeyboardManager } from "./keyboardManager.js";
import { TabUIManager, TabUIManagerCallbacks } from "./tabUIManager.js";
import { LayoutManager, LayoutManagerCallbacks } from "./layoutManager.js";
import { Debouncer } from "../utils/debouncer.js";

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

export class TabManager {
  public vscode: any;
  public terminalTheme: any;
  public getThemeColor: (cssVar: string, fallback: string) => string;
  public terminals: Map<number, any>;
  public titleManagers: Map<number, any>;
  public activeTabId: number | null;
  public nextTabId: number;
  public isInitialized: boolean;
  private _savedCommandsSet: Set<string>;
  private _historyBannerShownEver: boolean;
  private _alwaysShowTabs: boolean;
  private _initTimeoutId: ReturnType<typeof setTimeout> | null;
  private _messageHandler: MessageHandler;
  private _keyboardManager: KeyboardManager;
  private _tabUIManager: TabUIManager;
  private _layoutManager: LayoutManager;
  private _visibilityHandler: (() => void) | null = null;
  private _dirtySaveTimer: ReturnType<typeof setInterval> | null = null;
  private _pendingTitleOpts = new Map<number, Record<string, any>>();

  constructor(vscode: any, terminalTheme: any, getThemeColor: (cssVar: string, fallback: string) => string) {
    this.vscode = vscode;
    this.terminalTheme = terminalTheme;
    this.getThemeColor = getThemeColor;

    // Tab title rendering is now handled by the extension host

    // Collection of terminal wrappers
    this.terminals = new Map();
    this.titleManagers = new Map(); // Collection of tab title managers
    this.activeTabId = null;
    this.nextTabId = 1;
    this.isInitialized = false;
    // Track saved commands to set context flag even if list arrives before tabs created
    this._savedCommandsSet = new Set();
    // Cold/warm restore tracking (minimal)
    this._historyBannerShownEver = false; // persisted (via vscode.setState) across webview instances to avoid re-showing banner

    // Configuration settings
    this._alwaysShowTabs = false;

    this._initTimeoutId = null;

    // Initialize message handler with callbacks
    this._messageHandler = new MessageHandler(vscode, this._createMessageCallbacks());
    this._messageHandler.setup();

    // Initialize keyboard manager for shortcuts
    this._keyboardManager = new KeyboardManager({
      clearActiveTerminal: () => this.clearActiveTerminal(),
      resetActiveTerminal: () => this.resetActiveTerminal(),
    });
    this._keyboardManager.setup();

    // Initialize tab UI manager for tab bar interactions
    this._tabUIManager = new TabUIManager(this._createTabUICallbacks());
    this._tabUIManager.setup();

    // Initialize layout manager for responsive layout and window events
    this._layoutManager = new LayoutManager(this._createLayoutCallbacks());
    this._layoutManager.setupResponsiveLayout();
    this._layoutManager.setupWindowEventHandlers();

    // Set up visibility change handler to flush any pending save when hidden
    this._visibilityHandler = () => {
      if (document.hidden) {
        Logger.debug("📤 Page becoming hidden - flushing pending state save");
        try {
          Debouncer.flush("global-state-save");
        } catch (e) {
          Logger.error("Failed to flush state on visibility change:", e);
        }
      }
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);

    // Periodic dirty-check: persist terminal buffers that changed since last save.
    // This replaces per-write() Debouncer calls — instead of churning browser
    // timers on every PTY echo, we just check every 5 seconds whether any
    // terminal's isDirty flag is set.
    this._dirtySaveTimer = setInterval(() => {
      if (this._hasDirtyTerminals()) {
        this.scheduleSaveState("dirtyCheck");
      }
    }, 5000);

    // Signal that webview is ready and request state
    // Using a regular message (not queueMicrotask) ensures the handler is registered
    // The extension will respond with restoreState or initializeEmpty
    this.vscode.postMessage({ command: "webviewReady" });

    // Fallback: if no state arrives within 5 seconds, create a default terminal
    // This handles edge cases where extension message is lost
    this._initTimeoutId = setTimeout(() => {
      if (this.terminals.size === 0) {
        Logger.warn("⏰ Init timeout - no state received, creating default terminal");
        this.restoreFromState(this.createDefaultState(), true);
      }
    }, 5000);

    // Performance samples storage
    window.__terminalPerf = window.__terminalPerf || { samples: [] };
  }

  /**
   * Create callbacks for MessageHandler
   */
  private _createMessageCallbacks(): MessageHandlerCallbacks {
    return {
      saveAllStates: () => this.saveAllStates(),
      saveToLocalState: () => this.saveToLocalState(),
      restoreFromState: (state, isCold) => this.restoreFromState(state, isCold),
      createDefaultState: () => this.createDefaultState(),
      getActiveTerminal: () => this.getActiveTerminal(),
      getTerminals: () => this.terminals,
      writeToTerminal: (tabId, data) => this.writeToTerminal(tabId, data),
      ensureInitialized: () => this.ensureInitialized(),
      createNewTab: (type, cmd, cwd, shellPath) => this.createNewTab(type, cmd, cwd, shellPath),
      closeTab: (tabId) => this.closeTab(tabId),
      switchToTab: (tabId) => this.switchToTab(tabId),
      updateTabLabel: (tabId, label) => this.updateTabLabel(tabId, label),
      startTabRename: (tabId) => this.startTabRename(tabId),
      setTabIcon: (tabId, icon) => this.setTabIcon(tabId, icon),
      handleGetTabBuffer: (tabId) => this.handleGetTabBuffer(tabId),
      updateTabBarVisibility: () => this.updateTabBarVisibility(),
      updateSaveButtonVisibility: (cmd, saved) => this.updateSaveButtonVisibility(cmd, saved),
      resetActiveTerminal: () => this.resetActiveTerminal(),
      handleProcessChange: (name, tabId) => this.handleProcessChange(name, tabId),
      handleCwdChange: (cwd, tabId) => this.handleCwdChange(cwd, tabId),
      handleUserVarChange: (vars, tabId) => this.handleUserVarChange(vars, tabId),
      scheduleSaveState: (reason) => this.scheduleSaveState(reason),
      getSavedCommandsSet: () => this._savedCommandsSet,
      setSavedCommandsSet: (set) => { this._savedCommandsSet = set; },
      getHistoryBannerShownEver: () => this._historyBannerShownEver,
      setHistoryBannerShownEver: (val) => { this._historyBannerShownEver = val; },
      setAlwaysShowTabs: (val) => { this._alwaysShowTabs = val; },
      findTabIdByCommand: (cmd) => this._findTabIdByCommand(cmd),
      reportPerformance: () => this._reportPerformance(),
      saveActiveCommand: () => { if (this.activeTabId !== null) this.saveCommand(this.activeTabId); },
    };
  }

  /**
   * Create callbacks for TabUIManager
   */
  private _createTabUICallbacks(): TabUIManagerCallbacks {
    return {
      switchToTab: (tabId) => this.switchToTab(tabId),
      closeTab: (tabId) => this.closeTab(tabId),
      startTabRename: (tabId, labelElement) => this.startTabRename(tabId, labelElement),
      saveCommand: (tabId) => this.saveCommand(tabId),
      openTabSettings: (tabId) => this.openTabSettings(tabId),
      scheduleSaveState: (reason) => this.scheduleSaveState(reason),
      requestFormattedTitle: (tabId) => this.requestFormattedTitle(tabId),
      getTerminal: (tabId) => this.terminals.get(tabId),
      getSavedCommandsSet: () => this._savedCommandsSet,
      getTitleManagers: () => this.titleManagers,
    };
  }

  /**
   * Create callbacks for LayoutManager
   */
  private _createLayoutCallbacks(): LayoutManagerCallbacks {
    return {
      getActiveTerminal: () => this.getActiveTerminal(),
      saveToLocalState: () => this.saveToLocalState(),
      scheduleSaveState: (reason) => this.scheduleSaveState(reason),
      onPanelFocused: () => {
        this.vscode.postMessage({ command: "panelFocused" });
      },
    };
  }

  private _wireBellHandler(terminal: TerminalInstance): void {
    terminal.onBellReceived = (id: number) => {
      // No notification if user is focused on the originating terminal
      if (terminal.isActive) return;

        this._tabUIManager.showNotification(id);

      // Notify extension host (for window title indicator + toast)
      const t = this.terminals.get(id);
      this.vscode.postMessage({
        command: "playBellSound",
        tabId: id,
        tabLabel: t?.label || `Tab ${id}`,
      });
    };
  }

  _findTabIdByCommand(cmd: string | null): number | null {
    if (!cmd) return null;
    for (const [id, term] of this.terminals) {
      if (term.launchCommand === cmd) return id;
    }
    return null;
  }

  _recordTerminalTiming(id) {
    try {
      const initStart = performance.getEntriesByName(`t${id}-init-start`)[0];
      const openMark = performance.getEntriesByName(`t${id}-open`)[0];
      const activeTime = performance.getEntriesByName(`t${id}-active`)[0];
      if (initStart && openMark) {
        const initToOpen = openMark.startTime - initStart.startTime;
        const openToActive = activeTime
          ? activeTime.startTime - openMark.startTime
          : null;
        window.__terminalPerf.samples.push({ id, initToOpen, openToActive });
      }
    } catch (e) {
      /* ignore */
    }
  }

  _reportPerformance() {
    const samples = window.__terminalPerf.samples || [];
    if (!samples.length) {
      this.vscode.postMessage({
        command: "performanceReport",
        data: { count: 0, samples: [] },
      });
      return;
    }
    const initVals = samples.map((s) => s.initToOpen).filter((n) => n != null);
    const openVals = samples
      .map((s) => s.openToActive)
      .filter((n) => n != null);
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    this.vscode.postMessage({
      command: "performanceReport",
      data: {
        count: samples.length,
        avgInit: initVals.length ? avg(initVals) : 0,
        avgOpenToActive: openVals.length ? avg(openVals) : 0,
        samples,
      },
    });
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
   * Initialize - just show interface, terminal creation happens via restoration
   */
  initialize() {
    // Show the main interface and hide loading screen
    this._layoutManager.showInterface();
    this.isInitialized = true;
  }

  /**
   * Create a new terminal tab
   */
  createNewTab(terminalType = "default", launchCommand = null, cwd: string | null = null, shellPath: string | null = null) {
    // Clear init timeout since we're getting messages from extension
    if (this._initTimeoutId) {
      clearTimeout(this._initTimeoutId);
      this._initTimeoutId = null;
    }

    // Show interface if not already shown
    this._layoutManager.showInterface();

    Logger.debug(
      "📝 createNewTab called with type:",
      terminalType,
      "command:",
      launchCommand,
    );
    const tabId = this.nextTabId++;

    // Generate label based on terminal type and launch command
    let label;
    switch (terminalType) {
      case "shell":
        label = shellPath ? shellPath.split("/").pop() || "Shell" : "Shell";
        break;
      case "command":
        if (launchCommand) {
          // Use first word of command as label
          const commandName = launchCommand.split(" ")[0];
          label = commandName.charAt(0).toUpperCase() + commandName.slice(1);
        } else {
          label = "Command";
        }
        break;
      case "default":
      default:
        label = shellPath ? shellPath.split("/").pop() || "Terminal" : "Terminal";
        break;
    }

    // Create unified terminal instance (handles both frontend and backend)
    const terminal = new TerminalInstance(
      tabId,
      label,
      this.vscode,
      this.terminalTheme,
      this.getThemeColor,
      terminalType,
      { launchCommand, cwd, shellPath },
    );
    Logger.debug("🏗️ TerminalInstance created successfully:", terminal);

    // Create container and attach terminal
    const container = this.createTerminalContainer(tabId);
    terminal.attachToContainer(container);

    // Store the terminal
    this.terminals.set(tabId, terminal);

    this._wireBellHandler(terminal);

    // Create tab DOM element
    this._tabUIManager.createTabElement(tabId, label, this.vscode);

    // Ask extension to format the initial title using user template
    try {
  this.requestFormattedTitle(tabId);
    } catch (e) {
      Logger.warn("Operation failed:", e);
    }

    // Set as active if first tab, otherwise switch to it
    if (this.activeTabId === null) {
      this.activeTabId = tabId;
      terminal.setActive(true);
      this._tabUIManager.updateActiveTabUI(tabId);
    } else {
      this.switchToTab(tabId);
    }

    // Update tab bar visibility
    this.updateTabBarVisibility();

    // Persist state after creating a new tab
    try {
      this.scheduleSaveState("createNewTab");
    } catch (e) {
      Logger.warn("Failed to schedule save after createNewTab", e);
    }
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
    this._tabUIManager.updateActiveTabUI(tabId);
    this.activeTabId = tabId;

    // Clear notifications for the newly active tab
    this._tabUIManager.hideNotification(tabId);

    // Schedule save reflecting activeTabId change
    try {
      this.scheduleSaveState("switchToTab");
    } catch (e) {
      Logger.warn("Failed to schedule save after switchToTab", e);
    }
  }

  /**
   * Close a specific tab
   */
  closeTab(tabId) {
    if (this.terminals.size <= 1) return; // Don't close last tab

    const terminal = this.terminals.get(tabId);
    if (!terminal) return;

    // Notify extension to clean up buffer storage for this terminal's UUID
    if (terminal.uuid) {
      try {
        this.vscode.postMessage({
          command: "bufferDelete",
          uuid: terminal.uuid,
        });
      } catch (e) {
        Logger.warn("Failed to send buffer delete message:", e);
      }
    }

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

    // Persist state after closing a tab
    try {
      this.scheduleSaveState("closeTab");
    } catch (e) {
      Logger.warn("Failed to schedule save after closeTab", e);
    }
  }

  /**
   * Save command from a command tab to the saved commands
   */
  saveCommand(tabId) {
    const terminal = this.terminals.get(tabId);
    if (!terminal || !terminal.launchCommand) {
      Logger.warn(
        "Cannot save command: terminal not found or not a command tab",
      );
      return;
    }

    // Send command to extension host for saving via CommandManager
    this.vscode.postMessage({
      command: "saveCommand",
      tabId: tabId,
      launchCommand: terminal.launchCommand,
      tabLabel: terminal.label,
    });

    // Provide visual feedback
    Logger.info(`Saving command: ${terminal.launchCommand}`);

    // Update save button visibility for all tabs after saving
    this.updateAllSaveButtonsVisibility();
  }

  /**
   * Check if a command is already saved and update save button visibility
   */
  checkCommandSavedStatus(command, saveElement) {
    // Request saved commands from extension
    this.vscode.postMessage({
      command: "checkCommandSaved",
      launchCommand: command,
    });

    // Store element reference for later update
    saveElement.setAttribute("data-command", command);
  }

  /**
   * Update save button visibility for a specific command
   */
  updateSaveButtonVisibility(command: any, isSaved: any): void {
    // Handle save items in dropdowns only (no more tab bar save buttons)
    const allSaveItems = document.querySelectorAll<HTMLElement>(
      `.tab-dropdown-item[data-action="save"]`,
    );
    const dropdownSaveItems = Array.from(allSaveItems).filter(
      (el) => el.dataset.command === command,
    );
    dropdownSaveItems.forEach((item) => {
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
   * Update all save buttons visibility after commands change
   */
  updateAllSaveButtonsVisibility() {
    // Update dropdown save items only (no more tab-bar save buttons)
    const dropdownSaveItems = document.querySelectorAll(
      '.tab-dropdown-item[data-action="save"][data-command]',
    );
    dropdownSaveItems.forEach((item) => {
      const command = item.getAttribute("data-command");
      if (command) {
        this.checkCommandSavedStatus(command, item);
      }
    });
  }

  /**
   * Update tab bar visibility based on number of tabs
   */
  updateTabBarVisibility() {
    const tabBar = document.getElementById("tab-bar");
    if (!tabBar) return;

    // Always show tabs if the setting is enabled, otherwise hide when there's only one tab
    if (this._alwaysShowTabs) {
      tabBar.style.display = "";
    } else if (this.terminals.size <= 1) {
      tabBar.style.display = "none";
    } else {
      tabBar.style.display = "";
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
   * Reset active terminal to fix display corruption
   */
  resetActiveTerminal() {
    const activeTerminal = this.getActiveTerminal();
    if (activeTerminal && typeof activeTerminal.resetTerminal === 'function') {
      activeTerminal.resetTerminal();
    }
  }

  /**
   * Reset specific terminal by ID
   */
  resetTerminal(tabId) {
    const terminal = this.terminals.get(tabId);
    if (terminal && typeof terminal.resetTerminal === 'function') {
      terminal.resetTerminal();
    }
  }

  /**
   * Update tab label
   */
  updateTabLabel(tabId, label) {
    const terminal = this.terminals.get(tabId);
    if (terminal) {
      terminal.label = label;
      terminal.markDirty(); // Mark dirty when label changes

      const tabElement = document.querySelector(
        `[data-tab-id="${tabId}"] .tab-label`,
      );
      if (tabElement) {
        tabElement.textContent = label;
      }
    }
  }

  /**
   * Start inline tab renaming (delegates to TabTitleManager)
   */
  startTabRename(tabIdOrLabelElement, labelElement = null) {
    // Handle both old signature (tabId, labelElement) and new signature (tabId)
    let tabId;
    if (typeof tabIdOrLabelElement === "number") {
      tabId = tabIdOrLabelElement;
    } else {
      // Old double-click signature - extract tabId from label element
      const tabElement = tabIdOrLabelElement.closest(".tab");
      if (tabElement && tabElement.dataset.tabId) {
        tabId = parseInt(tabElement.dataset.tabId);
        labelElement = tabIdOrLabelElement;
      } else {
        Logger.warn("Cannot determine tab ID for rename");
        return;
      }
    }

    const titleManager = this.titleManagers.get(tabId);
    if (!titleManager) {
      Logger.warn(
        `Cannot start rename: TabTitleManager not found for tab ${tabId}`,
      );
      return;
    }

    // Delegate to TabTitleManager which already has this functionality
    titleManager.startTitleEdit();
  }

  setTabIcon(tabId, icon) {
    const titleManager = this.titleManagers.get(tabId);
    if (!titleManager) {
      Logger.warn(
        `Cannot set icon: TabTitleManager not found for tab ${tabId}`,
      );
      return;
    }

    const terminal = this.terminals.get(tabId);
    if (!terminal) {
      Logger.warn(`Cannot set icon: terminal ${tabId} not found`);
      return;
    }

    // Convert from $(iconname) format to codicon-iconname for storage
    let iconClass = icon;
    if (icon.startsWith("$(") && icon.endsWith(")")) {
      const iconName = icon.slice(2, -1);
      iconClass = `codicon-${iconName}`;
    }

    // Update terminal's icon property for persistence
    terminal.icon = iconClass;
    terminal.markDirty(); // Mark dirty when icon changes

    // Update UI via TabTitleManager
    titleManager.setIcon(icon);

    // Save state after icon change
    this.saveToLocalState();
  }

  handleGetTabBuffer(tabId) {
    const terminal = this.terminals.get(tabId);
    if (!terminal) {
      Logger.warn(`Cannot get buffer: terminal ${tabId} not found`);
      this.vscode.postMessage({
        command: "bufferContent",
        tabId: tabId,
        buffer: "",
      });
      return;
    }

    const buffer = terminal.serialize() || "";

    // Send buffer back to extension
    this.vscode.postMessage({
      command: "bufferContent",
      tabId: tabId,
      buffer: buffer,
    });
  }

  /**
   * Save state of all terminals (using WebviewViewSerializer format)
   */
  saveAllStates() {
    Logger.debug(
      "TabManager.saveAllStates() - Current terminals:",
      this.terminals.size,
    );
    const terminals = [];
    // Map prior persisted buffer by id so we don't erase history when serialize is suppressed
    let priorContentById = new Map();
    try {
      const priorState = vscode.getState && vscode.getState();
      if (
        priorState &&
        priorState.fullTabState &&
        Array.isArray(priorState.fullTabState.terminals)
      ) {
        for (const t of priorState.fullTabState.terminals) {
          // Support both old and new property names during migration
          priorContentById.set(t.id, t.buffer || "");
        }
      }
    } catch (e) {
      Logger.warn("Could not read prior state for preservation:", e);
    }

    // Get tabs in DOM order to preserve user's reordering
    const tabElements = document.querySelectorAll<HTMLElement>(".tab");
    const tabIdsInOrder = Array.from(tabElements)
      .map((tab) => parseInt(tab.dataset.tabId ?? "0", 10))
      .filter((id) => !isNaN(id));

    // Iterate in DOM order instead of Map order
    for (const id of tabIdsInOrder) {
      const terminal = this.terminals.get(id);
      if (!terminal) continue;

      // getState() calls serialize() internally for eligible terminals.
      // For empty results, fall back to previously persisted buffer content.
      const terminalData = terminal.getState();

      if (!terminal.launchCommand && !terminalData.buffer && priorContentById.has(id)) {
        const preserved = priorContentById.get(id);
        if (preserved && preserved.length > 0) {
          Logger.debug(
            `🛟 Preserving prior snapshot for terminal ${id} (len=${preserved.length}) due to empty serialize()`,
          );
          terminalData.buffer = preserved;
        }
      }

      // Get icon from title manager
      const titleManager = this.titleManagers.get(id);
      if (titleManager && titleManager.icon) {
        terminalData.icon = titleManager.icon;
      }

      terminals.push(terminalData);
    }

    const state = {
      terminals: terminals,
      activeTabId: this.activeTabId,
      timestamp: Date.now(),
    };

    Logger.debug("Final state being saved:", {
      terminalCount: terminals.length,
      activeTabId: this.activeTabId,
    });
    return state;
  }

  /**
   * Create a default state with one terminal
   */
  createDefaultState() {
    return {
      terminals: [
        {
          id: 1,
          label: "Terminal",
          buffer: "", // unified property name for serialized content
          terminalType: "default",
        },
      ],
      activeTabId: 1,
      timestamp: Date.now(),
    };
  }

  /**
   * Restore terminals from saved state
   */
  restoreFromState(savedState, isColdBoot = false) {
    Logger.debug("TabManager.restoreFromState() called with:", {
      hasState: !!savedState,
      terminalCount: savedState?.terminals?.length,
    });

    // If no state or empty state, manufacture a default state
    if (!savedState?.terminals?.length) {
      Logger.warn("No valid saved state, manufacturing default state");
      savedState = this.createDefaultState();
    }

    this._clearExistingState();

    // Recreate terminals from saved state (in the saved order)
    for (const terminalData of savedState.terminals) {
      this._restoreSingleTerminal(terminalData, isColdBoot);
    }

    this._activateRestoredTab(savedState.activeTabId);
    this._finalizeRestore(savedState);
  }

  /**
   * Dispose existing terminals and clear tab UI before restore.
   */
  private _clearExistingState(): void {
    if (this.terminals.size > 0) {
      this.dispose();
    }
    this.terminals.clear();
    this.activeTabId = null;

    const tabBar = document.getElementById("tab-bar");
    if (tabBar) {
      tabBar.querySelectorAll(".tab").forEach((tab) => tab.remove());
    }
  }

  /**
   * Recreate a single terminal from saved state data.
   */
  private _restoreSingleTerminal(terminalData: any, isColdBoot: boolean): void {
    const terminal = new TerminalInstance(
      terminalData.id,
      terminalData.label,
      this.vscode,
      this.terminalTheme,
      this.getThemeColor,
      terminalData.terminalType || "default",
      { autoStartPty: false, uuid: terminalData.uuid },
    );

    // Create container and attach
    const container = this.createTerminalContainer(terminalData.id);
    terminal.attachToContainer(container);

    // Inject cold boot banner before restore
    if (isColdBoot && !terminalData.launchCommand && terminalData.buffer) {
      terminalData.buffer +=
        "\n\n\x1b[47m\x1b[30m * \x1b[0m\x1b[48;5;69m\x1b[30m History restored \x1b[0m\n\n";
    }

    // Restore terminal state (label, terminalType, launchCommand, modes, buffer)
    terminal.restoreFromState(terminalData);

    // Start deferred PTY after terminal is ready
    if (terminal.whenOpened && typeof terminal.whenOpened.then === "function") {
      terminal.whenOpened.then(() => {
        try { terminal.startDeferredPtyIfNeeded(); }
        catch (e) { Logger.error("Deferred PTY start error:", e); }
        try {
          const snap = terminal.serialize();
          if (snap?.length) {
            Logger.debug(`Anchored snapshot post-open for terminal ${terminal.id} (chars=${snap.length})`);
          }
        } catch (e) { Logger.warn("Failed to update tab context:", e); }
      });
    } else {
      try { terminal.startDeferredPtyIfNeeded(); }
      catch (e) { Logger.error("Deferred PTY start error (no whenOpened):", e); }
    }

    // Track next available ID
    if (terminalData.id >= this.nextTabId) {
      this.nextTabId = terminalData.id + 1;
    }

    this.terminals.set(terminalData.id, terminal);
    this._wireBellHandler(terminal);

    // Create tab UI element
    this._tabUIManager.createTabElement(
      terminalData.id,
      terminalData.label || "Terminal",
      this.vscode,
    );

    // Re-render the template with current context
    try { this.requestFormattedTitle(terminalData.id); }
    catch (e) { Logger.warn("Failed to render title on restore:", e); }
  }

  /**
   * Wait for all terminals to open, then switch to the saved active tab.
   */
  private _activateRestoredTab(savedActiveTabId: number | null): void {
    const targetId = savedActiveTabId && this.terminals.has(savedActiveTabId)
      ? savedActiveTabId
      : Array.from(this.terminals.keys())[0];

    if (targetId) {
      const allOpenPromises = Array.from(this.terminals.values())
        .map((t) => t.whenOpened.catch(() => {}));
      Promise.all(allOpenPromises).then(() => {
        this.switchToTab(targetId);
      });
    }
  }

  /**
   * Show interface, persist state, and clean up init timeout after restore.
   */
  private _finalizeRestore(savedState: any): void {
    this._layoutManager.showInterface();

    if (this._initTimeoutId) {
      clearTimeout(this._initTimeoutId);
      this._initTimeoutId = null;
    }

    const existing = vscode.getState() || {};
    vscode.setState({
      ...existing,
      fullTabState: savedState,
      timestamp: Date.now(),
    });

    this.saveToLocalState();
    Logger.debug("Restore complete -", this.terminals.size, "terminals, active tab:", this.activeTabId);
  }

  /**
   * Save state synchronously to webview storage
   */
  saveToLocalState() {
    try {
      // DEFENSIVE: Never save empty state - we always have at least 1 tab
      if (this.terminals.size === 0) {
        Logger.debug("🛡️ Skipping save - no terminals yet (probably not restored)");
        return;
      }

      const fullState = this.saveAllStates();
      Logger.debug(
        "TabManager saving state synchronously:",
        fullState ? `${fullState.terminals?.length} terminals` : "no state",
      );

      // Save synchronously to webview state - this persists across sessions
      const prior = vscode.getState() || {};
      vscode.setState({
        ...prior,
        fullTabState: fullState,
        timestamp: Date.now(),
        // Ensure persistence of the one-time banner flag once we've done a cold boot
        historyBannerShownOnce:
          prior.historyBannerShownOnce || this._historyBannerShownEver || false,
      });

      // Send split messages to extension for persistent storage (non-critical, async)
      try {
        // Build metadata (no buffers) for clean, inspectable storage
        const metadata = {
          terminals: fullState.terminals.map((t: any) => {
            const { buffer, ...meta } = t;
            return meta;
          }),
          activeTabId: fullState.activeTabId,
          timestamp: fullState.timestamp,
        };
        this.vscode.postMessage({
          command: "metadataUpdate",
          state: metadata,
        });

        // Send dirty buffers keyed by UUID
        const buffers: Record<string, string> = {};
        for (const t of fullState.terminals) {
          if (t.uuid && t.buffer) {
            buffers[t.uuid] = t.buffer;
          }
        }
        if (Object.keys(buffers).length > 0) {
          this.vscode.postMessage({
            command: "bufferUpdate",
            buffers,
          });
        }
      } catch (msgError) {
        // Don't fail if async message fails during shutdown
        Logger.warn(
          "⚠️ Could not send state to extension (probably shutting down):",
          msgError,
        );
      }
    } catch (error) {
      Logger.error("Failed to save state:", error);
    }
  }

  /**
   * Check if any terminal has unsaved buffer changes.
   */
  private _hasDirtyTerminals(): boolean {
    for (const [, terminal] of this.terminals) {
      if (terminal.isDirty) return true;
    }
    return false;
  }

  scheduleSaveState(reason = "unspecified") {
    try {
      Debouncer.debounce(
        "global-state-save",
        400,
        () => {
          try {
            this.saveToLocalState();
          } catch (e) {
            Logger.warn("Global debounced save failed", e);
          }
        },
        { maxWait: 4000 },
      );
    } catch (e) {
      Logger.warn("scheduleSaveState failed to enqueue", e);
    }
  }

  /**
   * Create a dedicated terminal container for a specific tab
   */
  createTerminalContainer(tabId) {
    const terminalContainerParent = document.querySelector(
      ".terminal-container",
    );
    if (!terminalContainerParent) return null;

    const terminalContainer = document.createElement("div");
    terminalContainer.id = `terminal-${tabId}`;
    terminalContainer.className = "terminal-instance";
    // Positioning and sizing handled by CSS
    terminalContainer.style.display = "none";

    terminalContainerParent.appendChild(terminalContainer);
    return terminalContainer;
  }

  /**
   * Open tab-specific settings (placeholder for now)
   */
  openTabSettings(tabId) {
    const terminal = this.terminals.get(tabId);
    if (!terminal) return;

    // For now, just open the global settings
    // In the future, this could open a tab-specific settings panel
    this.vscode.postMessage({
      command: "openSettings",
    });

    Logger.info(`Opening settings for tab ${tabId} (${terminal.label})`);
  }

  /**
   * Handle process name changes for dynamic tab labeling
   */
  handleProcessChange(processName, tabId) {
    const terminal = this.terminals.get(tabId);
    if (!terminal) return;

    Logger.debug(`Process change for tab ${tabId}: "${processName}"`);

    // Always re-render the tab's template with the new context
    try {
      this.requestFormattedTitle(tabId, { processName: processName || undefined });
    } catch (e) {
      Logger.warn("Operation failed:", e);
    }
  }

  /**
   * Handle working directory changes from OSC 7
   */
  handleCwdChange(cwd: string, tabId: number): void {
    const terminal = this.terminals.get(tabId);
    if (!terminal) return;

    terminal.cwd = cwd;
    terminal.markDirty();
    this.requestFormattedTitle(tabId);
  }

  /**
   * Handle user variable changes from OSC 1337 SetUserVar
   */
  handleUserVarChange(vars: Record<string, string>, tabId: number): void {
    const terminal = this.terminals.get(tabId);
    if (!terminal) return;

    if (!terminal.userVars) {
      terminal.userVars = {};
    }
    Object.assign(terminal.userVars, vars);
    terminal.markDirty();
    this.requestFormattedTitle(tabId);
  }

  /**
   * Handle OSC title changes (programs setting title via escape sequences)
   */
  handleOscTitleChange(tabId: number, title: string): void {
    const terminal = this.terminals.get(tabId);
    if (!terminal) return;
    this.requestFormattedTitle(tabId, { oscTitle: title });
  }

  // Title generation is delegated to the extension formatter

  /**
   * Request a formatted tab title from the extension using the configured template
   */
  requestFormattedTitle(tabId: number, opts: { processName?: string; oscTitle?: string; workingDirectory?: string } = {}): void {
    // Merge opts into pending state so rapid-fire calls (process change +
    // CWD change + title change arriving within ms of each other on a
    // single shell prompt) collapse into one IPC round-trip.
    const pending = this._pendingTitleOpts.get(tabId);
    if (pending) {
      Object.assign(pending, opts);
    } else {
      this._pendingTitleOpts.set(tabId, { ...opts });
    }

    Debouncer.debounce(
      `title-fmt-${tabId}`,
      50,
      () => {
        try {
          const terminal = this.terminals.get(tabId);
          if (!terminal) return;
          const merged = this._pendingTitleOpts.get(tabId) || {};
          this._pendingTitleOpts.delete(tabId);

          const baseTabName = terminal.baseLabel || "Terminal";
          this.vscode.postMessage({
            command: "formatTabTitle",
            tabId,
            tabName: terminal.label,
            baseTabName,
            template: terminal.titleTemplate || undefined,
            processName: merged.processName,
            oscTitle: merged.oscTitle ?? terminal.oscTitle,
            fullCommand: terminal.launchCommand || undefined,
            workingDirectory: merged.workingDirectory ?? terminal.cwd ?? undefined,
            userVars: terminal.userVars ?? undefined,
          });
        } catch (e) {
          try {
            Logger.warn("Failed to request formatted title", e);
          } catch {}
        }
      },
    );
  }

  /**
   * Clear the active terminal (Cmd/Ctrl+K)
   */
  clearActiveTerminal() {
    const activeTerminal = this.getActiveTerminal();
    if (activeTerminal) {
      // Clear the xterm display (this also sets hasContent = false)
      activeTerminal.clear();

      // Tell extension host to clear daemon buffer for this PTY
      this.vscode.postMessage({
        command: "clearBuffer",
        tabId: activeTerminal.id,
      });

      // Save the cleared state
      this.saveToLocalState();

      Logger.debug("Cleared active terminal:", this.activeTabId);
    }
  }

  /**
   * Dispose of all terminals and cleanup
   */
  dispose() {
    // Remove visibility change handler
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }

    // Stop dirty-check timer
    if (this._dirtySaveTimer) {
      clearInterval(this._dirtySaveTimer);
      this._dirtySaveTimer = null;
    }

    // Dispose layout manager (handles window event cleanup)
    if (this._layoutManager) {
      this._layoutManager.dispose();
    }

    // Dispose keyboard manager
    if (this._keyboardManager) {
      this._keyboardManager.dispose();
    }

    // Dispose tab UI manager
    if (this._tabUIManager) {
      this._tabUIManager.dispose();
    }

    // Dispose all terminals
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
