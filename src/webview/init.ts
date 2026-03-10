/**
 * Alterminal Initialization Script
 *
 * This script runs when the webview loads and:
 * 1. Sets up terminal theme from VS Code colors
 * 2. Initializes TabManager with saved state or empty state
 * 3. Sets up drag and drop handlers
 * 4. Makes components globally accessible for debugging
 */

import { TabManager } from "./tabManager.js";
import { DragDropHandler } from "./dragDropHandler.js";


// No configuration needed - webview will receive commands from extension

// Terminal theme configuration with debugging
function getVSCodeColor(cssVar: string, fallback: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(cssVar);
  const isFromVSCode = !!value;
  const finalColor = value || fallback;
  // console.log(`${cssVar}: ${isFromVSCode ? 'VS Code' : 'FALLBACK'} -> ${finalColor}`);
  return finalColor;
}

// Terminal theme configuration with full ANSI color palette
const terminalTheme = {
  background: getVSCodeColor("--vscode-panel-background", "#ff0000"),
  foreground: getVSCodeColor("--vscode-terminal-foreground", "#cccccc"),
  cursor: getVSCodeColor("--vscode-terminalCursor-foreground", "#cccccc"),
  cursorAccent: getVSCodeColor("--vscode-terminalCursor-background", "#1e1e1e"),
  selectionBackground: getVSCodeColor(
    "--vscode-terminal-selectionBackground",
    "rgba(255, 255, 255, 0.3)",
  ),

  // ANSI Colors (normal)
  black: getVSCodeColor("--vscode-terminal-ansiBlack", "#000000"),
  red: getVSCodeColor("--vscode-terminal-ansiRed", "#cd3131"),
  green: getVSCodeColor("--vscode-terminal-ansiGreen", "#0dbc79"),
  yellow: getVSCodeColor("--vscode-terminal-ansiYellow", "#e5e510"),
  blue: getVSCodeColor("--vscode-terminal-ansiBlue", "#2472c8"),
  magenta: getVSCodeColor("--vscode-terminal-ansiMagenta", "#bc3fbc"),
  cyan: getVSCodeColor("--vscode-terminal-ansiCyan", "#11a8cd"),
  white: getVSCodeColor("--vscode-terminal-ansiWhite", "#e5e5e5"),

  // ANSI Colors (bright)
  brightBlack: getVSCodeColor("--vscode-terminal-ansiBrightBlack", "#666666"),
  brightRed: getVSCodeColor("--vscode-terminal-ansiBrightRed", "#f14c4c"),
  brightGreen: getVSCodeColor("--vscode-terminal-ansiBrightGreen", "#23d18b"),
  brightYellow: getVSCodeColor("--vscode-terminal-ansiBrightYellow", "#f5f543"),
  brightBlue: getVSCodeColor("--vscode-terminal-ansiBrightBlue", "#3b8eea"),
  brightMagenta: getVSCodeColor(
    "--vscode-terminal-ansiBrightMagenta",
    "#d670d6",
  ),
  brightCyan: getVSCodeColor("--vscode-terminal-ansiBrightCyan", "#29b8db"),
  brightWhite: getVSCodeColor("--vscode-terminal-ansiBrightWhite", "#e5e5e5"),
};

// Color utility
function getThemeColor(cssVariable: string, fallback: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(cssVariable);
  return value || fallback;
}

// Initialize everything when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeAll);
} else {
  initializeAll();
}

function initializeAll(): void {
  // Initialize the TabManager (it handles everything now)
  const tabManager = new TabManager(vscode, terminalTheme, getThemeColor);
  // Make it globally accessible for debugging
  window.tabManager = tabManager;

  // Initialize global CMD key state tracking for two-tier link system
  window.linkModeState = {
    isCmdPressed: false,
    isCtrlPressed: false,
  };

  // Named handlers for CMD/Ctrl key detection (stored for cleanup)
  function handleKeyDown(event: KeyboardEvent): void {
    const isMac = navigator.platform.indexOf("Mac") > -1;
    const wasCmdPressed = window.linkModeState.isCmdPressed;
    const wasCtrlPressed = window.linkModeState.isCtrlPressed;

    if (isMac && event.metaKey) {
      window.linkModeState.isCmdPressed = true;
    } else if (!isMac && event.ctrlKey) {
      window.linkModeState.isCtrlPressed = true;
    }

    const cmdStateChanged =
      wasCmdPressed !== window.linkModeState.isCmdPressed ||
      wasCtrlPressed !== window.linkModeState.isCtrlPressed;
    if (cmdStateChanged) {
      if (window.linkModeState.isCmdPressed || window.linkModeState.isCtrlPressed) {
        document.body.classList.add('cmd-mode');
      }
    }
  }

  function handleKeyUp(event: KeyboardEvent): void {
    const isMac = navigator.platform.indexOf("Mac") > -1;
    const wasCmdPressed = window.linkModeState.isCmdPressed;
    const wasCtrlPressed = window.linkModeState.isCtrlPressed;

    if (isMac && !event.metaKey) {
      window.linkModeState.isCmdPressed = false;
    } else if (!isMac && !event.ctrlKey) {
      window.linkModeState.isCtrlPressed = false;
    }

    const cmdStateChanged =
      wasCmdPressed !== window.linkModeState.isCmdPressed ||
      wasCtrlPressed !== window.linkModeState.isCtrlPressed;
    if (cmdStateChanged) {
      if (!window.linkModeState.isCmdPressed && !window.linkModeState.isCtrlPressed) {
        document.body.classList.remove('cmd-mode');
      }
    }
  }

  document.addEventListener("keydown", handleKeyDown);
  document.addEventListener("keyup", handleKeyUp);

    // TabManager is ready - extension will send commands to create terminals

    // Initialize drag and drop handler
    const dragDropHandler = new DragDropHandler(vscode, tabManager);
    // Make it globally accessible for debugging
    window.dragDropHandler = dragDropHandler;

    // Initialize drag-drop capture
    dragDropHandler.initialize();
}
