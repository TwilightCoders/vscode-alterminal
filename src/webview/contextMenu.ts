/**
 * ContextMenu Helper
 *
 * Purpose:
 * - Helper for webview components to trigger native VS Code context menus
 * - Communicates with extension host to show OS-native context menus
 * - Clean API for context menu actions
 *
 * Responsibilities:
 * - Send context menu requests to extension host
 * - Handle context menu item actions via messaging
 * - Provide simple API for webview components
 *
 * Key Features:
 * - Native OS context menu integration via VS Code API
 * - Clean messaging interface with extension host
 * - Tab-specific context menu items
 */

interface TabContextMenuOptions {
  tabId: string;
  terminalType: string;
  launchCommand?: string;
  x: number;
  y: number;
}

export class ContextMenu {
  private vscode: any;

  constructor(vscode: any) {
    this.vscode = vscode;
  }

  /**
   * Show context menu for a tab at mouse position
   */
  showTabContextMenu({ tabId, terminalType, launchCommand, x, y }: TabContextMenuOptions): void {
    // Send message to extension host to show native context menu
    this.vscode.postMessage({
      command: "showContextMenu",
      type: "tab",
      data: {
        tabId,
        terminalType,
        launchCommand,
        position: { x, y },
      },
    });
  }

  /**
   * Handle context menu item selection from extension host
   */
  handleContextMenuAction(action: string, context: any, callback?: (action: string, context: any) => void): void {
    if (callback) {
      callback(action, context);
    }
  }
}
