/**
 * Centralized constants for Alterminal
 *
 * Extracted from hard-coded values throughout the codebase
 * to improve maintainability and configurability.
 */

// Terminal Configuration
export const TERMINAL_DEFAULTS = {
  FONT_SIZE: 14,
  SCROLLBACK: 1000,
  PTY_COLS: 80,
  PTY_ROWS: 30,
  TERM_TYPE: "xterm-256color",
  COLOR_TERM: "truecolor",
} as const;

// Polling Intervals (milliseconds)
export const INTERVALS = {
  PROCESS_MONITORING: 1000,
} as const;

// Limits
export const LIMITS = {
  MAX_SAVED_COMMANDS: 25,
  MAX_TEMPLATE_NESTING_DEPTH: 50,
  PERF_SAMPLE_SIZE: 4,
  BUFFER_REQUEST_TIMEOUT: 5000,
} as const;

// Terminal Reset Sequences
export const TERMINAL_SEQUENCES = {
  RESET_ALL_ATTRIBUTES: '\x1b[0m',
  SHOW_CURSOR: '\x1b[?25h',
  RESET_CURSOR_STYLE: '\x1b[0 q',
  DISABLE_ALTERNATE_BUFFER: '\x1b[?1049l',
  RESET_SCROLL_REGION: '\x1b[r',
  MOVE_CURSOR_HOME: '\x1b[H',
  CLEAR_SCREEN: '\x1b[2J',
  CLEAR_SCROLLBACK: '\x1b[3J',
} as const;

// VS Code Keyboard Shortcuts (pass-through to VS Code)
export const VSCODE_SHORTCUTS = [
  { key: "F5", ctrlKey: false, shiftKey: false, altKey: false },
  { key: "F1", ctrlKey: false, shiftKey: false, altKey: false },
  { key: "p", ctrlKey: true, shiftKey: true, altKey: false },
  { key: "k", ctrlKey: true, shiftKey: false, altKey: false },
  { key: "w", ctrlKey: true, shiftKey: false, altKey: false },
  { key: "t", ctrlKey: true, shiftKey: false, altKey: false },
  { key: "n", ctrlKey: true, shiftKey: false, altKey: false },
  { key: "o", ctrlKey: true, shiftKey: false, altKey: false },
  { key: "s", ctrlKey: true, shiftKey: false, altKey: false },
  { key: "f", ctrlKey: true, shiftKey: false, altKey: false },
  { key: "h", ctrlKey: true, shiftKey: false, altKey: false },
  { key: "g", ctrlKey: true, shiftKey: false, altKey: false },
  { key: "b", ctrlKey: true, shiftKey: false, altKey: false },
  { key: "`", ctrlKey: true, shiftKey: false, altKey: false },
  { key: "j", ctrlKey: true, shiftKey: false, altKey: false },
  { key: ",", ctrlKey: true, shiftKey: false, altKey: false },
  { key: "Tab", ctrlKey: true, shiftKey: false, altKey: false },
  { key: "Tab", ctrlKey: true, shiftKey: true, altKey: false },
  { key: "PageUp", ctrlKey: true, shiftKey: false, altKey: false },
] as const;
