import { InputHandler } from "./inputHandler.js";
import { TerminalLifecycleManager } from "./lifecycleManager.js";
import { Logger } from "./logger.js";
import { Debouncer } from "../utils/debouncer.js";
import { TERMINAL_DEFAULTS } from "../constants.js";

interface TerminalOptions {
  autoStartPty?: boolean;
  launchCommand?: string | null;
  cwd?: string | null;
  shellPath?: string | null;
  uuid?: string;
}

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
  // Core properties (public — accessed by TabManager, TabTitleManager, TabUIManager)
  public uuid: string;
  public id: number;
  public label: string;
  public baseLabel: string;
  public icon: string | null;
  public terminalType: string;
  public launchCommand: string | null;
  public cwd: string | null;
  public oscTitle: string | null;
  public userVars: Record<string, string> | null;
  public titleTemplate: string | null;
  public hasUserInteraction: boolean;
  public isActive: boolean;
  public whenOpened: Promise<any>;
  public onBellReceived?: (tabId: number) => void;
  public onActivity?: (tabId: number) => void;

  // Internal — passed to child managers but not accessed externally
  private vscode: any;
  private terminalTheme: any;
  private getThemeColor: (cssVar: string, fallback: string) => string;

  // Terminal and addons (internal xterm.js plumbing)
  private terminal: any;
  private fitAddon: any;
  private serializeAddon: any;
  private unicodeAddon: any;
  private webglAddon?: any;
  public searchAddon?: any;

  // Managers and handlers (internal)
  private lifecycleManager: TerminalLifecycleManager;
  private inputHandler: any;
  private linkProviderDisposable: any;
  private linkProviders?: any[];
  private linkMatcherIds?: number[];

  // Event disposables (internal)
  private resizeDisposable: any;
  private bellDisposable: any;
  private renderDisposable: any;
  private titleChangeDisposable: any;
  private osc52Disposable: any;
  private writeParsedDisposable: any;

  // State tracking (internal)
  public shellPath: string | null;
  private _isDirty: boolean;
  private _cachedSerializedState: string | null;
  private _didInit: boolean;
  private _pendingPtyStart: boolean;
  private _openedResolve?: (value: any) => void;

  // Lifecycle (internal)
  private terminalContainer: HTMLElement | null;
  private _openedResolved?: boolean;
  private _ptyStarted?: boolean;
  private _visibilityInstalled?: boolean;
  private _resizeObserver?: ResizeObserver;
  private _visibilityHandler?: () => void;
  private _webglContextLostHandlers?: Array<{ canvas: HTMLCanvasElement; handler: (e: Event) => void }>;

  constructor(
    id: number,
    label: string,
    vscode: any,
    terminalTheme: any,
    getThemeColor: (cssVar: string, fallback: string) => string,
    terminalType: string = "default",
    options: TerminalOptions = {},
  ) {
    const { autoStartPty = true, launchCommand = null, cwd = null, shellPath = null, uuid } = options;
    this.uuid = uuid || crypto.randomUUID();
    this.launchCommand = launchCommand;
    this.cwd = cwd;
    this.shellPath = shellPath;
    this.id = id;
    this.label = label;
    this.vscode = vscode;
    this.terminalTheme = terminalTheme;
    this.getThemeColor = getThemeColor;
    this.terminalType = terminalType;

    // Track if user has meaningfully interacted with this terminal session
    this.hasUserInteraction = false;

    // Dirty tracking for optimized state saves
    this._isDirty = true; // Start dirty so first save captures initial state
    this._cachedSerializedState = null;

    // Store clean base label (without process names) for proper restoration
    this.baseLabel = label;

    // Icon for this terminal (can be customized)
    this.icon = null;

    if (!this.cwd) this.cwd = null;

    // OSC title reported by the running program (via \x1b]0;title\x07 or \x1b]2;title\x07)
    this.oscTitle = null;

    // User-defined variables set via OSC 1337 SetUserVar
    this.userVars = null;

    // Per-tab title template (null = use global default from settings)
    this.titleTemplate = null;

    // Terminal and addons (created in _createTerminal)
    this.terminal = null;
    this.fitAddon = null;
    this.serializeAddon = null;
    this.unicodeAddon = null;

    // Providers
    this.lifecycleManager = new TerminalLifecycleManager(this, vscode, String(id));
    this.linkProviderDisposable = null;

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

  /**
   * Mark this terminal's state as dirty (needs re-serialization on next save).
   */
  markDirty(): void {
    this._isDirty = true;
  }

  /**
   * Whether this terminal has unsaved state changes.
   */
  get isDirty(): boolean {
    return this._isDirty;
  }

  initialize() {
    if (this._didInit) return;
    this._didInit = true;
    this._createTerminal();
  }

  private _createTerminal() {
    try {
      let XTerminal = null;
      if (window.Terminal && typeof window.Terminal === "function")
        XTerminal = window.Terminal;
      else if ((globalThis as any).Terminal && typeof (globalThis as any).Terminal === "function")
        XTerminal = (globalThis as any).Terminal;
      else if ((self as any).Terminal && typeof (self as any).Terminal === "function")
        XTerminal = (self as any).Terminal;
      else {
        const possible = (window as any).Terminal || (globalThis as any).Terminal;
        if (possible && possible.Terminal) XTerminal = possible.Terminal;
        else throw new Error("Terminal constructor not found");
      }
      const appearance = ((window as any).terminalAppearance ?? {}) as Record<string, any>;
      const fallbackFontSize =
        parseInt(
          this.getThemeColor("--vscode-editor-font-size", String(TERMINAL_DEFAULTS.FONT_SIZE)).replace("px", ""),
        ) || TERMINAL_DEFAULTS.FONT_SIZE;
      const fallbackFontFamily = this.getThemeColor(
        "--vscode-editor-font-family",
        "Consolas, Monaco, Menlo, monospace",
      );

      this.terminal = new XTerminal({
        cursorBlink: appearance.cursorBlinking ?? true,
        cursorStyle: appearance.cursorStyle ?? "block",
        cursorInactiveStyle: "none",
        overviewRulerWidth: 0,
        scrollOnUserInput: true,
        reflowCursorLine: true,
        fontSize: appearance.fontSize || fallbackFontSize,
        fontFamily: appearance.fontFamily || fallbackFontFamily,
        fontWeight: appearance.fontWeight || "normal",
        fontWeightBold: appearance.fontWeightBold || "bold",
        lineHeight: appearance.lineHeight || 1.0,
        letterSpacing: appearance.letterSpacing ?? 0,
        theme: this.terminalTheme,
        scrollback: window.scrollbackLines || TERMINAL_DEFAULTS.SCROLLBACK,
        sendFocus: true,
        allowTransparency: false,
        experimentalCharAtlas: "dynamic",
        allowProposedApi: true,
        convertEol: true,
        disableStdin: false,
        scrollSensitivity: 1,
        smoothScrollDuration: appearance.smoothScrolling ? 125 : 0,
        drawBoldTextInBrightColors: false,
        minimumContrastRatio: appearance.minimumContrastRatio ?? 1,
        wordSeparator: appearance.wordSeparators || undefined,
      });
      this.fitAddon = new FitAddon.FitAddon();
      this.serializeAddon = new SerializeAddon.SerializeAddon();
      this.unicodeAddon = new (window as any).UnicodeGraphemesAddon.UnicodeGraphemesAddon();
      // Renderer: WebGL (default, GPU) unless alterminal.renderer === "dom",
      // in which case we skip the addon entirely and use xterm's built-in DOM
      // renderer (no glyph atlas). Falls back to DOM if WebGL init throws.
      const rendererMode = (window as any).__alterminalRenderer ?? "webgl";
      if (rendererMode === "dom") {
        this.webglAddon = null;
        Logger.debug(`Terminal ${this.id}: Using DOM renderer (alterminal.renderer=dom)`);
      } else {
        try {
          this.webglAddon = new WebglAddon.WebglAddon();
          this.webglAddon.onContextLoss(() => {
            this.webglAddon.dispose();
            this.webglAddon = null;
            Logger.warn(`Terminal ${this.id}: WebGL context lost`);
            this.showWebGLError();
          });
          this.terminal.loadAddon(this.webglAddon);
          Logger.debug(`Terminal ${this.id}: Using WebGL renderer (GPU accelerated)`);
        } catch (webglError) {
          Logger.debug(`Terminal ${this.id}: Using DOM renderer (WebGL unavailable)`);
          this.webglAddon = null;
        }
      }
      this.terminal.loadAddon(this.fitAddon);
      this.terminal.loadAddon(this.serializeAddon);
      this.terminal.loadAddon(this.unicodeAddon);
      const SearchCtor = (window as any).SearchAddon?.SearchAddon;
      if (SearchCtor) {
        this.searchAddon = new SearchCtor();
        this.terminal.loadAddon(this.searchAddon);
      }
      this.setupEventHandlers();
      this.lifecycleManager.on("bootReady", () => {
        if (window.tabManager?.saveToLocalState) {
          try {
            window.tabManager.saveToLocalState();
          } catch {}
        }
      });
      this.lifecycleManager.initialize();
      this.setupFilePathLinks();
      if (this.terminal.unicode) this.terminal.unicode.activeVersion = "15-graphemes";
    } catch (e) {
      Logger.error("Terminal init failed", e);
    }
  }

  /**
   * Dispose of existing file path link providers
   */
  disposeFilePathLinks() {
    if (this.linkProviderDisposable) {
      this.linkProviderDisposable.dispose();
      this.linkProviderDisposable = null;
    }
  }

  /**
   * Set up file path link detection using xterm-link-provider library
   */
  // Link regex for file paths, directories, and URLs.
  // Used by both the library provider (single-line) and our cross-line wrapper.
  private static readonly LINK_REGEX_SRC =
    'https?:\\/\\/[^\\s"\'`()\\[\\]{}]+[^\\s"\'`()\\[\\]{}.,:;!?]' +
    '|(?:~|\\.\\..?)?\\/[^\\s"\'`()\\[\\]{}]*[^\\s"\'`()\\[\\]{}\\/.,;:!?]' +
    '|[a-zA-Z0-9_\\-\\.]+\\/[a-zA-Z0-9_\\-\\.\\/]*[a-zA-Z0-9_\\-]';

  setupFilePathLinks() {
    if (!this.terminal || !window.LinkProvider) return;

    const linkRegex = new RegExp(`(${TerminalInstance.LINK_REGEX_SRC})`);
    const terminal = this.terminal;

    const handler = (event: MouseEvent, uri: string) => {
      if (event && event.preventDefault) {
        event.preventDefault();
      }
      if (!event.metaKey && !event.ctrlKey) {
        return;
      }
      Logger.debug(`🔗 Link clicked: "${uri}"`);
      const isUrl = uri.startsWith('http://') || uri.startsWith('https://');
      if (isUrl) {
        this.vscode.postMessage({ command: "openUrl", url: uri });
      } else {
        this.vscode.postMessage({ command: "openFile", filePath: uri, terminalId: this.id });
      }
    };

    // Base provider from the library (handles single-line links)
    const baseProvider = new window.LinkProvider(terminal, linkRegex, handler);

    // Wrapping provider that also detects links split across hard-wrapped lines.
    // Claude Code (via Ink) inserts \r\n at terminal width, splitting URLs/paths.
    // We detect when a match ends at the terminal width and the next line
    // continues with valid URL/path characters (no leading whitespace/escapes).
    const crossLineProvider = {
      provideLinks: (y: number, callback: (links: any[] | undefined) => void) => {
        // First, get the library's single-line results
        baseProvider.provideLinks(y, (baseLinks: any[] | undefined) => {
          if (!baseLinks || baseLinks.length === 0) {
            callback(baseLinks);
            return;
          }

          const enhanced: any[] = [];
          for (const link of baseLinks) {
            const startY = link.range.start.y;
            const endX = link.range.end.x;
            const endY = link.range.end.y;

            // Case 1: library joined soft-wrapped rows (isWrapped = true on next line).
            // Re-validate against the first row only — prevents "alterminalLoading"-style
            // false matches when a path line ends exactly at terminal width.
            if (startY !== endY) {
              const startX0 = link.range.start.x - 1; // 0-based cell column
              // link.text spans rows; the first-row portion is at most (cols - startX0) chars
              const firstRowPortion = link.text.substring(0, terminal.cols - startX0);
              const singleRe = new RegExp('^(?:' + TerminalInstance.LINK_REGEX_SRC + ')');
              const m = singleRe.exec(firstRowPortion);
              if (m) {
                enhanced.push({
                  ...link,
                  range: {
                    start: link.range.start,
                    end: { x: startX0 + m[0].length, y: startY },
                  },
                  text: m[0],
                  activate: handler,
                });
              }
              continue;
            }

            // Case 2: single-row link — check for hard-wrap (cross-line) continuation
            if (endX >= terminal.cols - 2) {
              // Peek at next line(s) for continuation
              let joinedText = link.text;
              let lastY = endY;

              while (true) {
                const nextLine = terminal.buffer.active.getLine(lastY); // 0-based = lastY (since lastY is 1-based row)
                if (!nextLine || nextLine.isWrapped) break; // isWrapped lines are already handled by the library

                const nextText = nextLine.translateToString(true);
                // Continuation: no leading whitespace or escape sequences
                if (!nextText || /^[\s\x1b]/.test(nextText)) break;

                // Match valid URL/path continuation chars at start of line
                const contMatch = nextText.match(/^[^\s"'`()[\]{},;:!?]+/);
                if (!contMatch) break;

                joinedText += contMatch[0];
                lastY++;

                // If continuation doesn't fill the line, stop
                if (contMatch[0].length < nextText.trimEnd().length - 2) break;
              }

              if (lastY > endY) {
                // Validate joined text
                const validationRe = new RegExp(TerminalInstance.LINK_REGEX_SRC);
                const validated = validationRe.exec(joinedText);
                if (validated && validated[0].length > link.text.length) {
                  // Find where the continuation ends on the last line
                  const lastLine = terminal.buffer.active.getLine(lastY - 1);
                  const lastLineText = lastLine?.translateToString(true) || '';
                  const contOnLastLine = lastLineText.match(/^[^\s"'`()[\]{},;:!?]+/);
                  const endXOnLastLine = contOnLastLine ? contOnLastLine[0].length : 1;

                  enhanced.push({
                    ...link,
                    range: {
                      start: link.range.start,
                      end: { x: endXOnLastLine + 1, y: lastY },
                    },
                    text: validated[0],
                    activate: handler,
                  });
                  continue;
                }
              }
            }

            enhanced.push(link);
          }

          callback(enhanced.length > 0 ? enhanced : undefined);
        });
      },
    };

    try {
      this.linkProviderDisposable = terminal.registerLinkProvider(crossLineProvider);
    } catch (error) {
      console.error("Failed to register link provider:", error);
    }
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
        if (window.tabManager && window.tabManager.scheduleSaveState) {
          window.tabManager.scheduleSaveState("inputData");
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

    // Bell handler — \x07 is stripped before reaching xterm.js, so this
    // should rarely fire. Kept as a safety net for edge cases.
    this.bellDisposable = this.terminal.onBell(() => {
      this.vscode.postMessage({
        command: "bellDiagnostic",
        tabId: this.id,
        source: "xterm.js",
      });
      if (this.onBellReceived) {
        this.onBellReceived(this.id);
      }
    });

    // Background-activity signal: any PTY output marks an inactive tab as
    // having unread activity. Active tabs ignore — they are already visible.
    if (typeof this.terminal.onWriteParsed === "function") {
      this.writeParsedDisposable = this.terminal.onWriteParsed(() => {
        if (this.isActive) return;
        this.onActivity?.(this.id);
      });
    }

    // Set up OSC title change handler (fired by \x1b]0;title\x07 or \x1b]2;title\x07)
    // Deferred via queueMicrotask to avoid blocking the synchronous
    // terminal.write() → render path (onTitleChange fires mid-write).
    if (typeof this.terminal.onTitleChange === "function") {
      this.titleChangeDisposable = this.terminal.onTitleChange((title: string) => {
        this.oscTitle = title || null;
        this._isDirty = true;
        queueMicrotask(() => {
          if (window.tabManager?.handleOscTitleChange) {
            window.tabManager.handleOscTitleChange(this.id, title);
          }
        });
      });
    }

    // OSC 52 — clipboard. Programs send \x1b]52;c;<base64>\x07 to copy text.
    // The webview has clipboard access, so we handle it directly here.
    if (this.terminal.parser?.registerOscHandler) {
      this.osc52Disposable = this.terminal.parser.registerOscHandler(52, (data: string) => {
        // Format: "c;<base64>" or ";<base64>" — the first field selects clipboard
        // buffer (c=clipboard, p=primary, etc.). We always target the system clipboard.
        const semiIdx = data.indexOf(';');
        if (semiIdx === -1) return false;

        const payload = data.substring(semiIdx + 1);
        if (!payload || payload === '?') return false; // '?' is a read request — skip

        try {
          const text = atob(payload);
          // Use the extension host's clipboard API (works in tunnel mode too)
          this.vscode.postMessage({ command: 'clipboardCopy', text });
          Logger.debug(`📋 OSC 52 clipboard copy (${text.length} chars)`);
        } catch (e) {
          Logger.warn('OSC 52 decode failed:', e);
          return false;
        }
        return true;
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

        // Fit IMMEDIATELY to get correct dimensions before PTY creation
        // This must happen before onRender listener is set up
        if (this.fitAddon && container.offsetWidth > 0 && container.offsetHeight > 0) {
          this.fitAddon.fit();
        }

        // Also listen for terminal render events to ensure links work if content changes
        // This is set up AFTER fit so createPtyProcess gets correct dimensions
        if (typeof this.terminal.onRender === "function") {
          this.renderDisposable = this.terminal.onRender(() => {
            this._markOpened();
          });
        }

        // Additional delayed fit to catch any layout changes
        setTimeout(() => this.fit(), 100);
      }

      // Fit the terminal to container on subsequent calls
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

  private _markOpened() {
    if (this._openedResolved) return;
    this._openedResolved = true;
    if (this._openedResolve) {
      try {
        (this._openedResolve as any)();
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
   * Write data to the terminal
   */
  write(data) {
    if (!this.terminal) return;
    try {
      const buf = this.terminal.buffer?.active;
      const ydispBefore = buf?.viewportY ?? -1;
      this.terminal.write(data);
      this._isDirty = true;
      // Detect viewport snap — log if ydisp changes unexpectedly
      const ydispAfter = buf?.viewportY ?? -1;
      if (ydispBefore !== -1 && ydispAfter !== ydispBefore) {
        const ybase = buf?.baseY ?? -1;
        const wasScrolledUp = ydispBefore < ybase;
        if (wasScrolledUp) {
          Logger.warn(`[scroll-snap] tab ${this.id}: ydisp ${ydispBefore}→${ydispAfter} (ybase=${ybase})`);
        }
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
    if (!this.fitAddon || !this.terminal || !this.terminalContainer) return;

    // Only fit if container has meaningful dimensions
    const containerWidth = this.terminalContainer.offsetWidth;
    const containerHeight = this.terminalContainer.offsetHeight;

    if (containerWidth < 10 || containerHeight < 10) {
      return;
    }

    const prevCols = this.terminal.cols;
    const prevRows = this.terminal.rows;

    try {
      this.fitAddon.fit();
    } catch (error) {
      Logger.error(`Failed to fit terminal ${this.id}:`, error);
      return;
    }

    // When dimensions change, clear the visible screen so full-screen TUI
    // apps (Ink/Claude Code) redraw cleanly after SIGWINCH. Without this,
    // cursor-positioned content from the old layout remains as ghost artifacts.
    if (this.terminal.cols !== prevCols || this.terminal.rows !== prevRows) {
      this.terminal.write('\x1b[2J');
    }
  }

  /**
   * Clear the terminal
   */
  clear() {
    if (!this.terminal) return;

    try {
      this.terminal.clear();
      
      // Invalidate cached state since we just cleared
      this._cachedSerializedState = null;
      this._isDirty = true;
      
      // Reset interaction tracking since user is starting fresh
      this.resetUserInteraction();
      
      // Schedule a snapshot capture after the shell redraws the prompt
      setTimeout(() => {
        try {
          this._isDirty = true; // Force fresh serialize
          const snap = this.serialize();
          if (snap && snap.trim().length > 0) {
            if (window.tabManager?.scheduleSaveState) {
              window.tabManager.scheduleSaveState("terminalClear");
            }
            Logger.debug(
              `🧹 Post-clear snapshot captured for terminal ${this.id} (chars=${snap.length})`,
            );
          }
        } catch (e) {
          Logger.warn(`Failed to capture post-clear snapshot for terminal ${this.id}:`, e);
        }
      }, 100); // delay to allow prompt redraw

      Logger.debug(`Terminal ${this.id} cleared`);
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
          this.focus();
          try {
            performance.mark(`t${this.id}-active`);
            if (window.tabManager && window.tabManager._recordTerminalTiming) {
              window.tabManager._recordTerminalTiming(this.id);
            }
          } catch (e) {
            // Performance timing is non-critical, ignore failures
          }
          // Debounce fit to avoid cascading calls during activation.
          // Send a nudge resize first (cols-1) to guarantee SIGWINCH,
          // which forces apps to redraw (especially after daemon reattach).
          Debouncer.debounce(
            `term-activate-fit-${this.id}`,
            50,
            () => {
              if (this.terminal && this.terminal.cols > 1) {
                this.sendResizeToPty(this.terminal.cols - 1, this.terminal.rows);
              }
              this.fit();
            },
            { maxWait: 100 },
          );
        });
      });
    }
  }

  /**
   * Serialize terminal state for persistence
   * Uses cached state if terminal hasn't changed (dirty tracking optimization)
   */
  serialize() {
    if (!this.serializeAddon) {
      return null;
    }

    // Return cached state if not dirty (performance optimization)
    if (!this._isDirty && this._cachedSerializedState !== null) {
      return this._cachedSerializedState;
    }

    try {
      let serialized = this.serializeAddon.serialize({
        scrollback: window.scrollbackLines || TERMINAL_DEFAULTS.SCROLLBACK,
        excludeAltBuffer: true,
        excludeModes: false,
      });

      // Cache the serialized state and mark as clean
      this._cachedSerializedState = serialized;
      this._isDirty = false;

      return serialized;
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
      // Replace BEL (\x07) with ST (\x1b\\) in restored content.
      // Saved buffers contain OSC 8 hyperlinks whose \x07 terminators
      // would trigger xterm.js onBell during replay.
      const cleanContent = serializedContent.replace(/\x07/g, "\x1b\\");

      // Write content directly - xterm.js 6.0.0 handles all sequences properly
      this.terminal.write(cleanContent, () => {});

      // Mark as dirty and cache the restored content so serialize() works immediately
      this._isDirty = false; // Content is already saved, mark as clean
      this._cachedSerializedState = serializedContent; // Cache the restored content

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

    return {
      uuid: this.uuid,
      id: this.id,
      label: this.label,
      baseLabel: this.baseLabel,
      icon: this.icon,
      buffer: shouldSaveBuffer ? this.serialize() || "" : "",
      launchCommand: this.launchCommand,
      hasUserInteraction: this.hasUserInteraction,
      cwd: this.cwd,
      oscTitle: this.oscTitle,
      userVars: this.userVars,
      titleTemplate: this.titleTemplate,
    };
  }

  /**
   * Restore terminal from state
   */
  restoreFromState(state) {
    if (!state) return;

    // Restore UUID if available, keep constructor-generated one if missing (migration)
    if (state.uuid) {
      this.uuid = state.uuid;
    }

    this.label = state.label || this.label;

    // Restore clean base label, fallback to extracting from current label
    this.baseLabel = state.baseLabel || this.label.split(" •")[0] || "Terminal";

    // Restore icon if available
    this.icon = state.icon || this.icon;

    // Restore interaction flag
    this.hasUserInteraction = state.hasUserInteraction || false;

    // Restore working directory if available
    this.cwd = state.cwd || null;

    // Restore OSC title if available
    this.oscTitle = state.oscTitle || null;

    // Restore user variables if available
    this.userVars = state.userVars || null;

    // Restore per-tab title template
    this.titleTemplate = state.titleTemplate || null;

    // Restore terminal modes through modeProvider
    // Restore launch command and derive terminal type
    this.launchCommand = state.launchCommand || this.launchCommand;
    this.terminalType = this.launchCommand ? "command" : "default";

    // Restore buffer content if available (not for command terminals)
    if (!this.launchCommand && state.buffer) {
      this.deserialize(state.buffer);
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
    this.resizeDisposable = this.disposeEventHandler(this.resizeDisposable);
    this.bellDisposable = this.disposeEventHandler(this.bellDisposable);
    this.titleChangeDisposable = this.disposeEventHandler(this.titleChangeDisposable);
    this.osc52Disposable = this.disposeEventHandler(this.osc52Disposable);
    this.renderDisposable = this.disposeEventHandler(this.renderDisposable);
    this.writeParsedDisposable = this.disposeEventHandler(this.writeParsedDisposable);

    // Dispose link providers
    if (this.linkProviders) {
      this.linkProviders.forEach(({ provider, disposable }) => {
        try {
          if (disposable && disposable.dispose) {
            disposable.dispose();
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

    // Get current terminal dimensions to pass to PTY
    const cols = this.terminal?.cols || 80;
    const rows = this.terminal?.rows || 30;

    this.vscode.postMessage({
      command: "createPty",
      tabId: this.id,
      uuid: this.uuid,
      terminalType: this.terminalType,
      launchCommand: this.launchCommand,
      cwd: this.cwd || undefined,
      shellPath: this.shellPath || undefined,
      cols: cols,
      rows: rows,
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
      this.disposeFilePathLinks();

      // Dispose event handlers
      this.disposeEventHandlers();

      // Clean up visibility change listener
      if (this._visibilityHandler) {
        document.removeEventListener("visibilitychange", this._visibilityHandler);
        this._visibilityHandler = undefined;
      }

      // Clean up WebGL context-loss handlers
      if (this._webglContextLostHandlers) {
        for (const { canvas, handler } of this._webglContextLostHandlers) {
          canvas.removeEventListener("webglcontextlost", handler);
        }
        this._webglContextLostHandlers = undefined;
      }

      // Clean up resize observer
      if (this._resizeObserver) {
        this._resizeObserver.disconnect();
        this._resizeObserver = undefined;
      }

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
    } catch (error) {
      Logger.error(`Failed to dispose terminal ${this.id}:`, error);
    }
  }

  private _installVisibilityHandlers() {
    if (this._visibilityInstalled) return;
    this._visibilityInstalled = true;

    // Only observe the terminal container itself (parent changes cascade down)
    if (this.terminalContainer && "ResizeObserver" in window) {
      const ro = new ResizeObserver(() => {
        if (this.isActive && this.terminalContainer) {
          try {
            this.fit();
          } catch (e) {
            Logger.warn(`Fit failed for terminal ${this.id}:`, e);
          }
        }
      });
      ro.observe(this.terminalContainer);
      this._resizeObserver = ro;
    }
    // Store handler for cleanup
    this._visibilityHandler = () => {
      if (!document.hidden && this.isActive) {
        requestAnimationFrame(() => {
          if (this.terminal) {
            // this.terminal.refresh(0, this.terminal.rows - 1);
            this.fit();
          }
        });
      }
    };
    document.addEventListener("visibilitychange", this._visibilityHandler);
    // WebGL context loss fallback
    this._webglContextLostHandlers = [];
    const attachWebglHandlers = () => {
      const cvs = this.terminalContainer?.querySelectorAll("canvas") || [];
      if (!cvs.length) return false;
      cvs.forEach((cv) => {
        const handler = (e: Event) => {
          e.preventDefault();
          Logger.warn("WebGL context lost at canvas level");
          this.showWebGLError();
        };
        cv.addEventListener("webglcontextlost", handler, { passive: false });
        this._webglContextLostHandlers!.push({ canvas: cv, handler });
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

    // ResizeObserver handles container size changes - MutationObserver removed
    // to eliminate performance overhead from observing entire document.body
  }

  /**
   * Show a user-visible error overlay when WebGL context is lost
   */
  showWebGLError(): void {
    if (!this.terminalContainer) return;

    // Don't show multiple overlays
    if (this.terminalContainer.querySelector(".webgl-error-overlay")) return;

    const overlay = document.createElement("div");
    overlay.className = "webgl-error-overlay";
    overlay.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--vscode-panel-background, #1e1e1e);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      gap: 12px;
    `;

    const message = document.createElement("div");
    message.style.cssText = `
      color: var(--vscode-errorForeground, #f48771);
      font-size: 14px;
      text-align: center;
      padding: 0 20px;
    `;
    message.textContent = "Terminal rendering error: WebGL context was lost.";

    const refreshButton = document.createElement("button");
    refreshButton.style.cssText = `
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #ffffff);
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
    `;
    refreshButton.textContent = "Refresh Terminal";
    refreshButton.addEventListener("click", () => {
      // Request a refresh from the extension
      this.vscode.postMessage({ command: "refresh" });
    });

    overlay.appendChild(message);
    overlay.appendChild(refreshButton);
    this.terminalContainer.appendChild(overlay);
  }

}
