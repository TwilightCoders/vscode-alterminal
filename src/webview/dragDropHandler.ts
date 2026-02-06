/**
 * Drag and Drop Handler
 *
 * Purpose:
 * - Manages file drag and drop functionality for the terminal webview
 * - Routes dropped files to the active terminal tab
 * - Handles visual feedback and file processing
 *
 * Responsibilities:
 * - Set up drag and drop event listeners on the terminal area
 * - Provide visual feedback during drag operations
 * - Read and process different file types (text, images, binary)
 * - Route processed files to the active terminal via VS Code messaging
 *
 * Key Features:
 * - Automatic active terminal detection
 * - Support for multiple file types with appropriate handling
 * - Clean event management and error handling
 * - VS Code webview integration
 */

export class DragDropHandler {
  private vscode: any;
  private tabManager: any;
  private initialized: boolean;
  private target: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;
  private dragDepth = 0;
  private _dragEnterHandler: ((e: DragEvent) => void) | null = null;
  private _dragOverHandler: ((e: DragEvent) => void) | null = null;
  private _dragLeaveHandler: ((e: DragEvent) => void) | null = null;
  private _dropHandler: ((e: DragEvent) => void) | null = null;

  constructor(vscode: any, tabManager: any) {
    this.vscode = vscode;
    this.tabManager = tabManager;
    this.initialized = false;
  }

  /**
   * Initialize drag and drop functionality
   */
  initialize(): void {
    if (this.initialized) return;

  const container = document.getElementById("container");
    const terminalContainer = document.querySelector<HTMLElement>(".terminal-container canvas");
  this.overlay = document.getElementById("file-drop-overlay");

    if (!container) {
      console.error("Container not found for drag setup");
      return;
    }

    // Set up drag and drop on the main terminal container
    this.target = (terminalContainer as HTMLElement) || container;
    this.setupEventListeners();
    this.initialized = true;
  }

  /**
   * Set up all drag and drop event listeners
   */
  setupEventListeners(): void {
    this._dragEnterHandler = (e) => this.handleDragEnter(e);
    this._dragOverHandler = (e) => this.handleDragOver(e);
    this._dragLeaveHandler = (e) => this.handleDragLeave(e);
    this._dropHandler = (e) => this.handleDrop(e);
    this.target.addEventListener("dragenter", this._dragEnterHandler);
    this.target.addEventListener("dragover", this._dragOverHandler);
    this.target.addEventListener("dragleave", this._dragLeaveHandler);
    this.target.addEventListener("drop", this._dropHandler);
  }

  /**
   * Handle drag enter events
   */
  handleDragEnter(e: DragEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.dragDepth++;
    if (this.overlay && this.dragDepth === 1) {
      this.overlay.classList.add("show");
    }
  }

  /**
   * Handle drag over events - show visual feedback
   */
  handleDragOver(e: DragEvent): void {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";

    // Ensure overlay is visible during dragover (fixes re-entry issue)
    if (this.overlay && !this.overlay.classList.contains("show")) {
      this.overlay.classList.add("show");
      this.dragDepth = 1;
    }

    // Apply subtle visual feedback using VS Code's terminal drop background
    const dropBackground =
      getComputedStyle(document.body).getPropertyValue(
        "--vscode-terminal-dropBackground",
      ) || "rgba(255, 255, 255, 0.05)";
    this.target.style.backgroundColor = dropBackground;
    this.target.style.transition = "background-color 0.15s ease";
  }

  /**
   * Handle drag leave events - remove visual feedback
   */
  handleDragLeave(e: DragEvent): void {
    e.preventDefault();
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      this.clearVisualFeedback();
    }
  }

  /**
   * Handle drop events - process dropped files
   */
  async handleDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    this.clearVisualFeedback();
  this.dragDepth = 0;

    if (e.dataTransfer.files.length > 0) {
      // Get the active terminal ID from TabManager
      const activeTabId = this.tabManager ? this.tabManager.activeTabId : 1;

      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const file = e.dataTransfer.files[i];
        await this.processDroppedFile(file, activeTabId);
      }
    }
  }

  /**
   * Clear all visual feedback
   */
  clearVisualFeedback(): void {
    this.target.style.backgroundColor = "";
    if (this.overlay) {
      this.overlay.classList.remove("show");
    }
  }

  /**
   * Process a dropped file and send to extension host
   */
  async processDroppedFile(file: File, tabId: number): Promise<void> {
    try {
      let fileData = null;

      if (file.type.startsWith("image/") || !file.type.startsWith("text/")) {
        // For images and binary files, read as data URL (base64)
        fileData = await this.readFileAsDataURL(file);
      } else {
        // For text files, read as text
        fileData = await this.readFileAsText(file);
      }

      // Send to extension host with active tab ID
      if (this.vscode) {
        this.vscode.postMessage({
          command: "fileDrop",
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          fileData: fileData,
          tabId: tabId,
        });
      }
    } catch (error) {
      console.error("Error handling dropped file:", error);
    }
  }

  /**
   * Read file as data URL (base64)
   */
  readFileAsDataURL(file: File): Promise<string | ArrayBuffer | null> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /**
   * Read file as text
   */
  readFileAsText(file: File): Promise<string | ArrayBuffer | null> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  /**
   * Dispose of the drag drop handler
   */
  dispose(): void {
    if (this.target && this.initialized) {
      if (this._dragEnterHandler) {
        this.target.removeEventListener("dragenter", this._dragEnterHandler);
        this._dragEnterHandler = null;
      }
      if (this._dragOverHandler) {
        this.target.removeEventListener("dragover", this._dragOverHandler);
        this._dragOverHandler = null;
      }
      if (this._dragLeaveHandler) {
        this.target.removeEventListener("dragleave", this._dragLeaveHandler);
        this._dragLeaveHandler = null;
      }
      if (this._dropHandler) {
        this.target.removeEventListener("drop", this._dropHandler);
        this._dropHandler = null;
      }
      this.target.style.backgroundColor = "";
      this.initialized = false;
    }
    if (this.overlay) {
      this.overlay.classList.remove("show");
    }
  }
}
