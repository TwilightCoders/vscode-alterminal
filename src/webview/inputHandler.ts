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

import { Logger } from "./logger.js";

export class InputHandler {
  public terminal: any;
  public tabId: any;
  public vscode: any;
  public saveState: any;
  public terminalInstance: any;
  public disposables: any[] = [];

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
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const cmdOrCtrl = isMac ? event.metaKey : event.ctrlKey;

      // Pass through function keys (F1-F12) to VS Code
      if (key.startsWith('F') && key.length <= 3) {
        const fNum = parseInt(key.substring(1));
        if (fNum >= 1 && fNum <= 12) {
          return false; // Let VS Code handle it
        }
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

      // Terminal navigation keys
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

    // Allow normal terminal processing for all other keys
    return true;
  }

  /**
   * Handle regular input data from terminal
   */
  handleInputData(data: string): void {
    // Check if this input represents meaningful user interaction
    if (this.isMeaningfulInput(data)) {
      if (this.terminalInstance && typeof this.terminalInstance.markUserInteraction === 'function') {
        this.terminalInstance.markUserInteraction();
      }

      // Log Enter key presses specifically for focus debugging
      if (data.includes('\r') || data.includes('\n')) {
        Logger.info("🔍 [FOCUS DEBUG] Enter key pressed, sending to PTY");
      }
    }

    // Send user input to PTY process
    this.sendDataToPty(data);

    // Save state after input
    if (this.saveState) {
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
    });
  }

  /**
   * Send file path to PTY process for insertion
   */
  sendFilePathToPty(filePath: string): void {
    this.vscode.postMessage({
      command: "sendFilePath",
      filePath: filePath,
      tabId: this.tabId,
    });
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
    });
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
