/**
 * WebView Message Handler
 * 
 * Handles all messages from the extension host.
 * Decoupled from TabManager to follow Single Responsibility Principle.
 */

import { Logger } from "./logger.js";

declare const vscode: any;

export interface MessageHandlerCallbacks {
  // State management
  saveAllStates: () => any;
  saveToLocalState: () => void;
  restoreFromState: (state: any, isCold: boolean) => void;
  createDefaultState: () => any;
  
  // Terminal operations
  getActiveTerminal: () => any;
  getTerminals: () => Map<number, any>;
  writeToTerminal: (tabId: number, data: string) => void;
  ensureInitialized: () => void;
  
  // Tab operations
  createNewTab: (type?: string, cmd?: string | null) => void;
  closeTab: (tabId: number) => void;
  switchToTab: (tabId: number) => void;
  updateTabLabel: (tabId: number, label: string) => void;
  startTabRename: (tabId: number) => void;
  setTabIcon: (tabId: number, icon: string) => void;
  handleGetTabBuffer: (tabId: number) => void;
  
  // UI updates
  updateTabBarVisibility: () => void;
  updateSaveButtonVisibility: (command: any, isSaved: any) => void;
  resetActiveTerminal: () => void;
  handleProcessChange: (processName: string, tabId: number) => void;
  handleCwdChange: (cwd: string, tabId: number) => void;
  scheduleSaveState: (reason: string) => void;
  
  // Internal state
  getSavedCommandsSet: () => Set<string>;
  setSavedCommandsSet: (set: Set<string>) => void;
  getHistoryBannerShownEver: () => boolean;
  setHistoryBannerShownEver: (val: boolean) => void;
  setAlwaysShowTabs: (val: boolean) => void;
  findTabIdByCommand: (cmd: string) => number | null;
  reportPerformance: () => void;
}

/**
 * Handles message routing from extension host to appropriate callbacks
 */
export class MessageHandler {
  private callbacks: MessageHandlerCallbacks;
  private vscode: any;

  constructor(vscode: any, callbacks: MessageHandlerCallbacks) {
    this.vscode = vscode;
    this.callbacks = callbacks;
  }

  /**
   * Initialize message listener
   */
  setup(): void {
    window.addEventListener("message", (event) => this.handleMessage(event));
  }

  /**
   * Handle incoming message from extension
   */
  private handleMessage(event: MessageEvent): void {
    const message = event.data;

    try {
      switch (message.command) {
        case "formatTabTitleResponse":
          this.handleFormatTabTitleResponse(message);
          break;

        case "savedCommandsList":
          this.handleSavedCommandsList(message);
          break;

        case "restoreState":
          this.handleRestoreState(message);
          break;

        case "initializeEmpty":
          this.handleInitializeEmpty(message);
          break;

        case "data":
          this.handleData(message);
          break;

        case "reconnect":
        case "redraw":
          this.handleRedraw();
          break;

        case "focus":
          // Warm focus: just refresh active terminal visuals
          this.callbacks.getActiveTerminal();
          break;

        case "refresh":
          this.callbacks.resetActiveTerminal();
          break;

        case "refreshActive":
          this.handleRefreshActive();
          break;

        case "triggerResize":
          window.dispatchEvent(new Event("resize"));
          break;

        case "requestState":
          this.handleRequestState(this.callbacks.saveAllStates());
          break;

        case "processChange":
          this.callbacks.handleProcessChange(message.processName, message.tabId);
          break;

        case "cwdChange":
          this.callbacks.handleCwdChange(message.cwd, message.tabId);
          break;

        case "createNewTab":
          this.callbacks.createNewTab(message.terminalType, message.launchCommand);
          break;

        case "switchToTab":
          if (message.tabId) {
            this.callbacks.switchToTab(message.tabId);
          }
          break;

        case "updateFileCache":
          (window as any).workspaceFileCache = new Set(message.files || []);
          break;

        case "fileExistsResponse":
          Logger.debug("🔍 File exists response:", message.filePath, "->", message.exists);
          break;

        case "setDebugFilter":
          this.handleSetDebugFilter(message);
          break;

        case "setDeveloperMode":
          this.handleSetDeveloperMode(message);
          break;

        case "updateConfig":
          this.handleUpdateConfig(message);
          break;

        case "collectPerformance":
          this.callbacks.reportPerformance();
          break;

        case "commandSavedResponse":
          this.handleCommandSavedResponse(message);
          break;

        case "renameTab":
          Logger.debug("✏️ Received rename tab request for inline editing:", message.tabId);
          this.callbacks.startTabRename(message.tabId);
          break;

        case "closeTab":
          Logger.debug("❌ Received close tab request:", message.tabId);
          this.callbacks.closeTab(message.tabId);
          break;

        case "setTabIcon":
          Logger.debug("🎨 Received set tab icon request:", message.tabId, message.icon);
          this.callbacks.setTabIcon(message.tabId, message.icon);
          break;

        case "getTabBuffer":
          Logger.debug("📋 Received get tab buffer request:", message.tabId);
          this.callbacks.handleGetTabBuffer(message.tabId);
          break;

        default:
          Logger.warn("Unknown command received:", message.command);
          break;
      }

    } catch (error) {
      Logger.error("Message handling error:", error);
    }
  }

  // === Individual message handlers ===

  private handleFormatTabTitleResponse(message: any): void {
    try {
      if (typeof message.tabId === "number" && typeof message.title === "string") {
        this.callbacks.updateTabLabel(message.tabId, message.title);
        this.callbacks.scheduleSaveState("formatTabTitleResponse");
      }
    } catch (e) {
      Logger.warn("Failed to handle formatTabTitleResponse:", e);
    }
  }

