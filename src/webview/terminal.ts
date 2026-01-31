// @ts-nocheck
import { InputHandler } from "./inputHandler.js";
import { TerminalLifecycleManager } from "./lifecycleManager.js";
import { FilePathLinkProvider } from "./linkProvider.js";
import { AnsiModeProvider } from "./modeProvider.js";
import { Logger } from "./logger.js";
import { Debouncer } from "../utils/debouncer.js";

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

export class TerminalInstance {
  constructor(
    id,
    label,
    vscode,
    terminalTheme,
    getThemeColor,
    terminalType = "default",
    options = {},
  ) {
    const { autoStartPty = true, launchCommand = null } = options;
    this.launchCommand = launchCommand;
    this.id = id;
    this.label = label;
    this.vscode = vscode;
    this.terminalTheme = terminalTheme;
    this.getThemeColor = getThemeColor;
    this.terminalType = terminalType;

    // Track if user has meaningfully interacted with this terminal session
    this.hasUserInteraction = false;

    // Store clean base label (without process names) for proper restoration
    this.baseLabel = label;

    // Terminal and addons (created in _createTerminal)
    this.terminal = null;
    this.fitAddon = null;
    this.serializeAddon = null;
    this.unicodeAddon = null;
    this.webLinksAddon = null;

    // Providers
    this.lifecycleManager = new TerminalLifecycleManager(this, vscode, id);
    this.linkProvider = new FilePathLinkProvider(this, vscode, id);
    this.modeProvider = new AnsiModeProvider(this, vscode, id);

    // Simplified history flags
    this._simpleHistory = true;
    this._didInit = false;
    // If autoStartPty is false we defer spawning until restoration completes.
    // If true we spawn when the terminal is first marked opened.
    this._pendingPtyStart = !autoStartPty;

    // Invoke initialization
    this.initialize();

    // Lifecycle promises compatibility (ensure whenOpened exists)
    if (!this.whenOpened) {
      this.whenOpened = new Promise((res) => {
        this._openedResolve = res;
      });
    }
  }

  initialize() {
    if (this._didInit) return;
    this._didInit = true;
    this._createTerminal();
  }

