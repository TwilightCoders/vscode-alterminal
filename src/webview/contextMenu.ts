// @ts-nocheck
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

export class ContextMenu {
    constructor(vscode) {
        this.vscode = vscode;
    }

    /**
     * Show context menu for a tab at mouse position
     * @param {object} options - Context menu options
     * @param {string} options.tabId - Tab ID for context-specific actions
     * @param {string} options.terminalType - Terminal type (command, shell, etc)
     * @param {string} options.command - Launch command for command tabs
     * @param {number} options.x - Mouse X position
     * @param {number} options.y - Mouse Y position
     */
    showTabContextMenu({ tabId, terminalType, command, x, y }) {
        // Send message to extension host to show native context menu
        this.vscode.postMessage({
            command: 'showContextMenu',
            type: 'tab',
            data: {
                tabId,
                terminalType,
                command,
                position: { x, y }
            }
        });
    }

    /**
     * Handle context menu item selection from extension host
     * @param {string} action - Selected action
     * @param {object} context - Context data from menu request
     * @param {Function} callback - Callback to handle the action
     */
    handleContextMenuAction(action, context, callback) {
        if (callback) {
            callback(action, context);
        }
    }
}