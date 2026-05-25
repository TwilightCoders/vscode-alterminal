/**
 * Input Handler
 *
 * Purpose:
 * - Centralized input handling for terminal instances (keyboard, mouse, drag/drop, etc.)
 * - Separates input logic from terminal display logic
 * - Provides clean abstraction for different input modes and behaviors
 *
 * Responsibilities:
 * - Handle navigation keys (Home, End, PageUp, PageDown) for scrolling
 * - Route regular input to PTY processes
 * - Handle file drag and drop operations
 * - Manage input state and modes
 * - Coordinate with terminal display without tight coupling
 *
 * Key Features:
 * - Navigation key interception to prevent unwanted scroll-to-bottom
 * - File drop handling with path insertion
 * - Clean separation between input handling and terminal display
 * - Extensible for future input handling needs (shortcuts, modes, etc.)
 */

import type { WebviewToExtMessage } from "../shared/messages.js";

export class InputHandler {
  public terminal: any;
  public tabId: any;
  public vscode: any;
  public saveState: any;
  public terminalInstance: any;
  public disposables: any[] = [];

  // Cache platform detection once (avoid navigator.platform on every keydown)
  private static readonly _isMac =
    typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;

  constructor(
    terminal: any,
    tabId: any,
    vscodePostMessage: any,
    saveStateCallback: any,
    terminalInstance: any,
  ) {
    this.terminal = terminal;
    this.tabId = tabId;
    this.vscode = { postMessage: vscodePostMessage };
    this.saveState = saveStateCallback;
    this.terminalInstance = terminalInstance;

    // Track disposables for cleanup
    this.disposables = [];

    this.setupInputHandling();
  }

  /**
   * Set up all input handling (keyboard, mouse, etc.)
   */
  setupInputHandling(): void {
    // Custom key event handler to pass through VS Code shortcuts
    this.terminal.attachCustomKeyEventHandler((event) => {
      return this.handleKeyEvent(event);
    });

    // Set up data handler for regular input
    const dataDisposable = this.terminal.onData((data) => {
      this.handleInputData(data);
    });

    this.disposables.push(dataDisposable);
  }

  /**
   * Handle key events - intercept navigation keys and pass through VS Code shortcuts
   */
  handleKeyEvent(event: KeyboardEvent): boolean {
    if (event.type === "keydown") {
      const key = event.key;
      const isMac = InputHandler._isMac;
      const cmdOrCtrl = isMac ? event.metaKey : event.ctrlKey;

      // Pass through function keys (F1-F12) to VS Code
      if (key.startsWith('F') && key.length <= 3) {
        const fNum = parseInt(key.substring(1));
        if (fNum >= 1 && fNum <= 12) {
          return false; // Let VS Code handle it
        }
      }

      // Clipboard: Copy
      if (key === 'c' && (isMac ? event.metaKey : (event.ctrlKey && this.terminal.hasSelection()))) {
        if (this.terminal.hasSelection()) {
          const text = this.terminal.getSelection();
          this.vscode.postMessage({ command: "clipboardCopy", text } satisfies WebviewToExtMessage);
          if ((window as any).clearSelectionOnCopy !== false) {
            this.terminal.clearSelection();
          }
        }
        return false;
      }

      // Clipboard: Paste — let xterm.js handle it natively via the browser
      // paste event.  Returning false prevents Ctrl+V from sending ^V
      // (literal-next) to the terminal on Linux/Windows.
      if (key === 'v' && (isMac ? event.metaKey : event.ctrlKey) && !event.shiftKey) {
        return false;
      }

      // Pass through common VS Code shortcuts
      if (cmdOrCtrl && event.shiftKey) {
        // Cmd/Ctrl+Shift combinations (command palette, etc.)
        return false; // Let VS Code handle it
      }

      // Allow default terminal behavior for arrow keys
      if (key === "ArrowUp" || key === "ArrowDown") {
        return true; // Terminal handles for shell history
      }

      // Terminal navigation keys — only intercept for xterm scrollback
      // when on the normal screen. When an alternate-screen program is
      // running (tmux, vim, less, etc.) pass them through to the PTY.
      const isAltScreen = this.terminal.buffer?.active?.type === "alternate";
      if (!isAltScreen) {
        switch (key) {
          case "Home":
            this.terminal.scrollToTop();
            return false;

          case "End":
            this.terminal.scrollToBottom();
            return false;

          case "PageUp":
            this.terminal.scrollPages(-1);
            return false;

          case "PageDown":
            this.terminal.scrollPages(1);
            return false;
        }
      }
    }

    // Allow normal terminal processing for all other keys
    return true;
  }

  /**
   * Handle regular input data from terminal
   */
  handleInputData(data: string): void {
    // Check if this input represents meaningful user interaction
    const meaningful = this.isMeaningfulInput(data);
    if (meaningful) {
      if (this.terminalInstance && typeof this.terminalInstance.markUserInteraction === 'function') {
        this.terminalInstance.markUserInteraction();
      }
    }

    // Send user input to PTY process
    this.sendDataToPty(data);

    // Only save state after meaningful input (Enter, Ctrl+C, etc.)
    // Regular typing just needs to reach the PTY — no need to serialize
    // all terminals and push state to the extension on every keystroke.
    if (meaningful && this.saveState) {
      this.saveState();
    }
  }

  /**
   * Check if input represents meaningful user interaction that should trigger state saving
   */
  isMeaningfulInput(data: string): boolean {
    if (!data || typeof data !== 'string') return false;
    
    // Check for Enter key (carriage return/newline - the main trigger)
    if (data.includes('\r') || data.includes('\n')) return true;
    
    // Check for common control sequences that generate output:
    // Ctrl+C (ETX - End of Text)
    if (data.includes('\x03')) return true;
    
    // Ctrl+D (EOT - End of Transmission, often used to exit/logout)
    if (data.includes('\x04')) return true;
    
    // Ctrl+Z (SUB - Substitute, usually suspend)
    if (data.includes('\x1A')) return true;
    
    // Tab completion (HT - Horizontal Tab) - might show completions
    if (data.includes('\x09')) return true;
    
    return false;
  }

  /**
   * Send data to PTY process
   */
  sendDataToPty(data: string): void {
    this.vscode.postMessage({
      command: "data",
      data: data,
      tabId: this.tabId,
    } satisfies WebviewToExtMessage);
  }

  /**
   * Send file path to PTY process for insertion
   */
  sendFilePathToPty(filePath: string): void {
    this.vscode.postMessage({
      command: "sendFilePath",
      filePath: filePath,
      tabId: this.tabId,
    } satisfies WebviewToExtMessage);
  }

  /**
   * Send file data to PTY process
   */
  sendFileDataToPty(fileData: string, fileName: string, fileType: string): void {
    this.vscode.postMessage({
      command: "sendFileData",
      fileData: fileData,
      fileName: fileName,
      fileType: fileType,
      tabId: this.tabId,
    } satisfies WebviewToExtMessage);
  }

  /**
   * Dispose of event handlers
   */
  dispose(): void {
    this.disposables.forEach((disposable) => {
      if (disposable && disposable.dispose) {
        disposable.dispose();
      }
    });
    this.disposables = [];
  }
}