  _createTerminal() {
    try {
      let XTerminal = null;
      if (window.Terminal && typeof window.Terminal === "function")
        XTerminal = window.Terminal;
      else if (globalThis.Terminal && typeof globalThis.Terminal === "function")
        XTerminal = globalThis.Terminal;
      else if (self.Terminal && typeof self.Terminal === "function")
        XTerminal = self.Terminal;
      else {
        const possible = window.Terminal || globalThis.Terminal;
        if (possible && possible.Terminal) XTerminal = possible.Terminal;
        else throw new Error("Terminal constructor not found");
      }
      this.terminal = new XTerminal({
        cursorBlink: true,
        fontSize:
          parseInt(
            this.getThemeColor("--vscode-editor-font-size", "14").replace(
              "px",
              "",
            ),
          ) || 14,
        fontFamily: this.getThemeColor(
          "--vscode-editor-font-family",
          "Consolas, Monaco, Menlo, monospace",
        ),
        theme: this.terminalTheme,
        scrollback: window.scrollbackLines || 1000,
        scrollOnUserInput: true,
        sendFocus: true,
        allowTransparency: false,
        windowsMode: false,
        experimentalCharAtlas: "dynamic",
        allowProposedApi: true,
        convertEol: true,
        disableStdin: false,
        scrollSensitivity: 1,
        drawBoldTextInBrightColors: false,
        minimumContrastRatio: 1,
      });
      this.fitAddon = new FitAddon.FitAddon();
      this.serializeAddon = new SerializeAddon.SerializeAddon();
      this.unicodeAddon = new Unicode11Addon.Unicode11Addon();
      this.webLinksAddon = new WebLinksAddon.WebLinksAddon((event, uri) => {
        this.vscode.postMessage({ command: "openUrl", url: uri });
        return false;
      });
      // Use WebGL renderer for best performance, fallback to DOM if unsupported
      try {
        const webglAddon = new WebglAddon.WebglAddon();
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
          Logger.debug(`Terminal ${this.id}: WebGL context lost, using DOM renderer`);
        });
        this.terminal.loadAddon(webglAddon);
        Logger.debug(`Terminal ${this.id}: Using WebGL renderer (GPU accelerated)`);
      } catch (webglError) {
        Logger.debug(`Terminal ${this.id}: Using DOM renderer (WebGL unavailable)`);
      }
      this.terminal.loadAddon(this.fitAddon);
      this.terminal.loadAddon(this.serializeAddon);
      this.terminal.loadAddon(this.unicodeAddon);
      this.terminal.loadAddon(this.webLinksAddon);
      this.setupEventHandlers();
      this.lifecycleManager.on("bootReady", () => {
        if (window.tabManager?.saveToLocalState) {
          try {
            window.tabManager.saveToLocalState();
          } catch {}
        }
      });
      this.lifecycleManager.initialize();
      this.linkProvider.initialize();
      this.modeProvider.initialize();
      if (this.terminal.unicode) this.terminal.unicode.activeVersion = "11";
    } catch (e) {
      Logger.error("Terminal init failed", e);
    }
  }

  /**
   * Dispose of existing file path link providers (delegated to linkProvider)
   */
  disposeFilePathLinks() {
    this.linkProvider.dispose();
  }

  /**
   * Set up file path link detection (delegated to linkProvider)
   */
  setupFilePathLinks() {
    this.linkProvider.setupFilePathLinks();
  }

  /**
   * Set up terminal event handlers with proper disposal management
   */
  setupEventHandlers() {
    // Dispose existing handlers first
    this.disposeEventHandlers();

    // Set up input handling (keyboard, file drops, etc.)
    this.inputHandler = new InputHandler(
      this.terminal,
      this.id,
      (msg) => this.vscode.postMessage(msg),
      () => {
        if (window.tabManager && window.tabManager.saveToLocalState) {
          window.tabManager.saveToLocalState();
        }
      },
      this, // Pass TerminalInstance reference for interaction tracking
    );

    // Set up resize handler - coordinate with PTY backend
    let resizeTimeout;
    this.resizeDisposable = this.terminal.onResize((size) => {
      // Debounce resize events to reduce flickering
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        this.sendResizeToPty(size.cols, size.rows);
      }, 50);
    });

    // Set up bell handler - listen for terminal bell events
    this.bellDisposable = this.terminal.onBell(() => {
      const timestamp = new Date().toISOString();
      // Only show indicator if tab is not currently active
      if (!this.isActive) {
        // Show bell notification on inactive tabs
        if (this.onBellReceived) {
          this.onBellReceived(this.id);
        }
      }
    });

    // Set up buffer change detection using onData event
    if (typeof this.terminal.onData === "function") {
      this.dataDisposable = this.terminal.onData(() => {
        // Debounce buffer saves to avoid excessive saving during rapid terminal output
        Debouncer.debounce(
          `term-save-${this.id}`,
          750,
          () => {
            if (window.tabManager?.scheduleSaveState) {
              try {
                window.tabManager.scheduleSaveState("terminalData");
              } catch (_) {}
            } else if (window.tabManager?.saveToLocalState) {
              try {
                window.tabManager.saveToLocalState();
              } catch (_) {}
            }
          },
          { maxWait: 5000 },
        );
      });
    }
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
        performance.mark(`t${this.id}-open`);

        // Set up file path links immediately after opening
        // The terminal is now attached to DOM and ready for link providers
        Logger.debug("🔗 Setting up file path links after terminal.open()");
        this.setupFilePathLinks();

        // Visibility-aware fitting & refresh
        this._installVisibilityHandlers();

        // Simple fit on initialization
        setTimeout(() => this.fit(), 100);

        // Also listen for terminal render events to ensure links work if content changes
        if (typeof this.terminal.onRender === "function") {
          this.renderDisposable = this.terminal.onRender(() => {
            this._markOpened();
          });
        }
      }

      // Fit the terminal to container
      if (
        this.fitAddon &&
        container.offsetWidth > 0 &&
        container.offsetHeight > 0
      )
        this.fitAddon.fit();
    } catch (error) {
      Logger.error(`Failed to attach terminal ${this.id} to container:`, error);
    }
  }

  _markOpened() {
    if (this._openedResolved) return;
    this._openedResolved = true;
    if (this._openedResolve) {
      try {
        this._openedResolve();
      } catch {}
    }
    // Start PTY immediately if not deferred
    try {
      if (!this._pendingPtyStart) {
        this.createPtyProcess();
      }
    } catch (e) {
      Logger.error("Immediate PTY start failed:", e);
    }
  }

  /**
   * Set a terminal mode bit (delegated to modeProvider)
   */
  setMode(bit, enabled) {
    this.modeProvider.setMode(bit, enabled);
  }

  /**
   * Check if a terminal mode is enabled (delegated to modeProvider)
   */
  hasMode(bit) {
    return this.modeProvider.hasMode(bit);
  }

  /**
   * Parse and track terminal modes from escape sequences (delegated to modeProvider)
   */
  parseAndTrackModes(data) {
    this.modeProvider.parseAndTrackModes(data);
  }

  /**
   * Strip terminal mode sequences from data (delegated to modeProvider)
   */
  stripModeSequences(data) {
    return this.modeProvider.stripModeSequences(data);
  }

  /**
   * Restore terminal modes after deserializing content (delegated to modeProvider)
   */
  restoreTerminalModes() {
    this.modeProvider.restoreModes();
  }

  /**
   * Write data to the terminal
   */
  write(data) {
    if (!this.terminal) return;
    try {
      // In simple history mode we bypass mode tracking/stripping entirely for raw fidelity
      if (!this._simpleHistory) {
        this.parseAndTrackModes(data);
        data = this.stripModeSequences(data);
      }
      this.terminal.write(data);
      this._lastWriteTs = Date.now();
      Debouncer.debounce(
        `term-save-${this.id}`,
        600,
        () => {
          try {
            if (window.tabManager?.scheduleSaveState)
              window.tabManager.scheduleSaveState("terminalWrite");
            else if (window.tabManager?.saveToLocalState)
              window.tabManager.saveToLocalState();
          } catch (_) {}
        },
        { maxWait: 4000 },
      );
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
    if (!this.fitAddon || !this.terminal || !this.terminalContainer) return;
    
    // Only fit if container has meaningful dimensions
    const containerWidth = this.terminalContainer.offsetWidth;
    const containerHeight = this.terminalContainer.offsetHeight;
    
    if (containerWidth < 10 || containerHeight < 10) {
      Logger.debug(`Terminal ${this.id}: Skipping fit - container too small (${containerWidth}x${containerHeight})`);
      return;
    }
    
    try {
      this.fitAddon.fit();
      Logger.debug(`Terminal ${this.id}: Fitted to ${containerWidth}x${containerHeight}`);
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
      
      // Reset interaction tracking since user is starting fresh
      this.resetUserInteraction();
      
      // Don't immediately wipe snapshots; the shell usually redraws a fresh prompt shortly after clear
      // Instead schedule a short delayed snapshot capture so the prompt line is preserved
      setTimeout(() => {
        try {
          const snap = this.serialize();
          if (snap && snap.trim().length > 0) {
            if (window.tabManager?.scheduleSaveState) {
              window.tabManager.scheduleSaveState("terminalClear");
            }
            Logger.debug(
              `🧹 Post-clear snapshot captured for terminal ${this.id} (chars=${snap.length})`,
            );
          } else {
            Logger.debug(
              `🧹 Post-clear snapshot still empty for terminal ${this.id}`,
            );
          }
        } catch (_) {}
      }, 60); // small delay to allow prompt redraw

      Logger.debug(`Terminal ${this.id} cleared and state saved`);
    } catch (error) {
      Logger.error(`Failed to clear terminal ${this.id}:`, error);
    }
  }

  /**
   * Reset terminal to clean state - fixes display corruption
   */
  resetTerminal() {
    if (!this.terminal) return;
    
    try {
      // Send comprehensive reset sequence to fix any corruption
      const resetSequence = 
        '\x1b[0m' +           // Reset all attributes (colors, bold, etc.)
        '\x1b[?25h' +         // Show cursor
        '\x1b[?1000l' +       // Disable mouse tracking
        '\x1b[?1002l' +       // Disable button event mouse tracking
        '\x1b[?1003l' +       // Disable any motion mouse tracking
        '\x1b[?1006l' +       // Disable SGR mouse mode
        '\x1b[?7h' +          // Enable line wrapping
        '\x1b[?47l' +         // Exit alternate screen (if in it)
        '\x1b[?1049l' +       // Exit alternate screen buffer
        '\x1b[2J' +           // Clear entire screen
        '\x1b[H';             // Move cursor to home position
      
      this.terminal.write(resetSequence);
      
      // Also trigger a fit to fix any layout issues
      setTimeout(() => this.fit(), 50);
      
      Logger.info(`🔄 Terminal ${this.id} reset to clean state`);
    } catch (error) {
      Logger.error(`Failed to reset terminal ${this.id}:`, error);
    }
  }

  /**
   * Reset only colors and text attributes
   */
  resetColors() {
    if (!this.terminal) return;
    try {
      this.terminal.write('\x1b[0m'); // Reset all attributes (colors, bold, etc.)
      Logger.info(`🎨 Terminal ${this.id} colors reset`);
    } catch (error) {
      Logger.error(`Failed to reset colors for terminal ${this.id}:`, error);
    }
  }

  /**
   * Reset cursor and basic terminal modes
   */
  resetCursor() {
    if (!this.terminal) return;
    try {
      const cursorSequence = 
        '\x1b[?25l' +         // Hide cursor first to clear ghost cursors
        '\x1b[?25h' +         // Show cursor
        '\x1b[?12l' +         // Stop blinking cursor
        '\x1b[?12h' +         // Start blinking cursor  
        '\x1b[?7h' +          // Enable line wrapping
        '\x1b8' +             // Restore cursor position (if saved)
        '\x1b[u';             // Restore cursor position (alternative)
      this.terminal.write(cursorSequence);
      Logger.info(`👁️ Terminal ${this.id} enhanced cursor reset (ghost cursor fix)`);
    } catch (error) {
      Logger.error(`Failed to reset cursor for terminal ${this.id}:`, error);
    }
  }

  /**
   * Specific fix for ghost cursor issues
   */
  fixGhostCursor() {
    if (!this.terminal) return;
    try {
      // Aggressive cursor reset sequence specifically for ghost cursors
      const ghostCursorFix = 
        '\x1b[?25l' +         // Hide cursor
        '\x1b[2J' +           // Clear screen to remove ghost cursors
        '\x1b[H' +            // Home cursor
        '\x1b[?25h' +         // Show cursor
        '\x1b[0 q';           // Reset cursor style to default
      this.terminal.write(ghostCursorFix);
      Logger.info(`👻 Terminal ${this.id} ghost cursor fix applied`);
    } catch (error) {
      Logger.error(`Failed to fix ghost cursor for terminal ${this.id}:`, error);
    }
  }

  /**
   * Reset mouse tracking modes
   */
  resetMouse() {
    if (!this.terminal) return;
    try {
      const mouseSequence = 
        '\x1b[?1000l' +       // Disable mouse tracking
        '\x1b[?1002l' +       // Disable button event mouse tracking
        '\x1b[?1003l' +       // Disable any motion mouse tracking
        '\x1b[?1006l';        // Disable SGR mouse mode
      this.terminal.write(mouseSequence);
      Logger.info(`🖱️ Terminal ${this.id} mouse tracking reset`);
    } catch (error) {
      Logger.error(`Failed to reset mouse for terminal ${this.id}:`, error);
    }
  }

  /**
   * Reset screen and buffer modes
   */
  resetScreen() {
    if (!this.terminal) return;
    try {
      const screenSequence = 
        '\x1b[?47l' +         // Exit alternate screen (if in it)
        '\x1b[?1049l' +       // Exit alternate screen buffer
        '\x1b[2J' +           // Clear entire screen
        '\x1b[H';             // Move cursor to home position
      this.terminal.write(screenSequence);
      setTimeout(() => this.fit(), 50);
      Logger.info(`📺 Terminal ${this.id} screen and buffer reset`);
    } catch (error) {
      Logger.error(`Failed to reset screen for terminal ${this.id}:`, error);
    }
  }

  /**
   * Mark that the user has meaningfully interacted with this terminal
   */
  markUserInteraction() {
    if (!this.hasUserInteraction) {
      this.hasUserInteraction = true;
      Logger.debug(`🎯 Terminal ${this.id} marked as interactive - will save state`);
    }
  }

  /**
   * Reset interaction tracking (for new sessions)
   */
  resetUserInteraction() {
    this.hasUserInteraction = false;
    Logger.debug(`🔄 Terminal ${this.id} interaction tracking reset`);
  }

  /**
   * Set active/inactive state
   */
  setActive(active) {
    this.isActive = active;
    if (this.terminalContainer) {
      this.terminalContainer.style.display = active ? "block" : "none";
    }

    if (active) {
      // Clear all indicators when tab becomes active

      queueMicrotask(() => {
        if (this.terminal) {
          // this.terminal.refresh(0, this.terminal.rows - 1);
        }
        requestAnimationFrame(() => {
          this.fit();
          this.focus();
          try {
            performance.mark(`t${this.id}-active`);
            if (window.tabManager && window.tabManager._recordTerminalTiming) {
              window.tabManager._recordTerminalTiming(this.id);
            }
          } catch (e) {}
          // Simple refit after activation
          setTimeout(() => this.fit(), 50);
        });
      });
    }
  }

  /**
   * Serialize terminal state for persistence
   */
  serialize() {
    if (!this.serializeAddon) return null;
    try {
      const raw = this.serializeAddon.serialize({
        scrollback: window.scrollbackLines || 1000,
        excludeAltBuffer: true,
        excludeModes: false,
      });
      return this._simpleHistory ? raw : this.stripModeSequences(raw);
    } catch (e) {
      Logger.error("Serialize failed:", e);
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
      const lines = serializedContent.split("\n").length;
      const lastLine = serializedContent.split("\n").slice(-2)[0]; // -2 because last is usually empty
      Logger.debug(
        `Deserializing terminal ${this.id}: ${lines} lines, last line: "${lastLine}"`,
      );
      if (lines === 0 || !serializedContent.trim()) {
        Logger.debug(
          `⚠️ Deserialization content appears empty for terminal ${this.id}`,
        );
      }

      // Strip any lingering mode sequences from stored content before restoring
      const cleanContent = this.stripModeSequences(serializedContent);

      // Write clean content (don't trigger state save during restoration)
      this.terminal.write(cleanContent);
      Logger.debug(
        `✅ Wrote restored content to terminal ${this.id} (chars=${cleanContent.length})`,
      );

      // Restore terminal modes after content with slight delay to ensure terminal is ready
      setTimeout(() => {
        this.restoreTerminalModes();
      }, 100);

      window.dispatchEvent(new Event("resize"));
    } catch (error) {
      Logger.error(`Failed to deserialize terminal ${this.id}:`, error);
    }
  }

  /**
   * Get terminal state for persistence
   */
  getState() {
    // Only save buffer content if user has meaningfully interacted
    const shouldSaveBuffer = this.hasUserInteraction && !this.launchCommand;
    
    const state = {
      id: this.id,
      label: this.label,
      baseLabel: this.baseLabel, // Save clean base label separately
      buffer: shouldSaveBuffer ? this.serialize() || "" : "", 
      modes: this.modeProvider.getState(), // Include terminal modes bitmask
      launchCommand: this.launchCommand,
      hasUserInteraction: this.hasUserInteraction,
    };
    
    if (shouldSaveBuffer) {
      Logger.debug(`🔍 Terminal ${this.id} getState() - saving buffer (interactive session)`);
    } else if (!this.hasUserInteraction) {
      Logger.debug(`🔍 Terminal ${this.id} getState() - skipping buffer (no user interaction)`);
    } else {
      Logger.debug(`🔍 Terminal ${this.id} getState() - skipping buffer (launch command terminal)`);
    }
    
    return state;
  }

  /**
   * Restore terminal from state
   */
  restoreFromState(state) {
    if (!state) return;

    this.label = state.label || this.label;
    
    // Restore clean base label, fallback to extracting from current label
    this.baseLabel = state.baseLabel || this.label.split(" •")[0] || "Terminal";

    // Restore interaction flag
    this.hasUserInteraction = state.hasUserInteraction || false;

    // Restore terminal modes through modeProvider
    this.modeProvider.restoreState(state.modes || 0);

    // Restore launch command and derive terminal type
    this.launchCommand = state.launchCommand || this.launchCommand;
    this.terminalType = this.launchCommand ? "command" : "default";

    if (this.launchCommand) {
      Logger.debug(
        `Terminal ${this.id}: Relaunching with command "${this.launchCommand}" instead of restoring content`,
      );
    } else {
      const contentToRestore = state.buffer;
      if (contentToRestore) {
        this.deserialize(contentToRestore);
        Logger.debug(`Terminal ${this.id}: Restored interactive session buffer`);
      } else if (this.hasUserInteraction) {
        Logger.debug(`Terminal ${this.id}: Was interactive but no buffer to restore`);
      } else {
        Logger.debug(`Terminal ${this.id}: Fresh session - no interaction history`);
      }
    }
  }

  disposeEventHandler(handler) {
    if (handler) {
      handler.dispose();
      return null;
    }
    return handler;
  }

  /**
   * Dispose of event handlers
   */
  disposeEventHandlers() {
    // Dispose all event handler disposables
    this.inputHandler = this.disposeEventHandler(this.inputHandler);
    this.dataDisposable = this.disposeEventHandler(this.dataDisposable);
    this.resizeDisposable = this.disposeEventHandler(this.resizeDisposable);
    this.bellDisposable = this.disposeEventHandler(this.bellDisposable);
    this.renderDisposable = this.disposeEventHandler(this.renderDisposable);

    // Dispose link providers
    if (this.linkProviders) {
      this.linkProviders.forEach(({ provider, disposable }) => {
        try {
          if (disposable && disposable.dispose) {
            disposable.dispose();
            Logger.debug("Disposed link provider");
          }
        } catch (error) {
          Logger.error("Error disposing link provider:", error);
        }
      });
      this.linkProviders = [];
    }

    // Dispose link matchers (fallback)
    if (
      this.linkMatcherIds &&
      this.terminal &&
      this.terminal.deregisterLinkMatcher
    ) {
      this.linkMatcherIds.forEach((matcherId) => {
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
    if (this._ptyStarted) return;
    this._ptyStarted = true;
    Logger.debug(`🚀 Spawning PTY for terminal ${this.id}`, {
      type: this.terminalType,
      launchCommand: this.launchCommand,
      keys: Object.keys(this || {}),
    });
    this.vscode.postMessage({
      command: "createPty",
      tabId: this.id,
      terminalType: this.terminalType,
      launchCommand: this.launchCommand,
    });
  }

  startDeferredPtyIfNeeded() {
    if (this._pendingPtyStart) {
      this._pendingPtyStart = false;
      this.createPtyProcess();
    }
  }

  /**
   * Send resize to PTY process
   */
  sendResizeToPty(cols, rows) {
    this.vscode.postMessage({
      command: "resize",
      cols: cols,
      rows: rows,
      tabId: this.id,
    });
  }

  /**
   * Dispose PTY process
   */
  disposePtyProcess() {
    this.vscode.postMessage({
      command: "disposePty",
      tabId: this.id,
    });
  }

  /**
   * Dispose of all resources (both frontend and backend)
   */
  dispose() {
    try {
      // Dispose PTY process first
      this.disposePtyProcess();

      // Dispose providers
      this.lifecycleManager.dispose();
      this.linkProvider.dispose();
      this.modeProvider.dispose();

      // Dispose event handlers
      this.disposeEventHandlers();

      // No per-instance debounce timers to clear (shared Debouncer manages its own entries)

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

      // Clear all indicators

      // Clear references
      this.fitAddon = null;
      this.serializeAddon = null;
      this.webLinksAddon = null;
    } catch (error) {
      Logger.error(`Failed to dispose terminal ${this.id}:`, error);
    }
  }

  _installVisibilityHandlers() {
    if (this._visibilityInstalled) return;
    this._visibilityInstalled = true;
    const container = document.getElementById("container");
    if (container && "ResizeObserver" in window) {
      const ro = new ResizeObserver(() => {
        if (this.isActive) {
          try { this.fit(); } catch (_) {}
          // If width/height just became non-zero, force redraw sequence
          if (
            this.terminalContainer &&
            this.terminalContainer.offsetWidth > 0 &&
            this.terminalContainer.offsetHeight > 0
          ) {
            this.fit();
          }
        }
      });
      ro.observe(container);
      // Also observe the terminal container directly for more accurate size changes
      if (this.terminalContainer) {
        try { ro.observe(this.terminalContainer); } catch (_) {}
      }
      this._resizeObserver = ro;
    }
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.isActive) {
        requestAnimationFrame(() => {
          if (this.terminal) {
            // this.terminal.refresh(0, this.terminal.rows - 1);
            this.fit();
          }
        });
      }
    });
    // WebGL context loss fallback
    const attachWebglHandlers = () => {
      const cvs = this.terminalContainer?.querySelectorAll("canvas") || [];
      if (!cvs.length) return false;
      cvs.forEach((cv) => {
        cv.addEventListener(
          "webglcontextlost",
          (e) => {
            e.preventDefault();
            Logger.warn("WebGL context lost – falling back to DOM renderer");
            // DOM renderer is automatically used when WebGL fails
            // No need to manually load a fallback addon
            this.fit();
          },
          { passive: false },
        );
      });
      return true;
    };
    // Try now, else poll a few animation frames
    if (!attachWebglHandlers()) {
      let attempts = 0;
      const poll = () => {
        if (attachWebglHandlers()) return;
        if (++attempts < 10) requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    }

    // Mutation observer to detect panel moves or DOM reparenting
    try {
      const observer = new MutationObserver(() => {
        if (!this.isActive) return;
        if (!this.terminalContainer) return;
        if (
          this.terminalContainer.offsetWidth === 0 ||
          this.terminalContainer.offsetHeight === 0
        )
          return;
        // Simple refit on body changes
        this.fit();
      });
      observer.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
      });
      this._mutationObserver = observer;
    } catch (e) {
      Logger.debug("MutationObserver unavailable:", e);
    }
  }

}
