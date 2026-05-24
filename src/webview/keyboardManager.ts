/**
 * Keyboard Manager
 *
 * Handles document-level keyboard shortcuts for the webview.
 * - VS Code shortcut passthrough
 * - Terminal-specific shortcuts (clear, reset)
 *
 * Note: Per-terminal key handling (navigation, input) is in InputHandler.
 * This module handles webview-global shortcuts only.
 */

import { VSCODE_SHORTCUTS } from "../constants.js";

export interface KeyboardManagerCallbacks {
  clearActiveTerminal: () => void;
  resetActiveTerminal: () => void;
  openSearch?: () => void;
}

export class KeyboardManager {
  private callbacks: KeyboardManagerCallbacks;
  private shortcuts: typeof VSCODE_SHORTCUTS;
  private handler: ((event: KeyboardEvent) => boolean | void) | null = null;

  constructor(callbacks: KeyboardManagerCallbacks) {
    this.callbacks = callbacks;
    this.shortcuts = this.buildShortcutList();
  }

  /**
   * Build the full shortcut list including macOS variants
   */
  private buildShortcutList(): typeof VSCODE_SHORTCUTS {
    const shortcuts = [...VSCODE_SHORTCUTS];

    // Add macOS variants (Cmd instead of Ctrl)
    if (this.isMac()) {
      const macShortcuts = VSCODE_SHORTCUTS.map((shortcut) => ({
        ...shortcut,
        ctrlKey: false,
        metaKey: shortcut.ctrlKey,
      }));
      shortcuts.push(...macShortcuts);
    }

    return shortcuts;
  }

  /**
   * Check if running on macOS
   */
  private isMac(): boolean {
    return navigator.platform.indexOf("Mac") > -1;
  }

  /**
   * Set up keyboard event listeners
   */
  setup(): void {
    this.handler = (event: KeyboardEvent) => this.handleKeyDown(event);
    document.addEventListener("keydown", this.handler, true);
  }

  /**
   * Handle keydown events
   */
  private handleKeyDown(event: KeyboardEvent): boolean | void {
    const isMac = this.isMac();

    // Clear terminal: Cmd+K (Mac) or Ctrl+K (Win/Linux)
    if (
      event.key === "k" &&
      ((isMac && event.metaKey) || (!isMac && event.ctrlKey)) &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      this.callbacks.clearActiveTerminal();
      return false;
    }

    // Search active terminal: Cmd+F (Mac) or Ctrl+F (Win/Linux)
    if (
      event.key === "f" &&
      ((isMac && event.metaKey) || (!isMac && event.ctrlKey)) &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      this.callbacks.openSearch?.();
      return false;
    }

    // Reset terminal: Cmd+R (Mac) or Ctrl+R (Win/Linux)
    if (
      event.key === "r" &&
      ((isMac && event.metaKey) || (!isMac && event.ctrlKey)) &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      this.callbacks.resetActiveTerminal();
      return false;
    }

    // Check for VS Code shortcut passthrough
    const matchesShortcut = this.shortcuts.some((shortcut) => {
      return (
        event.key === shortcut.key &&
        event.ctrlKey === shortcut.ctrlKey &&
        event.shiftKey === shortcut.shiftKey &&
        event.altKey === shortcut.altKey &&
        (shortcut.metaKey === undefined || event.metaKey === shortcut.metaKey)
      );
    });

    if (matchesShortcut) {
      // Let the event bubble up to VS Code
      return true;
    }

    return true;
  }

  /**
   * Clean up event listeners
   */
  dispose(): void {
    if (this.handler) {
      document.removeEventListener("keydown", this.handler, true);
      this.handler = null;
    }
  }
}
