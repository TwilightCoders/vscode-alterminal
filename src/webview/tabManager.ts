// @ts-nocheck
import { TerminalInstance } from "./terminal.js";
import { TabTitleManager } from "./tabTitleManager.js";
// Import shared Debouncer (was missing, causing ReferenceError at runtime)
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
  constructor(vscode, terminalTheme, getThemeColor) {
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
    this._historyBannerInjected = false; // guards single injection of History Restored banner for this restore cycle
    this._historyBannerShownEver = false; // persisted (via vscode.setState) across webview instances to avoid re-showing banner

    // Configuration settings
    this._alwaysShowTabs = false;

    // Initialize everything
    this.initializeEventListeners();
    this.setupResponsiveLayout();
    this.setupMessageHandling();
    this.setupWindowEventHandlers();
    this.autoInitialize();

    // Signal immediately that webview is ready and request file cache
    queueMicrotask(() => {
      this.vscode.postMessage({ command: "webviewReady" });
      this.vscode.postMessage({ command: "requestFileCache" });
    });

    // Performance samples storage
    window.__terminalPerf = window.__terminalPerf || { samples: [] };
  }

  _findTabIdByCommand(cmd) {
    if (!cmd) return null;
    for (const [id, term] of this.terminals) {
      if (term.launchCommand === cmd) return id;
    }
    return null;
  }

  /**
   * Setup message handling from extension host
   */
  setupMessageHandling() {
    window.addEventListener("message", (event) => {
      const message = event.data;

      try {
        const currentState = this.saveAllStates();
        switch (message.command) {
          case "formatTabTitleResponse":
            try {
              if (
                typeof message.tabId === "number" &&
                typeof message.title === "string"
              ) {
                this.updateTabLabel(message.tabId, message.title);
                this.scheduleSaveState("formatTabTitleResponse");
              }
            } catch (_) {}
            break;
          case "savedCommandsList":
            try {
              this._savedCommandsSet = new Set(message.commands || []);
              for (const [id, term] of this.terminals) {
                if (
                  term.launchCommand &&
                  this._savedCommandsSet.has(term.launchCommand)
                ) {
                  const tabEl = document.querySelector(
                    `.tab[data-tab-id="${id}"]`,
                  );
                  if (tabEl) {
                    const ctx = JSON.parse(
                      tabEl.getAttribute("data-vscode-context"),
                    );
                    ctx.savedCommand = true;
                    tabEl.setAttribute(
                      "data-vscode-context",
                      JSON.stringify(ctx),
                    );
                  }
                }
              }
            } catch (_) {}
            break;
          case "restoreState":
            Logger.debug(
              "🔄 Received restoreState terminals:",
              message.state?.terminals?.length,
              "existing:",
              this.terminals.size,
              "providerColdFlag:",
              !!message.cold,
            );
            if (this.terminals.size > 0) {
              // Determine if what we have are just placeholder empty terminals (no buffer, default label)
              let onlyPlaceholders = true;
              for (const [, t] of this.terminals) {
                try {
                  const st = t.getState();
                  const hasContent = st.buffer && st.buffer.trim().length > 0;
                  const nonDefaultLabel = st.label && st.label !== "Terminal";
                  if (hasContent || nonDefaultLabel || t.launchCommand) {
                    onlyPlaceholders = false;
                    break;
                  }
                } catch {
                  onlyPlaceholders = false;
                  break;
                }
              }
              if (!onlyPlaceholders) {
                Logger.debug(
                  "⏭️ Skipping restoreState (real terminals already present) treating as warm focus",
                );
                break;
              } else {
                Logger.debug(
                  "♻️ Existing terminals are placeholders; proceeding with full restore",
                );
              }
            }

            // Try webview state first, then fall back to extension state
            const webviewState = vscode.getState();
            // If we've ever shown the history banner before in ANY previous webview instance, record it separately
            if (webviewState && webviewState.historyBannerShownOnce) {
              this._historyBannerShownEver = true;
            }
            if (webviewState && webviewState.fullTabState) {
              Logger.debug("🔄 Using webview state (more recent)");
              this.restoreFromState(webviewState.fullTabState, !!message.cold);
            } else if (message.state) {
              Logger.debug("🔄 Using extension state (fallback)");
              this.restoreFromState(message.state, !!message.cold);
            } else {
              Logger.debug("🔄 No state available, creating default");
              this.restoreFromState(this.createDefaultState(), !!message.cold);
            }
            break;

          case "initializeEmpty":
            Logger.debug(
              "🆕 Received initializeEmpty command - checking for existing state",
            );

            // Check if we have webview state before creating empty
            const existingState = vscode.getState();
            if (existingState && existingState.fullTabState) {
              Logger.debug(
                "🔄 Found existing webview state, restoring instead of creating empty",
              );
              this.restoreFromState(existingState.fullTabState, !!message.cold);
            } else {
              Logger.debug("🆕 No existing state, creating default terminal");
              const defaultState = this.createDefaultState();
              this.restoreFromState(defaultState, !!message.cold);
            }
            break;

          case "data":
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

          case "reconnect":
          case "redraw":
            // Simple redraw - fit the active terminal
            const activeTerminal = this.getActiveTerminal();
            if (activeTerminal) {
              activeTerminal.fit();
            }
            break;
          case "focus":
            // Warm focus: just refresh active terminal visuals
            const act = this.getActiveTerminal();
            if (act && act.terminal) {
            }
            break;

          case "refresh":
            // Reset the active terminal to clean state instead of reloading
            this.resetActiveTerminal();
            break;
          case "refreshActive":
            // Lightweight visual refresh only
            const a = this.getActiveTerminal();
            if (a && a.terminal) {
              try {
                a.fit();
              } catch (_) {}
            }
            break;

          case "triggerResize":
            window.dispatchEvent(new Event("resize"));
            break;

          case "requestState":
            this.ensureInitialized();
            this.vscode.postMessage({
              command: "stateResponse",
              state: currentState,
            });
            break;

          case "processChange":
            this.handleProcessChange(message.processName, message.tabId);
            break;

          case "createNewTab":
            this.createNewTab(message.terminalType, message.launchCommand);
            break;

          case "switchToTab":
            if (message.tabId) {
              this.switchToTab(message.tabId);
            }
            break;

          case "updateFileCache":
            window.workspaceFileCache = new Set(message.files || []);

            break;

          case "fileExistsResponse":
            Logger.debug(
              "🔍 File exists response:",
              message.filePath,
              "->",
              message.exists,
            );
            // Could be used for individual file checks if needed
            break;

          case "setDebugFilter":
            if (message.filter) {
              localStorage.setItem(
                "alterminal.debugFilter",
                JSON.stringify(message.filter),
              );
            } else {
              localStorage.removeItem("alterminal.debugFilter");
            }
            break;

          case "setDeveloperMode":
            window.DEVELOPER_MODE = message.enabled;
            try { Logger.configureDevMode(message.enabled); } catch { /* ignore */ }
            break;

          case "updateConfig":
            if (message.config) {
              if (typeof message.config.alwaysShowTabs === "boolean") {
                this._alwaysShowTabs = message.config.alwaysShowTabs;
                this.updateTabBarVisibility();
              }
              if (typeof message.config.scrollback === "number") {
                window.scrollbackLines = message.config.scrollback;
              }
            }
            break;

          case "collectPerformance":
            this._reportPerformance();
            break;

          case "commandSavedResponse":
            Logger.debug(
              "📋 Received command saved status:",
              message.launchCommand,
              message.isSaved,
            );
            this.updateSaveButtonVisibility(
              message.launchCommand,
              message.isSaved,
            );
            if (message.launchCommand && message.isSaved) {
              // Keep internal set in sync so future tabs with same launchCommand start with saved flag
              this._savedCommandsSet.add(message.launchCommand);
            }
            // Update tab context JSON so VS Code context menu can hide Save Command when already saved
            try {
              const tabEl = document.querySelector(
                `.tab[data-tab-id="${this._findTabIdByCommand(message.launchCommand)}"]`,
              );
              if (tabEl) {
                const ctx = JSON.parse(
                  tabEl.getAttribute("data-vscode-context"),
                );
                ctx.savedCommand = !!message.isSaved;
                tabEl.setAttribute("data-vscode-context", JSON.stringify(ctx));
              }
            } catch (_) {
              /* ignore */
            }
            break;
            break;

          case "renameTab":
            Logger.debug(
              "✏️ Received rename tab request for inline editing:",
              message.tabId,
            );
            this.startTabRename(message.tabId);
            break;

          case "closeTab":
            Logger.debug("❌ Received close tab request:", message.tabId);
            this.closeTab(message.tabId);
            break;

          // Debug reset commands
          case "resetActiveColors":
            this.resetActiveColors();
            break;
          case "resetActiveCursor":
            this.resetActiveCursor();
            break;
          case "resetActiveMouse":
            this.resetActiveMouse();
            break;
          case "resetActiveScreen":
            this.resetActiveScreen();
            break;
          case "resetActiveTerminal":
            this.resetActiveTerminal();
            break;
          case "fixGhostCursor":
            this.fixGhostCursor();
            break;

          default:
            Logger.warn("Unknown command received:", message.command);
            break;
        }
        this.saveToLocalState();
      } catch (error) {
        Logger.error("Message handling error:", error);
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
   * Setup window event handlers
   */
  setupWindowEventHandlers() {
    // Window resize handling
    window.addEventListener("resize", () => {
      const activeTerminal = this.getActiveTerminal();
      if (activeTerminal) {
        activeTerminal.fit();
      }
    });

    // Focus handling
    window.addEventListener("focus", () => {
      requestAnimationFrame(() => {
        const activeTerminal = this.getActiveTerminal();
        if (activeTerminal) activeTerminal.fit();
      });
    });

    // Setup keyboard shortcut passthrough
    this.setupKeyboardPassthrough();

    // Flush any pending debounced saves just before the webview unloads (window/tab close, reload)
    window.addEventListener("beforeunload", () => {
      try {
        // Force each terminal to produce a fresh snapshot (ignores debounce timers)
        for (const [, term] of this.terminals) {
          try {
            term.serialize();
          } catch (_) {}
        }
        // Persist immediately
        this.saveToLocalState();
      } catch (e) {
        console.warn("beforeunload save failed", e);
      }
    });
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
      { key: "F5", ctrlKey: false, shiftKey: false, altKey: false },
      { key: "F1", ctrlKey: false, shiftKey: false, altKey: false },
      { key: "F11", ctrlKey: false, shiftKey: false, altKey: false },
      { key: "p", ctrlKey: true, shiftKey: true, altKey: false },
      { key: "P", ctrlKey: true, shiftKey: true, altKey: false },
      { key: "n", ctrlKey: true, shiftKey: false, altKey: false },
      { key: "o", ctrlKey: true, shiftKey: false, altKey: false },
      { key: "s", ctrlKey: true, shiftKey: false, altKey: false },
      { key: "w", ctrlKey: true, shiftKey: false, altKey: false },
      { key: "g", ctrlKey: true, shiftKey: false, altKey: false },
      { key: "f", ctrlKey: true, shiftKey: false, altKey: false },
      { key: "h", ctrlKey: true, shiftKey: false, altKey: false },
      { key: "b", ctrlKey: true, shiftKey: false, altKey: false },
      { key: "`", ctrlKey: true, shiftKey: false, altKey: false },
      { key: "j", ctrlKey: true, shiftKey: false, altKey: false },
      { key: "Tab", ctrlKey: true, shiftKey: false, altKey: false },
      { key: "Tab", ctrlKey: true, shiftKey: true, altKey: false },
      { key: "=", ctrlKey: true, shiftKey: false, altKey: false },
      { key: "-", ctrlKey: true, shiftKey: false, altKey: false },
      { key: "0", ctrlKey: true, shiftKey: false, altKey: false },
    ];

    // Add clear terminal shortcut (Cmd+K on macOS, Ctrl+K on Windows/Linux)
    const clearShortcut = {
      key: "k",
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
    };

    // Add macOS shortcuts
    if (navigator.platform.indexOf("Mac") > -1) {
      const macShortcuts = vsCodeShortcuts.map((shortcut) => ({
        ...shortcut,
        ctrlKey: false,
        metaKey: shortcut.ctrlKey,
      }));
      vsCodeShortcuts.push(...macShortcuts);
    }

    document.addEventListener(
      "keydown",
      (event) => {
        // Check for clear terminal shortcut first
        const isMac = navigator.platform.indexOf("Mac") > -1;
        const clearKeyPressed =
          event.key === "k" &&
          ((isMac && event.metaKey) || (!isMac && event.ctrlKey)) &&
          !event.shiftKey &&
          !event.altKey;

        if (clearKeyPressed) {
          event.preventDefault();
          event.stopPropagation();
          this.clearActiveTerminal();
          return false;
        }

        // Check for reset terminal shortcut (Cmd+R on macOS, Ctrl+R on Windows/Linux)
        const resetKeyPressed =
          event.key === "r" &&
          ((isMac && event.metaKey) || (!isMac && event.ctrlKey)) &&
          !event.shiftKey &&
          !event.altKey;

        if (resetKeyPressed) {
          event.preventDefault();
          event.stopPropagation();
          this.resetActiveTerminal();
          return false;
        }

        const matchesShortcut = vsCodeShortcuts.some((shortcut) => {
          return (
            event.key === shortcut.key &&
            event.ctrlKey === shortcut.ctrlKey &&
            event.shiftKey === shortcut.shiftKey &&
            event.altKey === shortcut.altKey &&
            (shortcut.metaKey === undefined ||
              event.metaKey === shortcut.metaKey)
          );
        });

        if (matchesShortcut) {
          return true;
        }

        return true;
      },
      true,
    );
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
  createNewTab(terminalType = "default", launchCommand = null) {
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
        label = "Shell";
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
        label = "Terminal";
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
      { launchCommand },
    );
    Logger.debug("🏗️ TerminalInstance created successfully:", terminal);

    // Create container and attach terminal
    const container = this.createTerminalContainer(tabId);
    terminal.attachToContainer(container);

    // Store the terminal
    this.terminals.set(tabId, terminal);

    // Create tab DOM element
    this.createTabElement(tabId, label);

    // Ask extension to format the initial title using user template
    try {
  this.requestFormattedTitle(tabId);
    } catch (_) {}

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
    this.updateActiveTabUI(tabId);
    this.activeTabId = tabId;

    // Clear notifications for the newly active tab
    this.clearNotificationsOnActivation(tabId);

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
  updateSaveButtonVisibility(command, isSaved) {
    // Handle save items in dropdowns only (no more tab bar save buttons)
    const dropdownSaveItems = document.querySelectorAll(
      `.tab-dropdown-item[data-action="save"][data-command="${command}"]`,
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

      // Show notification if writing to an inactive tab and data has visible content
      if (tabId !== this.activeTabId && data && data.trim().length > 0) {
        // Only show notification for "significant" output (not just control sequences)
        // Filter out pure ANSI escape sequences and very short outputs
        const visibleContent = data.replace(/\x1b\[[0-9;]*m/g, "").trim();
        if (visibleContent.length > 5) {
          this.showNotification(tabId);
        }
      }
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
   * Individual reset methods for debugging
   */
  resetActiveColors() {
    const activeTerminal = this.getActiveTerminal();
    if (activeTerminal && typeof activeTerminal.resetColors === 'function') {
      activeTerminal.resetColors();
    }
  }

  resetActiveCursor() {
    const activeTerminal = this.getActiveTerminal();
    if (activeTerminal && typeof activeTerminal.resetCursor === 'function') {
      activeTerminal.resetCursor();
    }
  }

  resetActiveMouse() {
    const activeTerminal = this.getActiveTerminal();
    if (activeTerminal && typeof activeTerminal.resetMouse === 'function') {
      activeTerminal.resetMouse();
    }
  }

  resetActiveScreen() {
    const activeTerminal = this.getActiveTerminal();
    if (activeTerminal && typeof activeTerminal.resetScreen === 'function') {
      activeTerminal.resetScreen();
    }
  }

  fixGhostCursor() {
    const activeTerminal = this.getActiveTerminal();
    if (activeTerminal && typeof activeTerminal.fixGhostCursor === 'function') {
      activeTerminal.fixGhostCursor();
    }
  }

  /**
   * Update tab label
   */
  updateTabLabel(tabId, label) {
    const terminal = this.terminals.get(tabId);
    if (terminal) {
      terminal.label = label;

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
    const tabElements = document.querySelectorAll(".tab");
    const tabIdsInOrder = Array.from(tabElements).map((tab) =>
      parseInt(tab.dataset.tabId),
    );

    // Iterate in DOM order instead of Map order
    for (const id of tabIdsInOrder) {
      const terminal = this.terminals.get(id);
      if (!terminal) continue;

      // Get the complete terminal state (handles content serialization logic internally)
      const terminalData = terminal.getState();

      // For default terminals (no launch command), handle content preservation and trimming
      if (!terminal.launchCommand) {
        let serialized = terminal.serialize();
        // Logger.warn(`Saving terminal: `, terminal);
        // if (serialized == null) {
        //     const preserved = priorContentById.get(id);
        //     if (preserved) {
        //         Logger.debug(`Serialization suppressed for terminal ${id}; preserving prior snapshot (${preserved.length} chars)`);
        //         serialized = preserved;
        //     } else {
        //         serialized = '';
        //     }
        // }
        // // Trim large non-shell buffers to last 40 lines to reduce stale full-screen TUI state
        // if (terminal.terminalType && terminal.terminalType !== 'shell' && serialized) {
        //     const lines = serialized.split('\n');
        //     if (lines.length > 40) serialized = lines.slice(-40).join('\n');
        // }
        // Fallback preservation: if serialization suppressed / empty but we had prior content, keep it
        if (
          (serialized == null || serialized.length === 0) &&
          priorContentById.has(id)
        ) {
          const preserved = priorContentById.get(id);
          if (preserved && preserved.length > 0) {
            Logger.debug(
              `🛟 Preserving prior snapshot for terminal ${id} (len=${preserved.length}) due to empty serialize()`,
            );
            serialized = preserved;
          }
        }
        // Use new property name but support old names for backward compatibility
        terminalData.buffer = serialized || "";
      }

      // Logger.warn(`Saving terminal ${id}:`, {
      //     id: terminalData.id,
      //     label: terminalData.label,
      //     command: terminalData.command,
      //     buffer: terminalData.buffer?.substring(0, 100) + '...',
      //     bufferLength: terminalData.buffer?.length || 0
      // });
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
      terminals: savedState?.terminals?.map((t) => ({
        id: t.id,
        label: t.label,
        type: t.terminalType,
      })),
    });

    // If no state or empty state, manufacture a default state
    if (
      !savedState ||
      !savedState.terminals ||
      savedState.terminals.length === 0
    ) {
      Logger.warn("⚠️ No valid saved state, manufacturing default state");
      savedState = this.createDefaultState();
    }

    // Only dispose existing terminals if we actually have any
    if (this.terminals.size > 0) {
      Logger.debug("Disposing existing terminals before restore");
      this.dispose();
    }
    this.terminals.clear();
    this.activeTabId = null;

    // Clear tab UI
    const tabBar = document.getElementById("tab-bar");
    if (tabBar) {
      const existingTabs = tabBar.querySelectorAll(".tab");
      existingTabs.forEach((tab) => tab.remove());
    }

    // Recreate terminals from saved state (in the saved order)
    Logger.debug(
      "Starting to recreate",
      savedState.terminals.length,
      "terminals",
    );
    let maxRestoreDelay = 0;
    for (const terminalData of savedState.terminals) {
      Logger.debug("🔄 Creating terminal from state:", {
        id: terminalData.id,
        label: terminalData.label,
        type: terminalData.terminalType,
      });
      Logger.debug("🔄 About to create TerminalInstance from restore...");
      const terminal = new TerminalInstance(
        terminalData.id,
        terminalData.label,
        this.vscode,
        this.terminalTheme,
        this.getThemeColor,
        terminalData.terminalType || "default",
        { autoStartPty: false }, // delay PTY spawn until after restored content is written
      );
      Logger.warn("🔄 TerminalInstance created from restore:", terminal);

      // Create container and attach
      const container = this.createTerminalContainer(terminalData.id);
      terminal.attachToContainer(container);

      // Inject cold boot banner BEFORE first restore to avoid duplicate content writes
      if (isColdBoot && !terminalData.launchCommand) {
        const existingContent = terminalData.buffer;
        if (existingContent) {
          Logger.debug(
            "🏁 Decorating cold boot content prior to restore for terminal",
            terminalData.id,
          );
          terminalData.buffer =
            existingContent +
            "\n\n\x1b[47m\x1b[30m * \x1b[0m\x1b[48;5;69m\x1b[30m History restored \x1b[0m\n\n";
        }
      }

      // Restore terminal state (includes label, terminalType, launchCommand, and modes) exactly once
      terminal.restoreFromState(terminalData);

      if (
        terminal.whenOpened &&
        typeof terminal.whenOpened.then === "function"
      ) {
        terminal.whenOpened.then(() => {
          try {
            terminal.startDeferredPtyIfNeeded();
          } catch (e) {
            Logger.error("Deferred PTY start error:", e);
          }
          try {
            const snap = terminal.serialize();
            if (snap && snap.length) {
              Logger.debug(
                `📌 Anchored snapshot post-open for terminal ${terminal.id} (chars=${snap.length})`,
              );
            }
          } catch (_) {}
        });
      } else {
        // Fallback immediate start if promise missing
        try {
          terminal.startDeferredPtyIfNeeded();
        } catch (e) {
          Logger.error("Deferred PTY start error (no whenOpened):", e);
        }
      }

      // Update next tab ID if needed
      if (terminalData.id >= this.nextTabId) {
        this.nextTabId = terminalData.id + 1;
      }

      // Store terminal (Map preserves insertion order)
      this.terminals.set(terminalData.id, terminal);
      Logger.debug(
        "Stored terminal",
        terminalData.id,
        "- Current terminal count:",
        this.terminals.size,
      );

      // Create tab element (DOM order will match saved order)
      this.createTabElement(terminalData.id, terminalData.label);

      // Request initial formatted title from extension
      try {
        this.requestFormattedTitle(terminalData.id, { processName: undefined });
      } catch (_) {}

      // PTY process creation is now handled by the Terminal instance itself
    }

    // Delay switching to active tab until after all terminals have been restored
    const targetActiveTabId =
      savedState.activeTabId && this.terminals.has(savedState.activeTabId)
        ? savedState.activeTabId
        : Array.from(this.terminals.keys())[0];

    if (targetActiveTabId) {
      // Wait for all terminals to be opened before switching to active tab
      const allOpenPromises = Array.from(this.terminals.values()).map((t) =>
        t.whenOpened.catch(() => {}),
      );
      Promise.all(allOpenPromises).then(() => {
        Logger.debug(
          "🔄 All terminals opened, now switching to active tab:",
          targetActiveTabId,
        );
        this.switchToTab(targetActiveTabId);
      });
    }

    // Show the interface after restoring
    this.showInterface();

    const existing = vscode.getState() || {};
    vscode.setState({
      ...existing,
      fullTabState: savedState,
      timestamp: Date.now(),
    });

    // Immediate post-restore baseline save (terminals mark ready instantly now)
    try {
      for (const [id, term] of this.terminals) {
        try {
          const state = term.getState();
          Logger.debug("🔍 Restored terminal verification", {
            id,
            label: state.label,
            bufferLength: (state.buffer || "").length,
          });
        } catch (_) {}
      }
    } catch (_) {}
    Logger.debug("🧷 Post-restore immediate baseline save");
    this.saveToLocalState();
    Logger.debug(
      "Restore complete - Final terminal count:",
      this.terminals.size,
      "Active tab:",
      this.activeTabId,
    );
  }

  /**
   * Save state synchronously to webview storage
   */
  saveToLocalState() {
    try {
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

      // OPTIONALLY also send to extension for backup (non-critical, async)
      try {
        this.vscode.postMessage({
          command: "stateUpdate",
          state: fullState,
        });
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
   * Debounced global state save with maxWait safeguard so constant activity still persists.
   */
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
   * Create the DOM element for a tab
   */
  createTabElement(tabId, label) {
    const tabList = document.querySelector(".tab-list");

    if (!tabList) return;

    // Get the terminal to check if it's a command tab
    const terminal = this.terminals.get(tabId);
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
    const isSaved =
      terminal?.launchCommand &&
      this._savedCommandsSet &&
      this._savedCommandsSet.has(terminal.launchCommand);
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
    this.titleManagers.set(tabId, tabTitleManager);

    // Set up callback for title changes (saves state after rename)
    tabTitleManager.setTitleChangeCallback((tabId) => {
      this.scheduleSaveState("titleChange");
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
  updateActiveTabUI(tabId) {
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
  initializeEventListeners() {
    // New tab functionality is now handled by title bar button
    // No DOM-based new tab button needed

    // Tab click and keyboard handlers (using event delegation)
    const tabBar = document.getElementById("tab-bar");
    if (tabBar) {
      // Keyboard navigation support
      tabBar.addEventListener("keydown", (e) => {
        if (
          e.target.classList.contains("tab") ||
          e.target.classList.contains("tab-close")
        ) {
          if (e.key === "Enter" || e.key === " ") {
            e.target.click();
            e.preventDefault();
          }
        }
      });

      // Click handlers
      tabBar.addEventListener("click", (e) => {
        // Handle tab icon clicks (show dropdown or handle notification)
        if (
          e.target.classList.contains("tab-icon") ||
          e.target.parentElement.classList.contains("tab-icon")
        ) {
          const icon = e.target.classList.contains("tab-icon")
            ? e.target
            : e.target.parentElement;
          const tab = icon.closest(".tab");

          // If clicking on notification bell, switch to tab instead of showing dropdown
          if (icon.classList.contains("notification")) {
            const tabId = parseInt(tab.dataset.tabId);
            if (!isNaN(tabId)) {
              this.switchToTab(tabId);
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
          e.target.classList.contains("tab-dropdown-item") ||
          e.target.parentElement.classList.contains("tab-dropdown-item")
        ) {
          const item = e.target.classList.contains("tab-dropdown-item")
            ? e.target
            : e.target.parentElement;
          const action = item.getAttribute("data-action");
          const tab = item.closest(".tab");

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
          e.target.classList.contains("tab") ||
          e.target.parentElement.classList.contains("tab")
        ) {
          const tab = e.target.classList.contains("tab")
            ? e.target
            : e.target.parentElement;
          const tabId = parseInt(tab.dataset.tabId);
          if (!isNaN(tabId)) {
            this.switchToTab(tabId);
          }
        }
      });

      // Double-click handler for tab renaming
      tabBar.addEventListener("dblclick", (e) => {
        // Handle double-clicks on tab labels for renaming
        if (e.target.classList.contains("tab-label")) {
          const tab = e.target.closest(".tab");
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
      tabBar.addEventListener("keydown", (e) => {
        if (e.target.classList.contains("tab")) {
          switch (e.key) {
            case "Enter":
            case " ":
              const tabId = parseInt(e.target.dataset.tabId);
              if (!isNaN(tabId)) {
                this.switchToTab(tabId);
              }
              e.preventDefault();
              break;
            case "Delete":
            case "Backspace":
              const deleteTabId = parseInt(e.target.dataset.tabId);
              if (!isNaN(deleteTabId)) {
                this.closeTab(deleteTabId);
              }
              e.preventDefault();
              break;
          }
        } else if (e.target.classList.contains("tab-icon")) {
          if (e.key === "Enter" || e.key === " ") {
            // If icon has notification, switch to tab instead of showing dropdown
            if (e.target.classList.contains("notification")) {
              const tab = e.target.closest(".tab");
              const tabId = parseInt(tab.dataset.tabId);
              if (!isNaN(tabId)) {
                this.switchToTab(tabId);
              }
            } else {
              const dropdown = e.target.querySelector(".tab-dropdown");
              if (dropdown) {
                this.toggleDropdown(dropdown);
              }
            }
            e.preventDefault();
          }
        } else if (e.target.classList.contains("tab-dropdown-item")) {
          switch (e.key) {
            case "Enter":
            case " ":
              const action = e.target.getAttribute("data-action");
              const tab = e.target.closest(".tab");
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
              this.focusNextDropdownItem(e.target);
              e.preventDefault();
              break;
            case "ArrowUp":
              this.focusPrevDropdownItem(e.target);
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
      if (
        !e.target.closest(".tab-icon") &&
        !e.target.closest(".tab-dropdown")
      ) {
        this.hideAllDropdowns();
      }
    });
  }

  /**
   * Setup drag and drop handlers for tab reordering
   */
  setupTabDragHandlers(tabBar) {
    let draggedTab = null;
    let lastTargetTab = null;
    let lastInsertBefore = false;

    tabBar.addEventListener("dragstart", (e) => {
      if (e.target.classList.contains("tab")) {
        draggedTab = e.target;
        e.target.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", e.target.dataset.tabId);
      }
    });

    tabBar.addEventListener("dragend", (e) => {
      if (e.target.classList.contains("tab")) {
        e.target.classList.remove("dragging");

        // Use the last target from dragover
        if (lastTargetTab && draggedTab && lastTargetTab !== draggedTab) {
          const tabList = lastTargetTab.parentElement;
          if (lastInsertBefore) {
            tabList.insertBefore(draggedTab, lastTargetTab);
          } else {
            tabList.insertBefore(draggedTab, lastTargetTab.nextSibling);
          }

          // Save the new tab order
          this.scheduleSaveState("tabReorder");
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

      const targetTab = e.target.closest(".tab");
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

      e.dataTransfer.dropEffect = "move";
    });
  }

  /**
   * Toggle dropdown visibility
   */
  toggleDropdown(dropdown) {
    // Hide other dropdowns first
    this.hideAllDropdowns();

    // Toggle the target dropdown
    dropdown.classList.toggle("show");

    // Focus the first item if opening
    if (dropdown.classList.contains("show")) {
      const firstItem = dropdown.querySelector(".tab-dropdown-item");
      if (firstItem) {
        firstItem.focus();
      }
    }
  }

  /**
   * Hide all dropdown menus
   */
  hideAllDropdowns() {
    const dropdowns = document.querySelectorAll(".tab-dropdown");
    dropdowns.forEach((dropdown) => {
      dropdown.classList.remove("show");
    });
  }

  /**
   * Handle dropdown menu actions
   */
  handleDropdownAction(action, tabId) {
    switch (action) {
      case "save":
        this.saveCommand(tabId);
        break;
      case "settings":
        this.openTabSettings(tabId);
        break;
      case "close":
        this.closeTab(tabId);
        break;
      default:
        Logger.warn("Unknown dropdown action:", action);
        break;
    }
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
   * Focus next dropdown item for keyboard navigation
   */
  focusNextDropdownItem(currentItem) {
    const dropdown = currentItem.closest(".tab-dropdown");
    if (!dropdown) return;

    const items = dropdown.querySelectorAll(
      ".tab-dropdown-item:not(.disabled)",
    );
    const currentIndex = Array.from(items).indexOf(currentItem);
    const nextIndex = (currentIndex + 1) % items.length;

    items[nextIndex].focus();
  }

  /**
   * Focus previous dropdown item for keyboard navigation
   */
  focusPrevDropdownItem(currentItem) {
    const dropdown = currentItem.closest(".tab-dropdown");
    if (!dropdown) return;

    const items = dropdown.querySelectorAll(
      ".tab-dropdown-item:not(.disabled)",
    );
    const currentIndex = Array.from(items).indexOf(currentItem);
    const prevIndex = currentIndex === 0 ? items.length - 1 : currentIndex - 1;

    items[prevIndex].focus();
  }

  /**
   * Show notification bell for a specific tab
   */
  showNotification(tabId) {
    const tabTitleManager = this.titleManagers?.get(tabId);
    if (tabTitleManager) {
      tabTitleManager.showNotification();
    }
  }

  /**
   * Hide notification bell for a specific tab
   */
  hideNotification(tabId) {
    const tabTitleManager = this.titleManagers?.get(tabId);
    if (tabTitleManager) {
      tabTitleManager.hideNotification();
    }
  }

  /**
   * Clear all notifications when a tab becomes active
   */
  clearNotificationsOnActivation(tabId) {
    // Hide notification for the newly active tab
    this.hideNotification(tabId);
  }

  /**
   * Set up responsive layout detection and switching
   */
  setupResponsiveLayout() {
    const container = document.getElementById("container");
    if (!container) return;

    // ResizeObserver for responsive tab layout
    const resizeObserver = new ResizeObserver((entries) => {
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
    const container = document.getElementById("container");
    if (!container) return;

    const { width, height } = rect;
    const aspectRatio = width / height;

    // Get layout preference from configuration
    const layoutPreference = this.getTabLayoutPreference();

    let useVerticalTabs = false;

    switch (layoutPreference) {
      case "vertical":
        useVerticalTabs = true;
        break;
      case "horizontal":
        useVerticalTabs = false;
        break;
      case "auto":
      default:
        // Switch to vertical tabs if width > height * 1.5
        useVerticalTabs = aspectRatio > 1.5;
        break;
    }

    // Apply the layout
    if (useVerticalTabs) {
      container.classList.add("vertical-tabs");
    } else {
      container.classList.remove("vertical-tabs");
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
    const loadingDiv = document.querySelector(".loading");
    const container = document.getElementById("container");

    if (loadingDiv) {
      loadingDiv.style.display = "none";
    }

    if (container) {
      container.style.display = "flex";
    }
  }

  /**
   * Get tab layout preference from configuration
   */
  getTabLayoutPreference() {
    // For now, return 'auto' - this will be connected to VS Code settings later
    return "auto";
  }

  /**
   * Handle process name changes for dynamic tab labeling
   */
  handleProcessChange(processName, tabId) {
    const terminal = this.terminals.get(tabId);
    if (!terminal) return;

    // Debug: log what we're getting
    Logger.debug(`Process change for tab ${tabId}: "${processName}"`);

    // Ensure baseLabel is clean and doesn't contain process names
    if (!terminal.baseLabel || terminal.baseLabel.includes(" •")) {
      terminal.baseLabel = (terminal.baseLabel || terminal.label).split(" •")[0] || "Terminal";
      Logger.debug(`Terminal ${tabId}: Clean baseLabel set to "${terminal.baseLabel}"`);
    }

    // If no process name (back to shell), reset the label to just the base
    if (!processName || processName.trim() === "") {
      terminal.label = terminal.baseLabel;
      this.updateTabLabel(tabId, terminal.baseLabel);
      return; // Skip template formatting for empty process
    }

  // Ask extension to apply full template formatting (single source of truth)
    try {
      this.requestFormattedTitle(tabId, { processName });
    } catch (_) {}
  }

  // Title generation is delegated to the extension formatter

  /**
   * Request a formatted tab title from the extension using the configured template
   */
  requestFormattedTitle(tabId, opts = {}) {
    try {
      const terminal = this.terminals.get(tabId);
      if (!terminal) return;

      // Ensure we always use clean baseLabel for title formatting
      const baseTabName = terminal.baseLabel || "Terminal";
      this.vscode.postMessage({
        command: "formatTabTitle",
        tabId,
        tabName: terminal.label,
        baseTabName,
        processName: opts.processName,
        fullCommand: terminal.launchCommand || undefined,
      });
    } catch (e) {
      try {
        Logger.warn("Failed to request formatted title", e);
      } catch {}
    }
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

      Logger.debug("Cleared active terminal:", this.activeTabId);
    }
  }

  /**
   * Refresh link providers for all terminals when CMD key state changes
   */
  refreshLinkProviders() {
    for (const terminal of this.terminals.values()) {
      if (terminal.setupFilePathLinks) {
        terminal.setupFilePathLinks();
      } else {
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