  private handleSavedCommandsList(message: any): void {
    try {
      const savedSet = new Set<string>(message.commands || []);
      this.callbacks.setSavedCommandsSet(savedSet);
      
      for (const [id, term] of this.callbacks.getTerminals()) {
        if (term.launchCommand && savedSet.has(term.launchCommand)) {
          const tabEl = document.querySelector(`.tab[data-tab-id="${id}"]`);
          if (tabEl) {
            const ctx = JSON.parse(tabEl.getAttribute("data-vscode-context") || "{}");
            ctx.savedCommand = true;
            tabEl.setAttribute("data-vscode-context", JSON.stringify(ctx));
          }
        }
      }
    } catch (e) {
      Logger.warn("Failed to handle savedCommandsList:", e);
    }
  }

  private handleRestoreState(message: any): void {
    Logger.debug(
      "🔄 Received restoreState - terminals in message:",
      message.state?.terminals?.length,
      ", existing terminals:",
      this.callbacks.getTerminals().size,
      ", cold:",
      !!message.cold
    );

    const terminals = this.callbacks.getTerminals();
    if (terminals.size > 0) {
      // Check if existing terminals are just placeholders
      let onlyPlaceholders = true;
      for (const [, t] of terminals) {
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
        Logger.debug("⏭️ Skipping restoreState (real terminals already present)");
        return;
      }
      Logger.debug("♻️ Existing terminals are placeholders; proceeding with full restore");
    }

    // Try webview state first, then fall back to extension state
    const webviewState = vscode.getState();
    Logger.debug(
      "📦 Webview state:",
      webviewState ? "present" : "empty",
      ", fullTabState:",
      webviewState?.fullTabState ? `${webviewState.fullTabState.terminals?.length} terminals` : "none"
    );

    if (webviewState?.historyBannerShownOnce) {
      this.callbacks.setHistoryBannerShownEver(true);
    }

    if (webviewState?.fullTabState) {
      Logger.debug("🔄 Using webview state (more recent)");
      this.callbacks.restoreFromState(webviewState.fullTabState, !!message.cold);
    } else if (message.state) {
      Logger.debug("🔄 Using extension state (fallback)");
      this.callbacks.restoreFromState(message.state, !!message.cold);
    } else {
      Logger.debug("🔄 No state available, creating default");
      this.callbacks.restoreFromState(this.callbacks.createDefaultState(), !!message.cold);
    }
  }

  private handleInitializeEmpty(message: any): void {
    Logger.debug("🆕 Received initializeEmpty command - checking for existing state");

    const existingState = vscode.getState();
    if (existingState?.fullTabState) {
      Logger.debug("🔄 Found existing webview state, restoring instead of creating empty");
      this.callbacks.restoreFromState(existingState.fullTabState, !!message.cold);
    } else {
      Logger.debug("🆕 No existing state, creating default terminal");
      this.callbacks.restoreFromState(this.callbacks.createDefaultState(), !!message.cold);
    }
  }

  private handleData(message: any): void {
    this.callbacks.ensureInitialized();

    if (message.tabId) {
      this.callbacks.writeToTerminal(message.tabId, message.data);
    } else {
      const activeTerminal = this.callbacks.getActiveTerminal();
      if (activeTerminal) {
        activeTerminal.write(message.data);
      }
    }
  }

  private handleRedraw(): void {
    const activeTerminal = this.callbacks.getActiveTerminal();
    if (activeTerminal) {
      activeTerminal.fit();
    }
  }

  private handleRefreshActive(): void {
    const activeTerminal = this.callbacks.getActiveTerminal();
    if (activeTerminal?.terminal) {
      try {
        activeTerminal.fit();
      } catch (e) {
        Logger.warn("Failed to refresh active terminal:", e);
      }
    }
  }

  private handleRequestState(currentState: any): void {
    this.callbacks.ensureInitialized();
    this.vscode.postMessage({
      command: "stateResponse",
      state: currentState,
    });
  }

  private handleSetDebugFilter(message: any): void {
    if (message.filter) {
      localStorage.setItem("alterminal.debugFilter", JSON.stringify(message.filter));
    } else {
      localStorage.removeItem("alterminal.debugFilter");
    }
  }

  private handleSetDeveloperMode(message: any): void {
    (window as any).DEVELOPER_MODE = message.enabled;
    try {
      Logger.configureDevMode(message.enabled);
    } catch {
      /* ignore */
    }
  }

  private handleUpdateConfig(message: any): void {
    if (message.config) {
      if (typeof message.config.alwaysShowTabs === "boolean") {
        this.callbacks.setAlwaysShowTabs(message.config.alwaysShowTabs);
        this.callbacks.updateTabBarVisibility();
      }
      if (typeof message.config.scrollback === "number") {
        (window as any).scrollbackLines = message.config.scrollback;
      }
    }
  }

  private handleCommandSavedResponse(message: any): void {
    Logger.debug("📋 Received command saved status:", message.launchCommand, message.isSaved);
    this.callbacks.updateSaveButtonVisibility(message.launchCommand, message.isSaved);

    if (message.launchCommand && message.isSaved) {
      this.callbacks.getSavedCommandsSet().add(message.launchCommand);
    }

    // Update tab context for VS Code context menu
    try {
      const tabId = this.callbacks.findTabIdByCommand(message.launchCommand);
      if (tabId !== null) {
        const tabEl = document.querySelector(`.tab[data-tab-id="${tabId}"]`);
        if (tabEl) {
          const ctx = JSON.parse(tabEl.getAttribute("data-vscode-context") || "{}");
          ctx.savedCommand = !!message.isSaved;
          tabEl.setAttribute("data-vscode-context", JSON.stringify(ctx));
        }
      }
    } catch {
      /* ignore */
    }
  }
}
