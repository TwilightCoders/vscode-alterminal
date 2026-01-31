// @ts-nocheck
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
  setupInputHandling() {
    // Disable custom key event handler that was interfering with normal terminal operation
    // Let xterm.js handle all keyboard input naturally
    // this.terminal.attachCustomKeyEventHandler((event) => {
    //   return this.handleKeyEvent(event);
    // });

    // Set up data handler for regular input
    const dataDisposable = this.terminal.onData((data) => {
      this.handleInputData(data);
    });

    this.disposables.push(dataDisposable);
  }

  /**
   * Handle key events - intercept navigation keys, allow others
   */
  handleKeyEvent(event) {
    if (event.type === "keydown") {
      // Allow default terminal behavior for arrow keys so shell history works only when intended
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        return true; // don't intercept; xterm will handle + send to PTY
      }
      switch (event.key) {
        case "Home":
          // Home: scroll to very top
          this.terminal.scrollToTop();
          return false; // Prevent default handling

        case "End":
          // End: scroll to very bottom
          this.terminal.scrollToBottom();
          return false; // Prevent default handling

        case "PageUp":
          // Page Up: scroll up one page
          this.terminal.scrollPages(-1);
          return false; // Prevent default handling

        case "PageDown":
          // Page Down: scroll down one page
          this.terminal.scrollPages(1);
          return false; // Prevent default handling
      }
    }

    // Return true to allow normal processing for all other keys
    return true;
  }

  /**
   * Handle regular input data from terminal
   */
  handleInputData(data) {
    // Check if this input represents meaningful user interaction
    if (this.isMeaningfulInput(data)) {
      if (this.terminalInstance && typeof this.terminalInstance.markUserInteraction === 'function') {
        this.terminalInstance.markUserInteraction();
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
  isMeaningfulInput(data) {
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
  sendDataToPty(data) {
    this.vscode.postMessage({
      command: "data",
      data: data,
      tabId: this.tabId,
    });
  }

  /**
   * Send file path to PTY process for insertion
   */
  sendFilePathToPty(filePath) {
    this.vscode.postMessage({
      command: "sendFilePath",
      filePath: filePath,
      tabId: this.tabId,
    });
  }

  /**
   * Send file data to PTY process
   */
  sendFileDataToPty(fileData, fileName, fileType) {
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
  dispose() {
    this.disposables.forEach((disposable) => {
      if (disposable && disposable.dispose) {
        disposable.dispose();
      }
    });
    this.disposables = [];
  }
}
